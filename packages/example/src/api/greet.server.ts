import { KiiiiError } from "kiiii/error";
import type { KiiiiContext } from "kiiii/server";

/**
 * 示例服务端函数：客户端 import 本文件时被替换为 fetch stub（见 kiiii 包），
 * 服务端由 h3 handler 加载原文件并通过 fn.call(context, ...args) 分发（见 kiiii 包）。
 *
 * 约定：
 * - 文件即函数：每个 .server.ts 只导出 export default
 * - 上下文经 this 注入：this 类型放宽为 unknown（客户端自由调用不报 TS2684，
 *   服务端 fn.call(context) 分发不变），函数内开头一次断言拿到 KiiiiContext
 * - 参数与返回值需 devalue 可序列化
 * - 业务错误显式抛出 KiiiiError（message/code/data 跨网络到达客户端）
 */
export default async function (this: unknown, name: string): Promise<string> {
  const ctx = this as KiiiiContext; // 函数内一次断言（集中一处）
  ctx.signal.throwIfAborted();
  if (!name) throw new KiiiiError("名字不能为空", "EMPTY_NAME");
  return `Hello ${name}!`;
}
