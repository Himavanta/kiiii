// dev 模式 fixture：慢任务（挂起指定秒数，循环中检查取消信号）
import type { KiiiiContext } from "../../../../../src/server.ts";

export default async function slow(this: unknown, seconds: number): Promise<string> {
  const ctx = this as KiiiiContext;
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    ctx.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "done";
}
