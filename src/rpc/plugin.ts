import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { H3 } from "h3";
import { toNodeHandler } from "h3/node";
import { createRpcHandler } from "./server";
import type { RpcModuleMap } from "./server";

const SERVER_FILE_RE = /\.server\.ts$/;
/** 虚拟模块前缀：客户端 import .server.ts 时被重写为 \0fly-rpc:{route} */
const VIRTUAL_PREFIX = "\0fly-rpc:";

export interface RpcPluginOptions {
  /** URL 前缀，默认 "rpc"（端点形如 /rpc/actions/greet） */
  prefix?: string;
  /** 客户端调用超时（毫秒），0 关闭，默认 30_000 */
  timeout?: number;
  /** 服务端函数扫描根目录（相对项目 root），默认 "src" */
  scanRoot?: string;
}

/**
 * fly-rpc Vite 插件。
 *
 * - 客户端构建：resolveId 拦截 *.server.ts 导入 → 虚拟 stub 模块（load 生成 fetch 调用）
 * - 服务端原文件保持不动：SSR 解析（options.ssr）不拦截，dev 由 ssrLoadModule 加载
 * - dev 模式：把 h3 RPC handler 挂到 Vite 中间件；每次请求扫描 .server.ts 并
 *   ssrLoadModule（Vite 模块图负责缓存与 HMR 失效）
 */
export function rpc(options: RpcPluginOptions = {}): Plugin {
  const prefix = options.prefix ?? "rpc";
  const timeout = options.timeout ?? 30_000;
  let scanRoot = "";

  return {
    name: "fly-rpc",
    enforce: "pre",

    configResolved(config: ResolvedConfig) {
      scanRoot = join(config.root, options.scanRoot ?? "src");
    },

    async resolveId(source, importer, resolveOptions) {
      // SSR 解析不拦截（服务端要加载原文件）
      if (resolveOptions?.ssr || importer == null) return null;
      if (!SERVER_FILE_RE.test(source)) return null;

      // 解析为绝对路径，计算路由；不在扫描根目录内的不拦截
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return null;
      const route = toRoute(resolved.id, scanRoot);
      if (!route) return null;

      return VIRTUAL_PREFIX + route;
    },

    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const route = id.slice(VIRTUAL_PREFIX.length);
      return generateStub(route, prefix, timeout);
    },

    configureServer(server) {
      // dev：h3 handler 挂到 Vite 中间件。
      // 注意不能用 connect 的 use(path) 形式——它会剥掉匹配前缀改写 req.url，
      // 导致 h3 看到的 event.path 丢失 /rpc 前缀；这里手动判断前缀，未命中走 next
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url !== `/${prefix}` && !url.startsWith(`/${prefix}/`)) {
          next();
          return;
        }
        void handleDevRpc(server, scanRoot, prefix, req, res);
      });
    },
  };
}

/** dev 请求处理：每次请求重新扫描文件 + 通过 ssrLoadModule 加载（HMR 自动失效） */
async function handleDevRpc(
  server: ViteDevServer,
  scanRoot: string,
  prefix: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const modules = await scanServerFiles(scanRoot, server);
    const app = new H3();
    app.use(createRpcHandler({ modules, prefix, isDev: true }));
    toNodeHandler(app)(req, res);
  } catch (error) {
    console.error("[fly-rpc] dev handler 错误:", error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
}

/** 递归扫描扫描根目录下的 .server.ts 文件 */
async function scanServerFiles(scanRoot: string, server: ViteDevServer): Promise<RpcModuleMap> {
  const files: string[] = [];
  await walkDir(scanRoot, files);
  const modules: RpcModuleMap = {};
  for (const file of files) {
    const route = toRoute(file, scanRoot);
    if (route) {
      modules[route] = () => server.ssrLoadModule(file) as Promise<{ default: unknown }>;
    }
  }
  return modules;
}

async function walkDir(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在时静默跳过
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, out);
    } else if (SERVER_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * 计算路由：相对扫描根目录的路径，去 .server.ts 后缀。
 * 扫描根目录之外的路径返回 null（不拦截）。
 */
function toRoute(file: string, scanRoot: string): string | null {
  const rel = relative(scanRoot, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const normalized = rel.replaceAll("\\", "/");
  if (!SERVER_FILE_RE.test(normalized)) return null;
  const route = normalized.slice(0, -".server.ts".length);
  return route || null;
}

/** 生成客户端 stub：替换 .server.ts 模块为 fetch 调用（所有插值经 JSON.stringify 转义） */
function generateStub(route: string, prefix: string, timeout: number): string {
  const safeRoute = JSON.stringify(route);
  const safePrefix = JSON.stringify(prefix);
  return `
import { rpcCall } from "/src/rpc/client.ts";

// 由 fly-rpc 生成的客户端 stub：运行时替换服务端函数为 fetch 调用
// 类型来自原文件（编辑器解析磁盘上的 .server.ts），行为与签名一致
export default (...args) => rpcCall(${safePrefix}, ${safeRoute}, args, ${timeout});
`;
}
