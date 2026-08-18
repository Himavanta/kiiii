import { defineConfig } from "vite-plus";
import { rpc } from "kiiii";

export default defineConfig({
  plugins: [rpc({ pattern: "/src/**/*.server.ts" })],
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
