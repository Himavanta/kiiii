import { createError, defineEventHandler, readRawBody, setResponseStatus } from "h3";
import { parse, stringify } from "devalue";
//#region src/rpc/server.ts
/**
 * 业务错误：显式抛出后其 message/code/data 会跨网络到达客户端
 * （200 + 错误信封，客户端 stub 检测后 reject 同构的 Error）
 * 普通 throw 的 Error 属于意外错误，生产环境不泄漏任何细节。
 */
var RpcError = class extends Error {
  code;
  data;
  constructor(message, code, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
};
/**
 * 判断一个错误是否为 RpcError。
 * 用 name 品牌判断而非 instanceof：dev 下插件链（配置加载）与 .server.ts 链
 * （ssrLoadModule）会各自加载一份 server.ts，instanceof 跨模块实例会失效。
 */
function isRpcError(error) {
  return error instanceof Error && error.name === "RpcError";
}
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
function fromGlob(globs, base = "/src/") {
  const modules = {};
  for (const [key, loader] of Object.entries(globs)) {
    if (!key.startsWith(base) || !key.endsWith(".server.ts")) continue;
    modules[key.slice(base.length, -10)] = loader;
  }
  return modules;
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
function createRpcHandler(options) {
  const { modules } = options;
  const prefix = options.prefix ?? "rpc";
  const isDev = options.isDev ?? false;
  return defineEventHandler(async (event) => {
    if (event.method !== "POST")
      throw createError({
        statusCode: 405,
        statusMessage: "Method Not Allowed",
      });
    if (!event.path.startsWith(`/${prefix}/`))
      throw createError({
        statusCode: 404,
        statusMessage: "Not Found",
      });
    const route = event.path.slice(prefix.length + 2);
    if (
      !route ||
      route.includes("..") ||
      route.includes("\\") ||
      route.startsWith("/") ||
      route.endsWith("/")
    )
      throw createError({
        statusCode: 404,
        statusMessage: "Not Found",
      });
    const loader = modules[route];
    if (!loader)
      throw createError({
        statusCode: 404,
        statusMessage: "Not Found",
      });
    const controller = new AbortController();
    const res = event.runtime?.node?.res;
    if (res) res.on("close", () => controller.abort());
    const raw = await readRawBody(event);
    let args = [];
    if (raw)
      try {
        const parsed = parse(raw);
        if (!Array.isArray(parsed))
          throw createError({
            statusCode: 400,
            statusMessage: "Bad Request",
          });
        args = parsed;
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) throw error;
        throw createError({
          statusCode: 400,
          statusMessage: "Bad Request",
        });
      }
    const fn = (await loader()).default;
    if (typeof fn !== "function")
      throw createError({
        statusCode: 500,
        statusMessage: "Internal Server Error",
      });
    const context = {
      signal: controller.signal,
      event,
    };
    try {
      const result = await fn.call(context, ...args);
      return stringify(result);
    } catch (error) {
      if (isRpcError(error)) {
        setResponseStatus(event, 200);
        return stringify({
          ok: false,
          name: "RpcError",
          message: error.message,
          code: error.code,
          data: error.data,
        });
      }
      console.error(`[fly-rpc] ${route} 执行失败:`, error);
      if (isDev)
        return stringify({
          ok: false,
          name: "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      throw createError({
        statusCode: 500,
        statusMessage: "Internal Server Error",
      });
    }
  });
}
//#endregion
export { createRpcHandler as n, fromGlob as r, RpcError as t };
