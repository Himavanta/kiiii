// EdgeOne 边缘函数构建配置：
// 把 edgeone.js 与 dist/server/index.js 及 h3 打包为零依赖单文件
// （EdgeOne 控制台只接受粘贴的单文件代码——无依赖安装步骤）。
// h3 经 workerd 条件解析到 web 版（与 Cloudflare 验证路径一致）。
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  resolve: {
    conditions: ["workerd", "module", "browser", "import"],
  },
  build: {
    lib: {
      entry: "edgeone.js",
      formats: ["es"],
      fileName: "edgeone",
    },
    outDir: "dist/server",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
