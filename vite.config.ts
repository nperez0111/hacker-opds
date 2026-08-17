import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { nitro } from "nitro/vite";

/**
 * Packages that must stay a runtime `import`, never a bundled one.
 *
 * `@resvg/resvg-js` is a JS shim whose only job is to `require()` a sibling
 * package (`@resvg/resvg-js-<platform>`) whose `main` is a compiled `.node`
 * binary. Rollup has no loader for Mach-O/ELF, so following that require kills
 * the production build with "Unexpected character" while parsing the binary as
 * JavaScript.
 *
 * Nitro's own externals plugin is supposed to handle exactly this, and
 * `traceDeps` does select the package, but its externalisation path calls
 * `resolveModulePath` on the resolved specifier and bails back to inlining
 * when that fails - which it does here, because the package has no `exports`
 * map and its `main` is a `.node` file. So the decision is made here instead,
 * before Nitro's plugin sees the id.
 *
 * `@mixmark-io/domino` is turndown's server-side HTML parser. Turndown reaches
 * it through a bare `require()` nested inside a function, which Rollup emits
 * verbatim instead of hoisting into an import - so the specifier survives into
 * the bundle without ever being declared as a dependency of it, and Nitro's
 * dependency tracer never learns it needs copying. Nothing fails at build time.
 * It fails on the first request that touches turndown, which is any story page,
 * any RSS render and any EPUB build, with `Cannot find module`. Declaring it
 * external turns that invisible runtime require into a real edge in the module
 * graph, which is what makes it get traced and copied.
 *
 * Being external does not mean being absent: Nitro traces each of these into
 * `.output/server/node_modules`, so the build artefact stays self-contained and
 * neither the Dockerfile nor `bun run start` needs to arrange anything. What is
 * lost is portability across platforms, which for a native addon was never
 * available in the first place.
 */
const RUNTIME_EXTERNALS = ["@resvg/resvg-js", "turndown"];

function externalRuntimeDeps(): Plugin {
  return {
    name: "hacker-opds:external-runtime-deps",
    enforce: "pre",
    apply: "build",
    resolveId(id) {
      const bare = RUNTIME_EXTERNALS.some(
        (pkg) => id === pkg || id.startsWith(pkg + "/"),
      );
      // `.node` is caught separately as a backstop: any addon that reaches the
      // graph by some other route is still unparseable, and failing to
      // externalise it is always a build error rather than a subtle one.
      if (bare || id.endsWith(".node")) return { id, external: true };
      return null;
    },
  };
}

export default defineConfig({
  plugins: [externalRuntimeDeps(), nitro()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // E-readers reach the dev server over the LAN, so it has to bind beyond
    // loopback (`--host` in the dev script does this) and it has to stop
    // rejecting the Host header those clients send. Vite's host check defends
    // against DNS-rebinding attacks on a developer's machine; this project is
    // a read-only public catalogue with no auth and no browser-held
    // credentials, so there is nothing for a rebinding attack to steal.
    // Production runs the Nitro output, which has no such check anyway.
    allowedHosts: true,
  },
});
