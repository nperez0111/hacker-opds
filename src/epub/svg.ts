import type { ResvgRenderOptions } from "@resvg/resvg-js";

// Remote SVG filters can panic inside resvg's native addon. A Rust abort is
// not a JavaScript exception: neither try/catch nor a worker thread protects
// the server. Keep that native code in a disposable OS process instead.
const SVG_WORKER = `
const { Resvg } = await import(process.argv[1]);
const { svg, options } = await new Response(Bun.stdin.stream()).json();
const renderer = new Resvg(svg, options);
if (renderer.width * renderer.height > 16000000) throw new Error("SVG exceeds pixel limit");
await Bun.write(Bun.stdout, renderer.render().asPng());
`;

/** Run a disposable rasterizer, bounding both execution time and output. */
export async function runRasterizer(
  command: string[],
  input: Uint8Array,
  timeoutMs = 15000,
  maxOutputBytes = 64 * 1024 * 1024,
): Promise<Uint8Array<ArrayBuffer>> {
  const child = Bun.spawn(command, {
    stdin: input,
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = child.stdout.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxOutputBytes) throw new Error("SVG rasterizer output exceeds limit");
      chunks.push(chunk);
    }
    const code = await child.exited;
    if (code !== 0 || child.signalCode) {
      throw new Error(`SVG rasterizer failed (${child.signalCode || code})`);
    }
    if (!size) throw new Error("SVG rasterizer produced no image");
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

export function rasterizeSvg(svg: string, options: ResvgRenderOptions): Promise<Uint8Array<ArrayBuffer>> {
  // Resolve in the parent, not relative to the subprocess cwd: the production
  // bundle ships this dependency inside .output/server/node_modules.
  return runRasterizer(
    [process.execPath, "--eval", SVG_WORKER, import.meta.resolve("@resvg/resvg-js")],
    new TextEncoder().encode(JSON.stringify({ svg, options })),
  );
}
