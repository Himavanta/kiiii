import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { createFilter } from "vite";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { H3 } from "h3";
import { toNodeHandler } from "h3/node";
import { createRpcHandler } from "./server";
import type { RpcModuleMap } from "./server";
import { routeName } from "./hash";

/** 虚拟模块前缀：服务器入口/模块表/客户端 stub 统一走 \0fly-rpc:* */
const VIRTUAL_PREFIX = "\0fly-rpc:";
/** 服务器入口虚拟模块（SSR 构建入口） */
const SERVER_MODULE = "fly-rpc:server";
/** 模块表虚拟模块：内容 = import.meta.glob(pattern)，dev 运行时转换 / 生产构建期展开 */
const MODULES_MODULE = "fly-rpc:modules";

export interface RpcPluginOptions {
  /**
   * glob pattern（相对项目 root），默认 "/src/**\/*.server.ts"。
   * 唯一事实来源：dev 模块表、客户端拦截、生产打包全部由它推导，目录与后缀完全放开
   * （如 "/api/**\/*.actions.ts"）。pattern 决定哪些文件是服务器模块——
   * 客户端 import 命中 pattern 的文件会被替换为 RPC 调用，注意勿包含普通模块
   */
  pattern?: string;
  /** URL 前缀，默认 "rpc"（端点形如 /rpc/{文件名}-{hash}） */
  prefix?: string;
  /** 客户端调用超时（毫秒），0 关闭，默认 30_000 */
  timeout?: number;
}

/**
 * fly-rpc Vite 插件。
 *
 * - pattern 是唯一事实来源（不做后缀/目录推导）：route = routeName(相对 root 的完整路径)
 *   （文件名-hash，如 data.server.ts → greet-xxxxx），
 *   三个消费端各自使用同一 pattern 匹配与同一 route 算法：
 *   - dev：ssrLoadModule(模块表虚拟模块)——import.meta.glob 在 dev 下由 Vite 转换，
 *     无需目录扫描；每次请求 invalidate 后重载（新增 .server.ts 文件即用）
 *   - 客户端：resolveId 用 createFilter(pattern) 精确匹配 → 虚拟 stub（fetch 调用）
 *   - 生产：SSR 构建以虚拟入口（fly-rpc:server）为 input，入口 import 模块表虚拟模块，
 *     glob 构建期展开为 lazy chunks
 * - 无服务器入口文件（server/index.ts 不需要），入口代码由插件生成（createRpcServer 封装） */
export function rpc(options: RpcPluginOptions = {}): Plugin {
  const pattern = options.pattern ?? "/src/**/*.server.ts";
  const prefix = options.prefix ?? "rpc";
  const timeout = options.timeout ?? 30_000;
  let root = "";
  let serverPath = "";
  let clientPath = "";
  let hashPath = "";
  let isServerModule: ((id: string) => boolean) | null = null;

  return {
    name: "fly-rpc",
    enforce: "pre",

    configResolved(resolved: ResolvedConfig) {
      root = resolved.root;
      // 本插件 runtime 模块的相对路径（虚拟入口/模块表/客户端 stub 的 import 用，与包形态无关）
      const rel = (file: string) =>
        "/" + relative(root, fileURLToPath(new URL(file, import.meta.url))).replaceAll("\\", "/");
      serverPath = rel("./server.ts");
      clientPath = rel("./client.ts");
      hashPath = rel("./hash.ts");
      isServerModule = createFilter([pattern]);
    },

    /**
     * 构建时声明 SSR 构建（入口 = 虚拟模块 fly-rpc:server，经 rolldownOptions.input 指定——
     * build.ssr 为 true 而非字符串，字符串会被当作文件系统路径 resolve）。
     * Vite 标准流程据此注入完整的服务器环境（node 解析、依赖外部化）。dev 不受影响。
     */
    config(_userConfig, env) {
      if (env.command !== "build") return;
      return {
        build: {
          ssr: true,
          copyPublicDir: false, // public 属于客户端
          rolldownOptions: { input: { index: SERVER_MODULE } },
        },
      };
    },

    /**
     * 接管构建（vite-plus/vite builder 的 buildApp 钩子）：一个 vp build 完成两个环境。
     * 先服务器（SSR → 打包根），后客户端（→ {打包根}/clients）。所有打包参数都在插件内确定。
     */
    async buildApp(builder) {
      const { config } = builder;
      // 打包根（build.outDir 已 resolve 为绝对路径）：服务器产物在其根，客户端在其 {outDir}/clients
      const outDir = config.build.outDir;
      // 客户端环境：清掉继承的服务器入口 input、重定向 outDir、恢复 public 拷贝
      const { input: _serverInput, ...clientRolldown } =
        config.environments.client.build.rolldownOptions ?? {};
      config.environments["client"] = {
        ...config.environments.client,
        build: {
          ...config.environments.client.build,
          rolldownOptions: clientRolldown,
          ssr: false,
          outDir: join(outDir, "clients"),
          copyPublicDir: true,
        },
      };

      // 1. 服务器环境：legacy builder 已按 config.build.ssr 自动 setup
      await builder.build(builder.environments["ssr"]);

      // 2. 客户端环境 → {打包根}/clients
      const clientEnv = await config.build.createEnvironment("client", config);
      await clientEnv.init();
      builder.environments["client"] = clientEnv;
      await builder.build(clientEnv);
    },

    async resolveId(source, importer, resolveOptions) {
      // 虚拟模块（服务器入口 + 模块表）：SSR 构建与 dev 的 ssrLoadModule 都要解析
      if (source === SERVER_MODULE) return VIRTUAL_PREFIX + "server";
      if (source === MODULES_MODULE) return VIRTUAL_PREFIX + "modules";

      // SSR 解析不拦截（服务端要加载原文件）
      if (resolveOptions?.ssr || importer == null) return null;

      // 解析为绝对路径；pattern 精确匹配（相对 root 的路径），命中则转 stub
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return null;
      const route = toRoute(resolved.id, root, isServerModule!);
      if (!route) return null;

      return VIRTUAL_PREFIX + route;
    },

    load(id) {
      if (id === VIRTUAL_PREFIX + "server") {
        return generateServerEntry(serverPath, prefix);
      }
      if (id === VIRTUAL_PREFIX + "modules") {
        return generateModules(pattern, hashPath);
      }
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const route = id.slice(VIRTUAL_PREFIX.length);
      return generateStub(route, prefix, timeout, clientPath);
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
        void handleDevRpc(server, prefix, req, res);
      });
    },
  };
}

