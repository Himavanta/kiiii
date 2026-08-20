// EdgeOne 边缘函数入口打包脚本：
// vite JS API 把 edgeone.js 与 dist/server/index.js 及 h3 打包为
// 零依赖单文件 dist/server/edgeone.js（EdgeOne 控制台只接受粘贴的单文件代码）。
// 配置见 vite.edgeone.config.mjs（h3 经 workerd 条件解析到 web 版）。
import { build } from "vite";

await build({ configFile: "vite.edgeone.config.mjs" });
