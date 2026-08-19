import { defineEventHandler, H3, HTTPError } from "h3";
import type { H3Event } from "h3";
import { parse, stringify } from "devalue";
import { isFunction } from "./guards.ts";

// server 子路径导出：模块表组装与路由哈希（生成代码 import "kiiii/server" 使用）。
// 错误协议不在 server 导出——跨端公共概念，唯一主来源 kiiii/error
export { buildModuleMap } from "./modules.ts";
export { routeHash } from "./hash.ts";
import { isKiiiiError } from "./error.ts";

/**
 * 服务端函数上下文：由分发器通过 `fn.call(context, ...args)` 注入，函数内用 `this` 读取。
 */
export interface KiiiiContext {
  /** 请求取消信号：连接断开 / 超时 / 客户端取消时触发，函数内可 throwIfAborted 提前退出 */
  signal: AbortSignal;
  /** h3 原始事件：可访问 request / headers / cookies 等 */
  event: H3Event;
}

/** 路由（routeHash）→ 模块加载器 */
export type KiiiiModuleMap = Record<string, () => Promise<{ default: unknown }>>;

export interface KiiiiHandlerOptions {
  /** 路由 → 模块加载器（dev 由插件注入，prod 由模块表虚拟模块提供） */
  modules: KiiiiModuleMap;
  /** URL 前缀，默认 "kiiii"（端点形如 /kiiii/{hash}） */
  prefix?: string;
  /** 开发模式：意外错误泄漏 message 便于调试；生产恒 500 通用错误 */
  isDev?: boolean;
}

/**
 * 创建远程调用分发 handler（h3），dev / prod 共用同一份协议，跨运行时（h3 core + devalue）。
 *
 * 协议（见 agent-docs/服务端函数方案.md §4.4）：
 * - POST /{prefix}/{route}，body 为 devalue 编码的位置参数数组
 * - 成功：200 + stringify(result)（纯数据，不包信封）
 * - 业务错误（KiiiiError）：200 + stringify({ ok: false, name, message, code?, data? })
 * - 传输/协议错误：非 2xx 通用错误体
 */
