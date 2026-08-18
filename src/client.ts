import { parse, stringify } from "devalue";
import { isFunction, isObject, isString } from "./guards.ts";

/**
 * RPC 调用错误：业务错误（服务端 RpcError）跨网络还原后的形态。
 * 客户端用 `catch (e) { if (e.code === "...") }` 分支业务错误。
 */
export interface RpcCallError extends Error {
  code?: string;
  data?: unknown;
}

/** 内部标记：挂在返回的 Promise 上，供 rpcCancel() 取出 AbortController */
const CANCEL_KEY = Symbol("kiiii.cancel");

export type CancelablePromise<T> = Promise<T> & { [CANCEL_KEY]?: (reason?: string) => void };

/** 业务错误信封（服务端 RpcError 序列化形态，见 server.ts 的协议） */
interface RpcErrorEnvelope {
  ok: false;
  name: string;
  message: string;
  code?: string;
  data?: unknown;
}

function isErrorEnvelope(value: unknown): value is RpcErrorEnvelope {
  return isObject(value) && value.ok === false && isString(value.message);
}

/**
 * 发起 RPC 调用（由生成的客户端 stub 调用）。
 *
 * - 返回 Promise<T>，resolve 数据本身——与"类型来自原文件"的签名严格一致
 * - 业务错误 reject 带 code/data 的 Error（try/catch 与本地调用一致）
 * - 传输/协议错误 reject 通用 Error
 * - 超时（timeout 毫秒，0 关闭）自动 abort
 * - 可经 rpcCancel(promise, reason) 主动取消
 */
export function rpcCall(
  prefix: string,
  route: string,
  args: unknown[],
  timeout = 30_000,
): CancelablePromise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeout > 0) {
    timer = setTimeout(() => {
      controller.abort(new DOMException("RPC 超时", "TimeoutError"));
    }, timeout);
  }

  const promise = fetch(`/${prefix}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: stringify(args),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`RPC ${route} 失败（HTTP ${response.status}）`);
      }
      const value: unknown = parse(await response.text());
      if (isErrorEnvelope(value)) {
        const error: RpcCallError = new Error(value.message);
        error.name = "RpcError";
        error.code = value.code;
        error.data = value.data;
        throw error;
      }
      return value;
    })
    .finally(() => clearTimeout(timer)) as CancelablePromise<unknown>;

  promise[CANCEL_KEY] = (reason?: string) => controller.abort(reason);
  return promise;
}

/**
 * 取消一个进行中的 RPC 调用（类型安全：接受任意 Promise，非 RPC 调用时静默忽略）。
 * 服务端函数通过 this.signal 感知并提前退出。
 *
 * ```ts
 * const p = greet("World");
 * rpcCancel(p, "用户取消了");
 * ```
 */
export function rpcCancel(promise: Promise<unknown>, reason?: string): void {
  const cancel = (promise as Partial<CancelablePromise<unknown>>)[CANCEL_KEY];
  if (isFunction(cancel)) {
    cancel(reason);
  }
}
