import { H3, defineEventHandler, serveStatic } from "h3";
import { toNodeHandler } from "h3/node";
import { listen } from "listhen";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRpcHandler, fromGlob } from "../src/rpc/server";

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

const distDir = resolve(process.cwd(), "dist");

/** serveStatic 的 fs 后端：id 是不透明路径（保持编码），安全要求见 h3 文档 */
const staticOptions = {
  fallthrough: true,
  getMeta: async (id: string) => {
    const file = join(distDir, id);
    try {
      const info = await stat(file);
      if (!info.isFile()) return undefined;
      return {
        type: mimeFromExt(file),
        size: info.size,
        mtime: info.mtime,
        // 弱 etag（size + mtime 派生），serveStatic 会据此处理 If-None-Match → 304
        etag: `W/"${info.size}-${info.mtimeMs}"`,
      };
    } catch {
      return undefined;
    }
  },
  getContents: async (id: string) => {
    try {
      return await readFile(join(distDir, id));
    } catch {
      return null;
    }
  },
};

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

/** 1. RPC：.server.ts 在构建时全部打包，请求时 lazy 加载 */
const app = new H3();
app.use(
  "/rpc/**",
  createRpcHandler({
    // import.meta.glob 的类型推断是 unknown 联合，断言为模块加载器形态
    modules: fromGlob(
      import.meta.glob("/src/**/*.server.ts") as Record<
        string,
        () => Promise<{ default: unknown }>
      >,
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
    const html = await readFile(join(distDir, "index.html"), "utf-8");
    return html;
  }),
);

const port = Number(process.env.PORT ?? 3000);
// listhen 的官方对接路径是 node handler（直接传 h3 app 会挂起——H3 对象
// 的 handler 是事件形态，listhen 无法识别）
await listen(toNodeHandler(app), { port, hostname: "0.0.0.0" });
