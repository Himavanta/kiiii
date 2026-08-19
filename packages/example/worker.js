// Cloudflare Workers 平台入口示例：
// 构建（vp build）后 dist/server/index.js 是无状态 app（依赖链零 node 引用，已实测），
// 本文件把 app 包装为 Web 标准 fetch handler 交给 Workers 运行时。
import { toWebHandler } from "h3";
import app from "./dist/server/index.js";

export default {
  fetch: toWebHandler(app),
};
