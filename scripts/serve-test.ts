/**
 * Ephemeral-port server harness.
 *
 * Boots the real application on a free port, waits until it is genuinely
 * accepting connections, hands the base URL to a callback, and tears the
 * process tree down again.
 *
 * Three things about this stack forced the shape of this module, all of them
 * discovered the hard way rather than assumed:
 *
 *  1. `bun --bun vite` is a *parent* process. The socket is actually held by a
 *     grandchild (`node_modules/.bin/vite`). Killing only the direct child can
 *     therefore leave the port bound, so the child is spawned `detached` (which
 *     calls setsid) and signalled as a whole process group via `kill(-pid)`.
 *
 *  2. Vite binds `[::1]` by default, so a base URL of `http://127.0.0.1:PORT`
 *     is refused even though the server is up. The host is pinned explicitly
 *     with `--host` so the advertised URL and the listening socket agree.
 *
 *  3. The port is chosen *before* spawning rather than scraped from stdout.
 *     Scraping is racy and, more importantly, the port has to be known up front
 *     so `PUBLIC_BASE_URL` can be set to the URL the server will actually be
 *     reached on. That env var is what keeps generated feed hrefs same-origin,
 *     which is precisely what the OPDS probe asserts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** `dev` runs the vite dev server; `build` runs a compiled `.output` bundle. */
export type ServerMode = "dev" | "build";

export interface ServeOptions {
  /**
   * Which server to boot. `dev` is the default: it starts in well under a
   * second, whereas `build` has to produce `.output` first.
   */
  mode?: ServerMode;
  /** Project root. Defaults to the repository root inferred from this file. */
  cwd?: string;
  /** Extra environment for the child process. */
  env?: Record<string, string | undefined>;
  /**
   * Value for `PUBLIC_BASE_URL`.
   *
   * Defaults to the harness's own base URL, which is the correct production
   * configuration. Pass an explicit foreign origin to reproduce the
   * cross-origin catalogue bug, or `null` to leave the application default
   * (`http://localhost:8080`) in place.
   */
  publicBaseUrl?: string | null;
  /** Interface to bind. Pinned to IPv4 loopback so the URL is unambiguous. */
  host?: string;
  /** How long to wait for the server to accept a request. */
  readyTimeoutMs?: number;
  /** Mirror child stdout/stderr onto this process's streams. */
  verbose?: boolean;
}

export interface ServerHandle {
  /** Origin the server is reachable on, with no trailing slash. */
  baseUrl: string;
  port: number;
  mode: ServerMode;
  /** Everything the child has written to stdout/stderr so far. */
  output(): string;
  /** Idempotent. Safe to call more than once. */
  stop(): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

/** Handles that still need tearing down if the process dies unexpectedly. */
const live = new Set<{ child: ChildProcess }>();
let hooksInstalled = false;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Negative pid targets the whole process group, which is the only way to
    // reach the grandchild that actually owns the listening socket.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Installed once. `exit` handlers must be synchronous, so the last resort is an
 * unconditional SIGKILL of every group we started.
 */
function installCleanupHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const reap = (): void => {
    for (const entry of live) killGroup(entry.child, "SIGKILL");
    live.clear();
  };

