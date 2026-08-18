// dev 模式 fixture：内容固定（测试内动态创建/修改/删除临时文件，不污染 git 资产）
import type { KiiiiContext } from "../../../../../src/server.ts";

export default async function hello(this: unknown): Promise<string> {
  const ctx = this as KiiiiContext;
  ctx.signal.throwIfAborted();
  return "hello";
}
