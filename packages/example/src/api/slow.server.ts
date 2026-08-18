import type { KiiiiContext } from "kiiii/server";

/**
 * 慢任务：模拟耗时操作（10 秒），循环中检查取消信号——
 * 连接断开 / 全局超时 / 客户端主动 cancel 都会触发 signal，协作式提前退出。
 */
export default async function slow(this: unknown, seconds: number): Promise<string> {
  const ctx = this as KiiiiContext;
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    ctx.signal.throwIfAborted(); // 取消时提前退出（协作式取消）
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return `耗时 ${seconds} 秒完成`;
}
