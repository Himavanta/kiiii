import { t as RpcError } from "./server-BlrjEieV.js";
//#region src/api/greet.server.ts
/**
 * 示例服务端函数：客户端 import 本文件时被替换为 fetch stub（见 src/rpc/plugin.ts），
 * 服务端由 h3 handler 加载原文件并通过 fn.call(context, ...args) 分发。
 *
 * 约定：
 * - 文件即函数：每个 .server.ts 只导出 export default
 * - 上下文经 this 注入；末尾的 as 断言剥除 this 参数（纯编译期操作，无运行时包装），
 *   使客户端调用与普通函数完全一致（TS 对带 this 参数的函数做自由调用会报 TS2684）
 * - 参数与返回值需 devalue 可序列化
 * - 业务错误显式抛出 RpcError（message/code/data 跨网络到达客户端）
 */
var greet_server_default = async function (name) {
  this.signal.throwIfAborted();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!name) throw new RpcError("名字不能为空", "EMPTY_NAME");
  return `Hello ${name}!`;
};
//#endregion
export { greet_server_default as default };
