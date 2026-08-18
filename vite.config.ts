import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: [
    {
      entry: ["src/index.ts", "src/server.ts", "src/error.ts"],
      dts: true,
      exports: true,
      platform: "node",
      fixedExtension: false,
    },
    {
      entry: "src/client.ts",
      dts: true,
      exports: true,
      platform: "neutral",
    },
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
