// kiiii 主入口：仅导出 Vite 插件（用于 vite.config.ts）。
//
// 服务器模块（.server.ts）请用 "kiiii/server"（RpcError/RpcContext/createRpcServer/...），
// 客户端代码请用 "kiiii/client"（rpcCall/rpcCancel）——主入口含构建期工具（vite）的
// import，只该出现在 vite.config.ts；从主入口拿 runtime 会把构建工具拖入业务产物。
export { rpc } from "./plugin.ts";
export type { RpcPluginOptions } from "./plugin.ts";
