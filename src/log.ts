/**
 * Structured logging.
 *
 * Two deliberate choices, both learned the hard way:
 *
 * 1. **Never `pino({ transport })`.** A transport spawns a worker thread that
 *    resolves its own entry point by file path. That path does not survive
 *    bundling, so the Nitro output dies with `ModuleNotFound .../worker.js` and
 *    then hangs for ten seconds in `_flushSync` on exit. Pretty printing is
 *    therefore wired up as a plain destination stream instead, which is
 *    synchronous, bundler-safe, and behaves identically.
 *
 * 2. **Lazy construction.** The logger reads `config()`, and config is only
 *    resolvable once the runtime is up. Building at import time would freeze in
 *    whatever defaults happened to be live, and would break `setConfigForTests`.
 */
import pino, { type Logger } from "pino";
import PinoPretty from "pino-pretty";
import { config } from "~/config";

let root: Logger | undefined;
const children = new Map<string, Logger>();

function build(): Logger {
  const cfg = config();
  const options = {
    // Test runs are silent unless LOG_LEVEL is set explicitly. A passing
    // suite that prints build chatter buries the assertion failures that
    // actually matter, and several tests exercise error paths on purpose.
    level:
      process.env.NODE_ENV === "test" && !process.env.LOG_LEVEL
        ? "silent"
        : cfg.logLevel,
    base: undefined, // drop pid/hostname; noise for a single-container app
  };

  if (!cfg.logPretty) return pino(options);

  return pino(
    options,
    PinoPretty({
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    }),
  );
}

/**
 * Logger for a subsystem, e.g. `log("build")`.
 *
 * Children are memoised so call sites can invoke this inline without
 * allocating a logger per call.
 */
export function log(mod?: string): Logger {
  root ??= build();
  if (!mod) return root;

  let child = children.get(mod);
  if (!child) {
    child = root.child({ mod });
    children.set(mod, child);
  }
  return child;
}

/** Drops the memoised loggers so a later `log()` re-reads config. */
export function resetLoggerForTests(): void {
  root = undefined;
  children.clear();
}

/**
 * Normalises a thrown value into something worth putting in a log line.
 *
 * `fetch` rejections in particular carry the useful detail on `cause`, and a
 * bare `String(err)` throws that away - which is exactly how a story build
 * failed with an unexplained "The operation timed out."
 */
export function errFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { err: String(error) };

  const fields: Record<string, unknown> = {
    err: { name: error.name, message: error.message, stack: error.stack },
  };
  if (error.cause !== undefined) {
    const cause = error.cause;
    fields.cause = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }
  // Our own error types carry a machine-readable discriminator.
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") fields.code = code;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") fields.status = status;

  return fields;
}
