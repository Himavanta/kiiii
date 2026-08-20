// kiiii 主入口：Vite 插件（用于 vite.config.ts）。
//
// 服务器模块（.server.ts）请用 "kiiii/server"（KiiiiContext/createKiiiiApp/...），自托管启动从 "kiiii/node" 拿（startServer/createKiiiiServer），
// 错误协议从 "kiiii/error" 拿，客户端代码请用 "kiiii/client"（invoke/cancel）——主入口含构建期工具（vite）的
// import，只该出现在 vite.config.ts；从主入口拿 runtime 会把构建工具拖入业务产物。
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { createFilter } from "vite";
import { join, relative, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { H3 } from "h3";
import { toNodeHandler } from "h3/node";
import { createKiiiiHandler } from "./server.ts";
import type { KiiiiModuleMap } from "./server.ts";
import { routeHash } from "./modules.ts";
import { isArray, isEmpty, isNil } from "./guards.ts";

/** Vite 约定：虚拟 id 以 \0 开头（非合法文件名字符），与真实文件路径必然不冲突 */
const virtual = (id: string): string => `\0${id}`;

/** 自托管启动虚拟模块：kiiii:app 的封装（拿 app + 启动），node dist/start.js 直接运行时经 import.meta.main 启动 */
const START_MODULE = "kiiii:start";
const START_ID = virtual(START_MODULE);
/** 平台入口虚拟模块：导出 app（无状态，平台包装 toNodeHandler / toWebHandler） */
const APP_MODULE = "kiiii:app";
const APP_ID = virtual(APP_MODULE);
/** 模块表虚拟模块 */
const MODULES_MODULE = "kiiii:modules";
const MODULES_ID = virtual(MODULES_MODULE);
/** 客户端 stub 虚拟模块前缀 */
const VIRTUAL_PREFIX = virtual("kiiii:");

export interface KiiiiOptions {
  /**
   * glob pattern（相对项目 root）或 pattern 数组（多重匹配，目录/后缀完全放开）。
   * 必填——命中 pattern 的文件是服务器模块：客户端 import 它们会被替换为远程调用
   */
  pattern: string | string[];
  /** URL 前缀，默认 "kiiii"（端点形如 /kiiii/{hash}） */
  prefix?: string;
  /** 客户端调用超时（毫秒），0 关闭，默认 30_000 */
  timeout?: number;
  /**
   * 服务器产物是否打包全部依赖（自包含部署），默认 true。
   * false 时依赖保持 external——运行时从部署环境的 node_modules 解析（需安装 dependencies）
   */
  bundleDeps?: boolean;
}

/**
 * kiiii Vite 插件：把 .server.ts 文件变成客户端可调用的远程函数。
 *
 * pattern 是唯一事实来源：route = routeHash(相对 root 的完整路径)，三个消费端共用同一 pattern 与算法——
 * dev（ssrLoadModule + 每请求重载模块表）、客户端（createFilter 匹配 → 虚拟 stub）、
 * 生产（SSR 构建以虚拟入口 kiiii:start 为 input，glob 展开为 lazy chunks）。
 * 服务器入口代码由插件生成（kiiii:start 自托管 / kiiii:app 无状态平台入口），用户项目零服务器代码。
 */
export function kiiii(options?: KiiiiOptions): Plugin {
  const pattern = options?.pattern;
  if (isNil(pattern) || (isArray(pattern) && isEmpty(pattern))) {
    throw new Error('[kiiii] pattern 选项必填（如 "/src/**/*.server.ts"）');
  }
  const prefix = options?.prefix ?? "kiiii";
  const timeout = options?.timeout ?? 30_000;
  const bundleDeps = options?.bundleDeps ?? true;
  let root = "";
  let isServerModule: ((id: string) => boolean) | null = null;
  // dev：缓存的请求 handler——文件增删时置空重建，稳态请求零转换零分配
  let devHandler: ReturnType<typeof toNodeHandler> | null = null;

  /** dev 请求处理：复用缓存的 handler；仅首次 / 文件增删后重建（重载模块表 + 新建 h3 app） */
  const handleDevRequest = async (
    server: ViteDevServer,
    prefix: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    try {
      if (!devHandler) {
        const cached = server.moduleGraph.getModuleById(MODULES_ID);
        if (cached) server.moduleGraph.invalidateModule(cached);
        const mod = await server.ssrLoadModule(MODULES_MODULE);
        const modules = mod.default as KiiiiModuleMap;
        const app = new H3();
        app.use(createKiiiiHandler({ modules, prefix, isDev: true }));
        devHandler = toNodeHandler(app);
      }
      await devHandler(req, res);
    } catch (error) {
      console.error("[kiiii] dev handler 错误:", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  };

  return {
    name: "kiiii",
    enforce: "pre",

    configResolved(resolved: ResolvedConfig) {
      root = resolved.root;
      isServerModule = createFilter(pattern);
    },

    /**
     * 构建时声明双环境（Vite 8 环境模型，声明式）：
     * - server：kiiii 私有空间——SSR + 虚拟入口 + 产物 {outDir}/server
     * - client：用户空间——outDir 重定向到 {outDir}/public（其余 input/plugins/alias 等原样）
     * 用户 outDir 用作产物根（默认 dist）：kiiii 只在其中建 public/server 两个子目录，不覆盖用户值。
     * 纯 vite 构建：vite 8 自动构建所有声明环境——环境级 input 覆盖根 input（无污染），无需额外钩子。
     */
    config(_userConfig, env) {
      if (env.command !== "build") return;
      // 用户 outDir（相对 root）作为产物根；kiiii 的 public/server 子目录基于它拼接
      const userOutDir = _userConfig.build?.outDir ?? "dist";
      return {
        // vite-plus 非 legacy 开关（vite-plus 的 vp build 需要；纯 vite 忽略该字段）
        builder: {},
        environments: {
          server: {
            build: {
              ssr: true,
              rolldownOptions: { input: { start: START_MODULE, index: APP_MODULE } },
              outDir: join(userOutDir, "server"),
              copyPublicDir: false, // public 属于客户端
            },
          },
          client: {
            build: {
              outDir: join(userOutDir, "public"),
              copyPublicDir: true,
            },
          },
        },
        // 依赖打包策略：bundleDeps=true 全量打包（自包含部署）；false 时不传 noExternal（保持默认 external）。
        // vite 系构建期工具始终 external（Vite merge 对数组 concat，用户自定义 external 保留）
        ...(bundleDeps
          ? {
              ssr: {
                noExternal: true,
                external: ["vite", "vite-plus-core", "@voidzero-dev/vite-plus-core"],
              },
            }
          : {}),
      };
    },

    /**
     * vite-plus 兼容层（纯 vite 的 vite 8 官方构建自动处理：环境级 input 覆盖根、默认 ssr 不构建——此钩子不运行）：
     * vp build 会把默认 ssr 环境（html input）加入构建——此处跳过未声明环境，只构建 server/client。
     */
    async buildApp(builder) {
      const server = builder.environments["server"];
      const client = builder.environments["client"];
      if (!server || !client) {
        throw new Error("[kiiii] server / client 环境未声明");
      }
      // 服务器 input 收窄为虚拟入口：vite-plus 的配置合并会把用户根 input 混入
      server.config.build.rolldownOptions = {
        ...server.config.build.rolldownOptions,
        input: { start: START_MODULE, index: APP_MODULE },
      };
      // 未声明的环境（含 vite 8 内置默认 ssr 环境——input 为默认 index.html）跳过
      for (const env of Object.values(builder.environments)) {
        if (env !== server && env !== client) env.isBuilt = true;
      }
      await builder.build(server);
      await builder.build(client);
    },

    async resolveId(source, importer, resolveOptions) {
      // 虚拟模块（自托管启动 + 平台入口 + 模块表）
      if (source === START_MODULE) return START_ID;
      if (source === APP_MODULE) return APP_ID;
      if (source === MODULES_MODULE) return MODULES_ID;

      // SSR 解析不拦截（服务端要加载原文件）
      if (resolveOptions?.ssr || isNil(importer)) return null;

      // pattern 精确匹配（相对 root 的路径），命中则转 stub
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return null;
      const route = toRoute(resolved.id, root, isServerModule!);
      if (!route) return null;

      return VIRTUAL_PREFIX + route;
    },

    load(id) {
      if (id === START_ID) {
        return generateStartEntry();
      }
      if (id === APP_ID) {
        return generateAppEntry(prefix);
      }
      if (id === MODULES_ID) {
        return generateModules(pattern);
      }
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const route = id.slice(VIRTUAL_PREFIX.length);
      return generateStub(route, prefix, timeout);
    },

    configureServer(server) {
      // 文件增删（glob 匹配结果变化）→ 丢弃缓存的 dev handler（下次请求重建）；
      // 内容修改由 Vite 自动失效对应模块，模块表无需重建
      const onFsChange = (file: string) => {
        const normalized = normalizedPath(file, root);
        if (normalized && isServerModule?.(normalized)) devHandler = null;
      };
      server.watcher.on("add", onFsChange);
      server.watcher.on("unlink", onFsChange);

      // dev：h3 handler 挂到 Vite 中间件。手动匹配前缀（connect 的 use(path) 会改写 req.url 破坏路由）
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url !== `/${prefix}` && !url.startsWith(`/${prefix}/`)) {
          next();
          return;
        }
        void handleDevRequest(server, prefix, req, res);
      });
    },
  };
}

