import { defineConfig, type Plugin } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

/* workerd's node:module createRequire() ignores its argument and still returns a
   working require, but Rolldown's CJS interop shim calls it with `import.meta.url`
   — undefined in Workers modules — and the ESM-shim path throws at instantiation.
   Rewrite exactly that one call so the shim initializes on both runtimes. */
function workersCreateRequireShim(): Plugin {
  return {
    name: "tirbeo:workers-create-require-shim",
    enforce: "post",
    transform(code, id, options) {
      if (options?.ssr === false) return null;
      if (!code.includes("createRequire(import.meta.url)")) return null;
      return {
        code: code.replaceAll("createRequire(import.meta.url)", "createRequire('file:///index.js')"),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
    workersCreateRequireShim(),
  ],
});
