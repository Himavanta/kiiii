import { createRpcServer, fromGlob } from "../src/rpc/server";

// fly-rpc 生产服务器入口（显式文件，全部内部逻辑由插件封装）。
//
// - RPC：import.meta.glob 构建时静态打包全部 .server.ts（pattern 相对项目根，
//   base 与 scanRoot 选项一致，默认 "/src/"）；请求时 lazy 加载分发
// - 静态资源：默认约定 {项目根}/dist/clients（从项目根启动 node dist/index.js）
// - SPA fallback + listhen 监听（PORT 环境变量可配，默认 3000）
//
// 构建：单个 vp build 完成服务器 + 客户端两个环境（入口经插件选项 serverEntry 传入，
// 产物：dist/index.js + dist/assets/* + dist/clients/*）：
//   pnpm build
await createRpcServer({
  prefix: "rpc",
  // 泛型显式声明模块形状（vite/client 的 Overload 2），返回类型与 fromGlob 参数直接匹配
  modules: fromGlob(import.meta.glob<{ default: unknown }>("/src/**/*.server.ts")),
});