/** dev 请求处理：重载模块表（invalidate 使 glob 重新匹配，新增文件即用）+ ssrLoadModule */
async function handleDevRpc(
  server: ViteDevServer,
  prefix: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const cached = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + "modules");
    if (cached) server.moduleGraph.invalidateModule(cached);
    const mod = await server.ssrLoadModule(MODULES_MODULE);
    const modules = mod.default as RpcModuleMap;
    const app = new H3();
    app.use(createRpcHandler({ modules, prefix, isDev: true }));
    toNodeHandler(app)(req, res);
  } catch (error) {
    console.error("[fly-rpc] dev handler 错误:", error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
}

/**
 * 计算路由：文件名-hash（与生产模块表生成代码同一算法）。
 * 不在 pattern 内的路径返回 null（不拦截）。
 */
function toRoute(id: string, root: string, isServerModule: (id: string) => boolean): string | null {
  const rel = relative(root, id);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const normalized = "/" + rel.replaceAll("\\", "/");
  if (!isServerModule(normalized)) return null;
  return routeName(normalized);
}
/** 生成服务器入口（虚拟模块）：最少逻辑——createRpcServer + 模块表，prefix 由插件选项注入 */
function generateServerEntry(serverPath: string, prefix: string): string {
  const safeServer = JSON.stringify(serverPath);
  const safePrefix = JSON.stringify(prefix);
  return `import { createRpcServer } from ${safeServer};
import modules from "fly-rpc:modules";

// 由 fly-rpc 生成的服务器入口（虚拟模块）：RPC + 静态资源 + SPA fallback + listhen
await createRpcServer({ prefix: ${safePrefix}, modules });
`;
}

/** 生成模块表（虚拟模块）：import.meta.glob 构建期展开；route = routeName(相对 root 的完整路径) */
function generateModules(pattern: string, hashPath: string): string {
  const safePattern = JSON.stringify(pattern);
  const safeHash = JSON.stringify(hashPath);
  return `import { routeName } from ${safeHash};
const globs = import.meta.glob(${safePattern});
export default Object.fromEntries(
  Object.entries(globs).map(([k, v]) => [routeName(k), v]),
);
`;
}

/** 生成客户端 stub：替换服务器模块为 fetch 调用（所有插值经 JSON.stringify 转义） */
function generateStub(route: string, prefix: string, timeout: number, clientPath: string): string {
  const safeRoute = JSON.stringify(route);
  const safePrefix = JSON.stringify(prefix);
  const safeClient = JSON.stringify(clientPath);
  return `
import { rpcCall } from ${safeClient};


// 由 fly-rpc 生成的客户端 stub：运行时替换服务端函数为 fetch 调用
// 类型来自原文件（编辑器解析磁盘上的 .server.ts），行为与签名一致
export default (...args) => rpcCall(${safePrefix}, ${safeRoute}, args, ${timeout});
`;
}
