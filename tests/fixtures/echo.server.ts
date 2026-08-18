// 测试 fixture：类型传输回显（与 example 的 types.server.ts 同构）
// 注意：测试直接用相对路径 import 源码（不经包解析，避免依赖 dist 构建顺序）
import type { KiiiiContext } from "../../src/server.ts";

export default async function echo(this: unknown, value: unknown): Promise<unknown> {
  const ctx = this as KiiiiContext;
  ctx.signal.throwIfAborted();
  return value;
}
