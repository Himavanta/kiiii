import { defineEventHandler, H3, serveStatic } from "h3";
import { HTTPError, toNodeHandler } from "h3/node";
import type { H3Event } from "h3";
import { listen } from "listhen";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "devalue";

/**
 * 业务错误：显式抛出后其 message/code/data 会跨网络到达客户端
 * （200 + 错误信封，客户端 stub 检测后 reject 同构的 Error）
 * 普通 throw 的 Error 属于意外错误，生产环境不泄漏任何细节。
 */
export class RpcError extends Error {
  code?: string;
  data?: unknown;

  constructor(message: string, code?: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * 服务端函数上下文：由分发器通过 `fn.call(context, ...args)` 注入，函数内用 `this` 读取。
 */
export interface RpcContext {
  /** 请求取消信号：连接断开 / 超时 / 客户端取消时触发，函数内可 throwIfAborted 提前退出 */
  signal: AbortSignal;
  /** h3 原始事件：可访问 request / headers / cookies 等 */
  event: H3Event;
}

/**
 * 判断一个错误是否为 RpcError。
 * 用 name 品牌判断而非 instanceof：dev 下插件链（配置加载）与 .server.ts 链
 * （ssrLoadModule）会各自加载一份 server.ts，instanceof 跨模块实例会失效。
 */
export function isRpcError(error: unknown): error is RpcError {
  return error instanceof Error && error.name === "RpcError";
}

/** 路由 → 模块加载器。路由 = 相对扫描根目录的路径（去 .server.ts 后缀），如 "actions/greet" */
export type RpcModuleMap = Record<string, () => Promise<{ default: unknown }>>;

/**
 * 把 import.meta.glob 的结果转换为 RpcModuleMap（生产模式用法）。
 * import.meta.glob 由 Vite 构建时静态分析并打包全部匹配模块。
 *
 * ```ts
 * import { createRpcHandler, fromGlob } from "./rpc/server";
 * const globs = import.meta.glob("/src/**\/*.server.ts");
 * app.use(`/rpc/**`, createRpcHandler({ modules: fromGlob(globs) }));
 * ```
 *
 * @param globs - import.meta.glob 的返回（lazy 加载器表）
 * @param base - 扫描根目录（root 相对路径），默认 "/src/"
 */
export function fromGlob(
  globs: Record<string, () => Promise<{ default: unknown }>>,
  base = "/src/",
): RpcModuleMap {
  const modules: RpcModuleMap = {};
  for (const [key, loader] of Object.entries(globs)) {
    if (!key.startsWith(base) || !key.endsWith(".server.ts")) continue;
    modules[key.slice(base.length, -".server.ts".length)] = loader;
  }
  return modules;
}

export interface RpcHandlerOptions {
  /** 路由 → 模块加载器（dev 由插件注入，prod 由 fromGlob 构造） */
  modules: RpcModuleMap;
  /** URL 前缀，默认 "rpc"（端点形如 /rpc/actions/greet） */
  prefix?: string;
  /** 开发模式：意外错误泄漏 message 便于调试；生产恒 500 通用错误 */
  isDev?: boolean;
}

/**
 * 创建 RPC 分发 handler（h3），dev / prod 共用同一份协议。
 *
 * 协议（见 agent-docs/服务端函数RPC方案.md §4.4）：
 * - POST /{prefix}/{route}，body 为 devalue 编码的位置参数数组
 * - 成功：200 + stringify(result)（纯数据，不包信封）
 * - 业务错误（RpcError）：200 + stringify({ ok: false, name, message, code?, data? })
 * - 传输/协议错误：非 2xx 通用错误体
 */
export function createRpcHandler(options: RpcHandlerOptions) {
  const { modules } = options;
  const prefix = options.prefix ?? "rpc";
  const isDev = options.isDev ?? false;

  return defineEventHandler(async (event) => {
    // 方法限制（协议层）
    if (event.method !== "POST") {
      throw new HTTPError("Method Not Allowed", { status: 405 });
    }

    // 路由解析：/rpc/actions/greet → route = "actions/greet"
    if (!event.path.startsWith(`/${prefix}/`)) {
      throw new HTTPError("Not Found", { status: 404 });
    }
    const route = event.path.slice(prefix.length + 2);
    // 路径消毒：拒绝空段 / 穿越段（URL 段只作为模块表的 key，不做文件系统拼接）
    if (
      !route ||
      route.includes("..") ||
      route.includes("\\") ||
      route.startsWith("/") ||
      route.endsWith("/")
    ) {
      throw new HTTPError("Not Found", { status: 404 });
    }
    const loader = modules[route];
    if (!loader) {
      throw new HTTPError("Not Found", { status: 404 });
    }

    // 取消链路：客户端断开 → abort → this.signal（函数内 throwIfAborted 提前退出）
    // 注意：监听 res 的 close（连接在响应结束前关闭才触发），不能监听 req 的 close——
    // IncomingMessage 的 close 在请求正常完成后也会触发，会把进行中的调用误中止
    const controller = new AbortController();
    const res = event.runtime?.node?.res;
    if (res) {
      res.on("close", () => controller.abort());
    }

    // 解析参数（devalue 编码的位置参数数组）
    // readRawBody 在 h3 2.0 已弃用，直接用标准 Request 的 text()（无 body 时返回空串）
    const raw = await event.req.text();
    let args: unknown[] = [];
    if (raw) {
      try {
        const parsed: unknown = parse(raw);
        if (!Array.isArray(parsed)) {
          throw new HTTPError("Bad Request", { status: 400 });
        }
        args = parsed;
      } catch (error) {
        // HTTPError.isError 跨上下文安全（按 constructor name 判断），与 isRpcError 同理
        if (HTTPError.isError(error)) throw error;
        throw new HTTPError("Bad Request", { status: 400, cause: error });
      }
    }

    const mod = await loader();
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new HTTPError("Internal Server Error", { status: 500 });
    }

    // 分发：context 经 this 注入，参数按位置展开（与函数声明完全一致）
    const context: RpcContext = { signal: controller.signal, event };
    try {
      const result = await fn.call(context, ...args);
      return stringify(result);
    } catch (error) {
      if (isRpcError(error)) {
        // 业务错误：开发者显式声明的错误，message/code/data 是产品的一部分（生产也传）
        // 200 是默认状态码，无需 setResponseStatus（该 API 在 h3 2.0 已弃用）
        return stringify({
          ok: false,
          name: "RpcError",
          message: error.message,
          code: error.code,
          data: error.data,
        });
      }
      // 意外错误：不泄漏堆栈 / 路径 / 消息
      console.error(`[fly-rpc] ${route} 执行失败:`, error);
      if (isDev) {
        return stringify({
          ok: false,
          name: "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw new HTTPError("Internal Server Error", { status: 500 });
    }
  });
}

// ==================== 服务器入口封装（createRpcServer） ====================
// 用户项目里的显式服务器入口（如 server/index.ts）只需几行：
//
// ```ts
// import { createRpcServer, fromGlob } from "fly-rpc/server";
// await createRpcServer({
//   prefix: "rpc",
//   modules: fromGlob(import.meta.glob("/src/**/*.server.ts")),
// });
// ```

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

export interface RpcServerOptions {
  /** 路由 → 模块加载器（生产用法：fromGlob(import.meta.glob("/src/**\/*.server.ts"))） */
  modules: RpcModuleMap;
  /** URL 前缀，默认 "rpc"（端点形如 /rpc/actions/greet） */
  prefix?: string;
  /**
   * 静态资源目录。默认约定：{项目根}/dist/client（服务器从项目根启动，
   * 产物 dist/client 与 dist/server 并列）。需自定义时传绝对路径或 file: URL
   */
  staticDir?: string | URL;
  /** 监听端口，默认 process.env.PORT ?? 3000 */
  port?: number;
  /** 开发模式：意外错误泄漏 message 便于调试，默认 false */
  isDev?: boolean;
}

/**
 * 创建并启动生产服务器（RPC + 静态资源 + SPA fallback + listhen 监听，单端口）。
 *
 * 用户项目里的显式入口（如 server/index.ts）调用本函数，全部内部逻辑（h3 app 组装、
 * 静态服务、history 路由 fallback、监听）由插件封装，入口只写配置。
 *
 * 构建命令（与客户端构建并列）：`vp build --ssr server/index.ts --outDir dist/server`
 */
export async function createRpcServer(options: RpcServerOptions) {
  const prefix = options.prefix ?? "rpc";
  const isDev = options.isDev ?? false;
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  // 静态资源基址（file: URL）：默认约定 {项目根}/dist/client；自定义时接受绝对路径或 URL。
  // 必须保证以 "/" 结尾：new URL(相对, base) 相对解析把无尾斜杠的 base 末段当文件名
  const staticDir = options.staticDir ?? join(process.cwd(), "dist", "client");
  const staticRaw = staticDir instanceof URL ? staticDir.href : pathToFileURL(staticDir).href;
  const staticBase = new URL(staticRaw.endsWith("/") ? staticRaw : `${staticRaw}/`);

  // 1. RPC：.server.ts 构建时全部打包（import.meta.glob），请求时 lazy 加载分发
  const app = new H3();
  app.use(`/${prefix}/**`, createRpcHandler({ modules: options.modules, prefix, isDev }));

  // 2. 静态资源（{打包根}/client）
  app.use(
    "/**",
    defineEventHandler((event) => serveStatic(event, staticBackend(staticBase))),
  );

  // 3. SPA fallback：history 路由的未命中路径 → index.html
  app.use(
    "/**",
    defineEventHandler(async (event) => {
      event.res.headers.set("content-type", "text/html; charset=utf-8");
      return await readFile(new URL("index.html", staticBase), "utf-8");
    }),
  );

  await listen(toNodeHandler(app), { port, hostname: "0.0.0.0" });
  return app;
}