/**
 * 相对 root 的归一化路径（/ 开头、反斜杠转正斜杠）；root 之外返回 null。
 */
function normalizedPath(id: string, root: string): string | null {
  const rel = relative(root, id);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return "/" + rel.replaceAll("\\", "/");
}

/**
 * 计算路由：相对项目 root 的完整路径的哈希（与生产模块表生成代码同一算法）。
 * 不在 pattern 内的路径返回 null（不拦截）。
 */
function toRoute(id: string, root: string, isServerModule: (id: string) => boolean): string | null {
  const normalized = normalizedPath(id, root);
  if (!normalized || !isServerModule(normalized)) return null;
  return routeHash(normalized);
}
/**
 * 值 → JS 字面量（嵌入生成代码）。
 * 所有生成代码的插值必须经过它（JSON.stringify 转义），防止注入与语法破坏。
 */
const lit = (value: unknown): string => JSON.stringify(value);

/** 生成自托管启动入口（虚拟模块）：kiiii:app 的封装——拿 app + 静态 + 监听（node dist/start.js 直接运行） */
function generateStartEntry(): string {
  return `import app from "kiiii:app";
import { startServer } from "kiiii/node";

// 由 kiiii 生成的自托管启动入口（虚拟模块）：kiiii:app 的封装（app 组装在 kiiii:app 单源维护）
// import.meta.main：node 22.13+ 直接执行时为 true；被 import 时不启动（任何方式引用都无副作用）
if (import.meta.main) await startServer(app);
`;
}

