// 静态资源服务（自托管专用，node 专属）——仅 startServer 动态加载，
// 平台部署（kiiii:app 无状态入口）不引入本模块，保证跨运行时纯化。
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { defineEventHandler, serveStatic } from "h3";
import type { H3 } from "h3";

/** 极简 MIME 表（覆盖 Vite 产物常见类型） */
const MIME: Record<string, string> = {
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

function mimeFromExt(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot >= 0
    ? (MIME[file.slice(dot)] ?? "application/octet-stream")
    : "application/octet-stream";
}

/**
 * serveStatic 的 fs 后端。staticBase 为静态资源目录的 file: URL。
 * id 以 "/" 开头（如 /assets/index.js），去掉前导斜杠后相对 staticBase 解析，
 * 否则 new URL 会把它当根绝对路径（file:///assets/...）导致 stat 失败。
 * id 保持 percent-encoded（安全要求见 h3 文档，不得解码）。
 */
function staticBackend(staticBase: URL) {
  const resolve = (id: string) => new URL(id.replace(/^\//, ""), staticBase);
  return {
    fallthrough: true,
    getMeta: async (id: string) => {
      try {
        const info = await stat(resolve(id));
        if (!info.isFile()) return undefined;
        return {
          type: mimeFromExt(id),
          size: info.size,
          mtime: info.mtime,
          // 弱 etag（size + mtime 派生），serveStatic 据此处理 If-None-Match → 304
          etag: `W/"${info.size}-${info.mtimeMs}"`,
        };
      } catch {
        return undefined;
      }
    },
    getContents: async (id: string) => {
      try {
        return await readFile(resolve(id));
      } catch {
        return null;
      }
    },
  };
}

/**
 * 把静态资源 + SPA fallback 挂到 app（自托管专用）。
 * 顺序：调用方先注册 RPC（/{prefix}/**），静态其次，fallback 最后。
 */
export function mountStatic(app: H3, staticDir: string | URL): void {
  // 静态资源基址（file: URL）：必须保证以 "/" 结尾，
  // 否则 new URL(相对, base) 相对解析把无尾斜杠的 base 末段当文件名
  const staticRaw = staticDir instanceof URL ? staticDir.href : pathToFileURL(staticDir).href;
  const staticBase = new URL(staticRaw.endsWith("/") ? staticRaw : `${staticRaw}/`);

  app.use(
    "/**",
    defineEventHandler((event) => serveStatic(event, staticBackend(staticBase))),
  );

  // SPA fallback：history 路由的未命中路径 → index.html
  app.use(
    "/**",
    defineEventHandler(async (event) => {
      event.res.headers.set("content-type", "text/html; charset=utf-8");
      return await readFile(new URL("index.html", staticBase), "utf-8");
    }),
  );
}
