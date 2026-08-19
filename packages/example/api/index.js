// Vercel Node Functions 平台入口示例：
// 构建（vp build）后 dist/server/index.js 是无状态 app（只处理远程调用），
// 平台负责静态资源与 history 回退——本文件把 app 交给平台运行时。
import { toNodeHandler } from "h3/node";
import app from "../dist/server/index.js";

export default toNodeHandler(app);
