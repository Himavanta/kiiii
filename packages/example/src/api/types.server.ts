import type { RpcContext } from "kiiii/server";

/**
 * 类型传输测试：echo 回显任意值（客户端传什么返回什么）。
 * 验证 devalue 传输的保真：Date / Map / Set / BigInt / undefined / NaN /
 * Infinity / -0 / 循环引用 / ArrayBuffer / URL 等（见 tests/types.test.ts）。
 */
export default async function echo(this: unknown, value: unknown): Promise<unknown> {
  const ctx = this as RpcContext;
  ctx.signal.throwIfAborted();
  return value;
}
