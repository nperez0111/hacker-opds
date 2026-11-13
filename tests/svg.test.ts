import { describe, expect, test } from "bun:test";
import { rasterizeSvg, runRasterizer } from "../src/epub/svg";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
const options = { font: { loadSystemFonts: false } };
const command = (script: string) => [process.execPath, "--eval", script];
const empty = new Uint8Array();

describe("isolated SVG rasterization", () => {
  test("renders a real PNG", async () => {
    const out = await rasterizeSvg(svg, options);
    expect(Array.from(out.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(await new Bun.Image(out).metadata()).toMatchObject({ width: 20, height: 10 });
  });

  test("a native-style process death rejects without taking down the parent", async () => {
    await expect(runRasterizer(command('process.kill(process.pid, "SIGKILL")'), empty)).rejects.toThrow("SVG rasterizer failed");
    // Subsequent images can still be rendered after a crashed child.
    expect((await rasterizeSvg(svg, options)).length).toBeGreaterThan(0);
  });

  test("nonzero exit and empty output reject", async () => {
    await expect(runRasterizer(command("process.exit(1)"), empty)).rejects.toThrow("SVG rasterizer failed");
    await expect(runRasterizer(command("process.exit(0)"), empty)).rejects.toThrow("no image");
  });

  test("hung native work is killed", async () => {
    await expect(runRasterizer(command("while (true) {}"), empty, 200)).rejects.toThrow("SVG rasterizer failed");
  });

  test("output is bounded", async () => {
    await expect(runRasterizer(command('await Bun.write(Bun.stdout, "too much output")'), empty, 5000, 4)).rejects.toThrow("output exceeds limit");
  });

  test("invalid SVG and excessive dimensions fail safely", async () => {
    await expect(rasterizeSvg("not an svg", options)).rejects.toThrow("SVG rasterizer failed");
    await expect(rasterizeSvg(svg.replace('height="10"', 'height="1000000"'), options)).rejects.toThrow("SVG rasterizer failed");
  });
});
