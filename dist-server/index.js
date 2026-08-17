import { n as createRpcHandler, r as fromGlob } from "./assets/server-BlrjEieV.js";
import { H3, defineEventHandler, serveStatic } from "h3";
import { toNodeHandler } from "h3/node";
import { listen } from "listhen";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
//#region server/index.ts
/**
 * 生产服务器入口（Vite SSR 构建打包，见 package.json 的 build:server）。
 *
 * 组合（同一端口、同一个 app）：
 * 1. RPC 端点：import.meta.glob 由 Vite 构建时静态分析，把所有 .server.ts
 *    打进服务器 bundle（T4 方案）；请求时 lazy 加载分发
 * 2. 静态资源：dist/（客户端构建产物），h3 serveStatic + fs 后端
 *    （etag/304/range/压缩由 serveStatic 与 srvx 处理）
 * 3. SPA fallback：静态未命中 → 返回 dist/index.html（history 路由）
 */
var distDir = resolve(process.cwd(), "dist");
/** serveStatic 的 fs 后端：id 是不透明路径（保持编码），安全要求见 h3 文档 */
var staticOptions = {
  fallthrough: true,
  getMeta: async (id) => {
    const file = join(distDir, id);
    try {
      const info = await stat(file);
      if (!info.isFile()) return void 0;
      return {
        type: mimeFromExt(file),
        size: info.size,
        mtime: info.mtime,
        etag: `W/"${info.size}-${info.mtimeMs}"`,
      };
    } catch {
      return;
    }
  },
  getContents: async (id) => {
    try {
      return await readFile(join(distDir, id));
    } catch {
      return null;
    }
  },
};
/** 极简 MIME 表（覆盖 Vite 产物常见类型） */
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
function mimeFromExt(file) {
  const dot = file.lastIndexOf(".");
  return dot >= 0
    ? (MIME[file.slice(dot)] ?? "application/octet-stream")
    : "application/octet-stream";
}
/** 1. RPC：.server.ts 在构建时全部打包，请求时 lazy 加载 */
var app = new H3();
app.use(
  "/rpc/**",
  createRpcHandler({
    modules: fromGlob(
      /* #__PURE__ */ Object.assign({
        "/src/api/greet.server.ts": () => import("./assets/greet.server-DjEvGmPy.js"),
      }),
    ),
  }),
);
/** 2. 静态资源（dist/） */
app.use(
  "/**",
  defineEventHandler((event) => serveStatic(event, staticOptions)),
);
/** 3. SPA fallback：history 路由的未命中路径 → index.html */
app.use(
  "/**",
  defineEventHandler(async () => {
    return await readFile(join(distDir, "index.html"), "utf-8");
  }),
);
var port = Number(process.env.PORT ?? 3e3);
await listen(toNodeHandler(app), {
  port,
  hostname: "0.0.0.0",
});
//#endregion
export {};
