// 自托管启动（node 专属）：静态资源 + SPA fallback + listhen 监听。
// 独立于跨运行时核心（kiiii/server）——平台部署入口（kiiii:app，产物 dist/index.js）不引用本入口，
// 保证其依赖链彻底无 node 引用（Cloudflare Workers 等 Web 运行时可直接打包）。
import type { H3 } from "h3";
import type { KiiiiAppOptions } from "./server.ts";
import { createKiiiiApp } from "./server.ts";

export interface StartServerOptions {
  /**
   * 静态资源目录。默认约定：{项目根}/dist/clients（服务器产物在打包根 dist，
   * 从项目根启动 `node dist/start.js` 时 ./clients 即客户端产物）。
   * 需自定义时传绝对路径或 file: URL
   */
  staticDir?: string | URL;
  /** 监听端口，默认 process.env.PORT ?? 3000 */
  port?: number;
}

/** createKiiiiServer 选项：app 组装 + 启动参数 */
export interface KiiiiServerOptions extends KiiiiAppOptions {
  staticDir?: string | URL;
  port?: number;
}

/**
 * 自托管启动：静态资源 + SPA fallback + listhen 监听（单端口）。
 * node 依赖（h3/node、listhen、node:fs、node:path）在此动态加载——仅自托管路径触发。
 */
export async function startServer(app: H3, options: StartServerOptions = {}): Promise<void> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const [{ mountStatic }, { toNodeHandler }, { listen }, { join }] = await Promise.all([
    import("./static.ts"),
    import("h3/node"),
    import("listhen"),
    import("node:path"),
  ]);
  const staticDir = options.staticDir ?? join(process.cwd(), "dist", "clients");
  mountStatic(app, staticDir);
  await listen(toNodeHandler(app), { port, hostname: "0.0.0.0" });
}

/**
 * 创建并启动生产服务器（远程调用 + 静态资源 + SPA fallback + listhen 监听，单端口）。
 *
 * 默认形态：插件虚拟入口（kiiii:start）调用本函数，全部内部逻辑（h3 app 组装、
 * 静态服务、history 路由 fallback、监听）由插件封装，用户项目零服务器代码。
 * 逃生舱（高级用法）：自写服务器入口手动组装 createKiiiiApp + startServer。
 *
 * 构建：单个 vp build（插件 buildApp 钩子接管，虚拟入口为 SSR 构建 input）
 */
export async function createKiiiiServer(options: KiiiiServerOptions): Promise<H3> {
  const app = createKiiiiApp(options);
  await startServer(app, options);
  return app;
}
