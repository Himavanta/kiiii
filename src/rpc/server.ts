import { defineEventHandler, readRawBody, createError, setResponseStatus } from "h3";
import type { H3Event } from "h3";
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
      throw createError({ statusCode: 405, statusMessage: "Method Not Allowed" });
    }

    // 路由解析：/rpc/actions/greet → route = "actions/greet"
    if (!event.path.startsWith(`/${prefix}/`)) {
      throw createError({ statusCode: 404, statusMessage: "Not Found" });
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
      throw createError({ statusCode: 404, statusMessage: "Not Found" });
    }
    const loader = modules[route];
    if (!loader) {
      throw createError({ statusCode: 404, statusMessage: "Not Found" });
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
    const raw = await readRawBody(event);
    let args: unknown[] = [];
    if (raw) {
      try {
        const parsed: unknown = parse(raw);
        if (!Array.isArray(parsed)) {
          throw createError({ statusCode: 400, statusMessage: "Bad Request" });
        }
        args = parsed;
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) throw error;
        throw createError({ statusCode: 400, statusMessage: "Bad Request" });
      }
    }

    const mod = await loader();
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw createError({ statusCode: 500, statusMessage: "Internal Server Error" });
    }

    // 分发：context 经 this 注入，参数按位置展开（与函数声明完全一致）
    const context: RpcContext = { signal: controller.signal, event };
    try {
      const result = await fn.call(context, ...args);
      return stringify(result);
    } catch (error) {
      if (isRpcError(error)) {
        // 业务错误：开发者显式声明的错误，message/code/data 是产品的一部分（生产也传）
        setResponseStatus(event, 200);
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
      throw createError({ statusCode: 500, statusMessage: "Internal Server Error" });
    }
  });
}