  // Covers normal exit and termination via an uncaught exception, both of
  // which run `exit` handlers. Must stay synchronous.
  process.on("exit", reap);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      reap();
      // Detach before re-raising, otherwise this handler simply runs again and
      // the process spins forever instead of terminating. With ours gone the
      // default disposition applies, unless the embedding program installed its
      // own handler - in which case that one gets to decide what happens.
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

/**
 * Ask the kernel for a free port and immediately give it back.
 *
 * There is an unavoidable race between closing this socket and the child
 * binding it, which is why the child runs with `--strictPort`: a collision then
 * surfaces as a loud startup failure instead of the server quietly moving to a
 * different port than the one we advertise.
 */
function findFreePort(host: string): Promise<number> {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.on("error", rej);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        rej(new Error("could not determine an ephemeral port"));
        return;
      }
      const { port } = address;
      probe.close(() => res(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the server answers. Any HTTP status counts as ready - we are
 * testing that the socket is live, not that the route works.
 */
async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})\n${output()}`,
      );
    }
    try {
      await fetch(`${baseUrl}/opds`, { signal: AbortSignal.timeout(10_000) });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(100);
  }

  throw new Error(
    `server at ${baseUrl} was not ready within ${timeoutMs}ms (last error: ${lastError})\n${output()}`,
  );
}

/** Runs `vite build` once so `build` mode has something to serve. */
async function ensureBuilt(cwd: string, verbose: boolean): Promise<void> {
  if (existsSync(join(cwd, ".output", "server", "index.mjs"))) return;

  await new Promise<void>((res, rej) => {
    const proc = spawn("bunx", ["vite", "build"], {
      cwd,
      stdio: verbose ? "inherit" : "ignore",
      env: process.env,
    });
    proc.on("error", rej);
    proc.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`vite build failed with code ${code}`)),
    );
  });
}

/**
 * Boot a server on an ephemeral port. The caller owns the returned handle and
 * must call `stop()`; `withServer` does that automatically.
 */
export async function startServer(options: ServeOptions = {}): Promise<ServerHandle> {
  const {
    mode = "dev",
    cwd = PROJECT_ROOT,
    env = {},
    host = "127.0.0.1",
    readyTimeoutMs = 60_000,
    verbose = false,
  } = options;

  installCleanupHooks();

  if (mode === "build") await ensureBuilt(cwd, verbose);

  const port = await findFreePort(host);
  const baseUrl = `http://${host}:${port}`;
  const publicBaseUrl =
    options.publicBaseUrl === undefined ? baseUrl : options.publicBaseUrl;

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  Object.assign(childEnv, {
    PORT: String(port),
    HOST: host,
    NITRO_PORT: String(port),
    NITRO_HOST: host,
  });
  if (publicBaseUrl !== null) childEnv.PUBLIC_BASE_URL = publicBaseUrl;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const [command, args] =
    mode === "dev"
      ? // `--bun` is mandatory: under Node's ESM loader the app cannot import
        // `bun:sqlite` and the dev server dies on the first request.
        (["bun", ["--bun", "vite", "--port", String(port), "--strictPort", "--host", host]] as const)
      : (["bun", ["run", join(".output", "server", "index.mjs")]] as const);

  const child = spawn(command, [...args], {
    cwd,
    env: childEnv,
    // setsid, so the whole tree can be signalled as one group later.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: string[] = [];
  const capture = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream): void => {
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      chunks.push(text);
      if (verbose) sink.write(text);
    });
  };
  capture(child.stdout, process.stdout);
  capture(child.stderr, process.stderr);

  const output = (): string => chunks.join("");
  const entry = { child };
  live.add(entry);

  const exited = new Promise<void>((res) => child.on("exit", () => res()));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    live.delete(entry);

    killGroup(child, "SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      sleep(5_000).then(() => true),
    ]);
    if (timedOut) {
      killGroup(child, "SIGKILL");
      await Promise.race([exited, sleep(2_000)]);
    }
  };

  try {
    await waitForReady(baseUrl, child, readyTimeoutMs, output);
  } catch (err) {
    await stop();
    throw err;
  }

  return { baseUrl, port, mode, output, stop };
}

/**
 * Run `fn` against a freshly booted server and always shut it down again, even
 * if `fn` throws.
 */
export async function withServer<T>(
  fn: (baseUrl: string) => Promise<T>,
  options: ServeOptions = {},
): Promise<T> {
  const server = await startServer(options);
  try {
    return await fn(server.baseUrl);
  } finally {
    await server.stop();
  }
}

/** `bun run scripts/serve-test.ts` - boots a server and holds it until Ctrl-C. */
if (import.meta.main) {
  const wantsBuild = process.argv.includes("--build");
  const server = await startServer({
    mode: wantsBuild ? "build" : "dev",
    verbose: process.argv.includes("--verbose"),
  });
  process.stdout.write(`listening on ${server.baseUrl} (mode=${server.mode})\n`);
  process.stdout.write("press Ctrl-C to stop\n");
  await new Promise<void>((res) => process.on("SIGINT", () => res()));
  await server.stop();
}