export function createKiiiiHandler(options: KiiiiHandlerOptions) {
  const { modules } = options;
  const prefix = options.prefix ?? "kiiii";
  const isDev = options.isDev ?? false;

  return defineEventHandler(async (event) => {
    // 方法限制（协议层）
    if (event.req.method !== "POST") {
      throw new HTTPError("Method Not Allowed", { status: 405 });
    }

    // 路由解析：/{prefix}/{route}，route = 前缀之后的部分
    const pathname = event.url.pathname;
    if (!pathname.startsWith(`/${prefix}/`)) {
      throw new HTTPError("Not Found", { status: 404 });
    }
    const route = pathname.slice(prefix.length + 2);
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

    // 取消链路：客户端断开 → abort → this.signal（函数内 throwIfAborted 提前退出）。
    // node：监听 res 的 close（仅连接在响应结束前关闭时触发；req 的 close 在请求正常完成后也会触发）；
    // web：监听请求信号的 abort（h3 推荐的跨运行时方式）
    const controller = new AbortController();
    const nodeRes = event.runtime?.node?.res;
    if (nodeRes) {
      nodeRes.on("close", () => controller.abort());
    } else if (event.req.signal) {
      if (event.req.signal.aborted) controller.abort();
      else event.req.signal.addEventListener("abort", () => controller.abort());
    }

    // 解析参数：devalue 编码的位置参数数组（无 body 时为空数组）
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
        // parse 抛出的 HTTPError 原样透传，其余统一 Bad Request
        if (HTTPError.isError(error)) throw error;
        throw new HTTPError("Bad Request", { status: 400, cause: error });
      }
    }

    const mod = await loader();
    const fn = mod.default;
    if (!isFunction(fn)) {
      throw new HTTPError("Internal Server Error", { status: 500 });
    }

    // 分发：context 经 this 注入，参数按位置展开（与函数声明完全一致）
    const context: KiiiiContext = { signal: controller.signal, event };
    try {
      const result = await fn.call(context, ...args);
      return stringify(result);
    } catch (error) {
      // 取消 / 超时导致的提前退出是预期行为：静默（连接已断开，无需响应、不记日志）
      if (error instanceof Error && error.name === "AbortError") return;
      if (isKiiiiError(error)) {
        // 业务错误：开发者显式声明的错误，message/code/data 是产品的一部分（生产也传），走 200 + 信封
        return stringify({
          ok: false,
          name: "KiiiiError",
          message: error.message,
          code: error.code,
          data: error.data,
        });
      }
      // 意外错误：不泄漏堆栈 / 路径 / 消息
      console.error(`[kiiii] ${route} 执行失败:`, error);
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

// ==================== 无状态 app 组装（createKiiiiApp） ====================
// 默认形态：插件虚拟入口（kiiii:server / kiiii:app）调用本函数，用户项目零服务器代码。
// 逃生舱（高级用法）：自写服务器入口手动组装：
//
// ```ts
// import { createKiiiiApp } from "kiiii/server";
// const app = createKiiiiApp({
//   prefix: "kiiii",
//   modules: { "api/greet": () => import("./src/api/greet.server.ts") },
// });
// ```

export interface KiiiiAppOptions {
  /** 路由 → 模块加载器（默认形态由插件虚拟模块提供） */
  modules: KiiiiModuleMap;
  /** URL 前缀，默认 "kiiii"（端点形如 /kiiii/{hash}） */
  prefix?: string;
  /** 开发模式：意外错误泄漏 message 便于调试，默认 false */
  isDev?: boolean;
}

/**
 * 组装远程调用 app（纯 RPC，无状态）：h3 app + 分发 handler。
 * 跨运行时（h3 core + devalue，零 node 依赖）——平台部署（Vercel / Cloudflare 等）
 * 用它拿 app 后自行包装（toNodeHandler / toWebHandler），静态资源由平台负责。
 */
export function createKiiiiApp(options: KiiiiAppOptions): H3 {
  const prefix = options.prefix ?? "kiiii";
  const app = new H3();
  app.use(
    `/${prefix}/**`,
    createKiiiiHandler({ modules: options.modules, prefix, isDev: options.isDev ?? false }),
  );
  return app;
}

// ==================== 自托管启动（startServer / createKiiiiServer） ====================
// node 专属（静态服务 + listhen 监听）：依赖全部动态加载，平台产物不引入本路径。

export interface KiiiiServerOptions extends KiiiiAppOptions {
  /**
   * 静态资源目录。默认约定：{项目根}/dist/clients（服务器产物在打包根 dist，
   * 从项目根启动 `node dist/index.js` 时 ./clients 即客户端产物）。
   * 需自定义时传绝对路径或 file: URL
   */
  staticDir?: string | URL;
  /** 监听端口，默认 process.env.PORT ?? 3000 */
  port?: number;
}

/** startServer 选项：只关心静态目录与端口（app 已组装，无需 modules） */
export interface StartServerOptions {
  staticDir?: string | URL;
  port?: number;
}

/**
 * 自托管启动：静态资源 + SPA fallback + listhen 监听（单端口）。
 * node 依赖（h3/node、listhen、node:fs）在此动态加载——仅自托管路径触发。
 */
export async function startServer(app: H3, options: StartServerOptions = {}): Promise<void> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const [{ mountStatic }, { toNodeHandler }, { listen }, { join }] = await Promise.all([
    import("./static.ts"),
    import("h3/node"),
    import("listhen"),
    import("node:path"),
  ]);
  const staticDir = options.staticDir ?? join(process.cwd(), "dist", "clients");
  mountStatic(app, staticDir);
  await listen(toNodeHandler(app), { port, hostname: "0.0.0.0" });
}

/**
 * 创建并启动生产服务器（远程调用 + 静态资源 + SPA fallback + listhen 监听，单端口）。
 *
 * 默认形态：插件虚拟入口（kiiii:server）调用本函数，全部内部逻辑（h3 app 组装、
 * 静态服务、history 路由 fallback、监听）由插件封装，用户项目零服务器代码。
 *
 * 构建：单个 vp build（插件 buildApp 钩子接管，虚拟入口为 SSR 构建 input）
 */
export async function createKiiiiServer(options: KiiiiServerOptions): Promise<H3> {
  const app = createKiiiiApp(options);
  await startServer(app, options);
  return app;
}
