// 测试 fixture：业务错误抛出（KiiiiError 信封往返，见 error 协议）
// 注意：测试直接用相对路径 import 源码（不经包解析，避免依赖 dist 构建顺序）
import { KiiiiError } from "../../src/error.ts";

export default async function fail(this: unknown): Promise<never> {
  // data 携带复杂类型（Date）——验证信封 data 字段跨网络保真
  throw new KiiiiError("业务失败", "BUSINESS_FAIL", { at: new Date("2024-01-01T00:00:00.000Z") });
}