/** 生成平台入口（虚拟模块）：只导出 app（无状态），由部署平台包装（toNodeHandler / toWebHandler） */
function generateAppEntry(prefix: string): string {
  return `import { createKiiiiApp } from "kiiii/server";
import modules from "kiiii:modules";

// 由 kiiii 生成的无状态入口（虚拟模块）：导出 app，静态资源由部署平台负责
export default createKiiiiApp({ prefix: ${lit(prefix)}, modules });
`;
}

/** 生成模块表（虚拟模块）：import.meta.glob 展开 + buildModuleMap 组装 */
function generateModules(pattern: string | string[]): string {
  return `import { buildModuleMap } from "kiiii/server";
const globs = import.meta.glob(${lit(pattern)});
export default buildModuleMap(globs);
`;
}

/** 生成客户端 stub：替换服务器模块为 fetch 调用（所有插值经 lit 转义） */
function generateStub(route: string, prefix: string, timeout: number): string {
  return `
import { invoke } from "kiiii/client";

// 由 kiiii 生成的客户端 stub：运行时替换服务端函数为 fetch 调用
// 类型来自原文件（编辑器解析磁盘上的服务器模块文件），行为与签名一致
export default (...args) => invoke(${lit(prefix)}, ${lit(route)}, args, ${timeout});
`;
}
