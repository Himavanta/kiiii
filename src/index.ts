// kiiii 包入口：插件 + 服务端 runtime + 客户端 runtime
// 生成代码（虚拟模块/stub）也从本入口 import（"kiiii"），打包形态下路径稳定

export { rpc } from "./plugin.ts";
export type { RpcPluginOptions } from "./plugin.ts";

export { createRpcHandler, createRpcServer, isRpcError, RpcError } from "./server.ts";
export type { RpcContext, RpcHandlerOptions, RpcModuleMap, RpcServerOptions } from "./server.ts";

export { rpcCall, rpcCancel } from "./client.ts";
export type { CancelablePromise, RpcCallError } from "./client.ts";

export { buildModuleMap } from "./modules.ts";
export { routeHash } from "./hash.ts";
