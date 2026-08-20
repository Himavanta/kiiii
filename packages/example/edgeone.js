// EdgeOne 边缘函数入口示例：
// 边缘函数只接受粘贴的单文件代码（无依赖安装步骤），
// 运行 pnpm build:edgeone 将本文件与 dist/server/index.js 及 h3 打包为
// 零依赖单文件 dist/server/edgeone.js，粘贴到 EdgeOne 控制台函数代码即可。
// 触发规则绑定 URL 路径前缀 /kiiii/——静态资源（dist/public）由站点源站服务，
// 函数只处理远程调用。
import { toWebHandler } from "h3";
import app from "./dist/server/index.js";

const handler = toWebHandler(app);

addEventListener("fetch", (event) => {
  event.respondWith(handler(event.request));
});
