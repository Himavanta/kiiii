import { defineConfig } from "vite-plus";
import { kiiii } from "kiiii";

export default defineConfig({
  plugins: [kiiii({ pattern: "/src/**/*.server.ts", timeout: 5_000 })], // timeout: 5s 演示全局超时
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
