// 插件单元测试：config / configResolved / resolveId / load 钩子与生成代码（不经 Vite 实例）。
// buildApp 钩子（双环境构建）由 example build 端到端覆盖。
import { expect, test } from "vite-plus/test";
import type { Plugin, ResolvedConfig } from "vite";
import { kiiii, type KiiiiOptions } from "../src/index.ts";
import { routeHash } from "../src/hash.ts";

const ROOT = "/project";
const SERVER_ID = "\0kiiii:server";
const APP_ID = "\0kiiii:app";
const MODULES_ID = "\0kiiii:modules";

function setup(options: Partial<KiiiiOptions> = {}): Plugin {
  const plugin = kiiii({ pattern: "/src/**/*.server.ts", ...options } as KiiiiOptions);
  // Vite 钩子类型是 ObjectHook（函数或 { handler } 对象）——归一化为函数
  void asFn(plugin.configResolved!)({ root: ROOT } as ResolvedConfig);
  return plugin;
}

/**
 * ObjectHook → 函数（Vite 钩子可能是函数或 { handler } 对象）。
 * 返回类型用 Parameters/ReturnType 剥离钩子的 this 约束（测试环境直接调用）。
 */
function asFn<F extends (...args: never[]) => unknown>(
  hook: F | { handler: F },
): (...args: Parameters<F>) => ReturnType<F> {
  const fn = typeof hook === "function" ? hook : hook.handler;
  return fn as (...args: Parameters<F>) => ReturnType<F>;
}

/** resolveId 的插件上下文 mock：把 source 解析为给定绝对路径 */
const mockCtx = (id: string) => ({ resolve: async () => ({ id }) }) as never;

test("pattern 必填校验", () => {
  expect(() => kiiii()).toThrow(/pattern/);
  expect(() => kiiii({ pattern: [] })).toThrow(/pattern/);
});

test("config：serve 命令不返回构建配置", () => {
  expect(asFn(setup().config!)({}, { command: "serve" } as never)).toBeUndefined();
});

test("config：build 命令返回 SSR 构建配置", () => {
  const cfg = asFn(setup().config!)({}, { command: "build" } as never) as {
    build: { ssr: boolean; copyPublicDir: boolean; rolldownOptions: { input: object } };
    ssr: { noExternal: boolean };
  };
  expect(cfg.build.ssr).toBe(true);
  expect(cfg.build.copyPublicDir).toBe(false);
  expect(cfg.build.rolldownOptions.input).toEqual({ index: "kiiii:server", app: "kiiii:app" });
  expect(cfg.ssr.noExternal).toBe(true);
});

test("config：bundleDeps=false 时不传 noExternal", () => {
  const cfg = asFn(setup({ bundleDeps: false }).config!)({}, { command: "build" } as never) as {
    ssr?: unknown;
  };
  expect(cfg.ssr).toBeUndefined();
});

test("resolveId：SSR 解析不拦截（服务端加载原文件）", async () => {
  const plugin = setup();
  expect(
    await asFn(plugin.resolveId!)("greet.server.ts", `${ROOT}/src/main.ts`, {
      ssr: true,
      isEntry: false,
    }),
  ).toBeNull();
});

test("resolveId：无 importer 不拦截", async () => {
  const plugin = setup();
  expect(
    await asFn(plugin.resolveId!)("greet.server.ts", undefined, { isEntry: false }),
  ).toBeNull();
});

test("resolveId：虚拟模块解析（任意解析模式）", async () => {
  const plugin = setup();
  expect(
    await asFn(plugin.resolveId!)("kiiii:server", `${ROOT}/src/main.ts`, {
      ssr: true,
      isEntry: false,
    }),
  ).toBe(SERVER_ID);
  expect(
    await asFn(plugin.resolveId!)("kiiii:app", `${ROOT}/src/main.ts`, {
      ssr: true,
      isEntry: false,
    }),
  ).toBe(APP_ID);
  expect(
    await asFn(plugin.resolveId!)("kiiii:modules", `${ROOT}/src/main.ts`, {
      ssr: true,
      isEntry: false,
    }),
  ).toBe(MODULES_ID);
});

test("resolveId：pattern 命中 → stub 虚拟 id", async () => {
  const plugin = setup();
  const id = await asFn(plugin.resolveId!).call(
    mockCtx(`${ROOT}/src/api/greet.server.ts`),
    "greet.server.ts",
    `${ROOT}/src/main.ts`,
    { isEntry: false },
  );
  expect(id).toBe(`\0kiiii:${routeHash("/src/api/greet.server.ts")}`);
});

test("resolveId：未命中 pattern → null", async () => {
  const plugin = setup();
  const id = await asFn(plugin.resolveId!).call(
    mockCtx(`${ROOT}/src/counter.ts`),
    "counter.ts",
    `${ROOT}/src/main.ts`,
    { isEntry: false },
  );
  expect(id).toBeNull();
});

test("resolveId：root 之外 → null", async () => {
  const plugin = setup();
  const id = await asFn(plugin.resolveId!).call(
    mockCtx("/outside/file.ts"),
    "file.ts",
    `${ROOT}/src/main.ts`,
    { isEntry: false },
  );
  expect(id).toBeNull();
});

test("load：服务器入口生成（导出 app + import.meta.main 条件启动）", () => {
  const code = asFn(setup({ prefix: "api" }).load!)(SERVER_ID) as string;
  expect(code).toContain('import { createKiiiiApp } from "kiiii/server"');
  expect(code).toContain('import { startServer } from "kiiii/node"');
  expect(code).toContain('import modules from "kiiii:modules"');
  expect(code).toContain('export const app = createKiiiiApp({ prefix: "api", modules });');
  expect(code).toContain("if (import.meta.main) await startServer(app);");
});

test("load：平台入口生成（只导出 app，无启动分支）", () => {
  const code = asFn(setup({ prefix: "api" }).load!)(APP_ID) as string;
  expect(code).toContain('import { createKiiiiApp } from "kiiii/server"');
  expect(code).toContain("export default createKiiiiApp");
  expect(code).not.toContain("startServer");
  expect(code).not.toContain("import.meta.main");
});

test("load：模块表生成（pattern 字面量注入）", () => {
  const code = asFn(setup().load!)(MODULES_ID) as string;
  expect(code).toContain('import.meta.glob("/src/**/*.server.ts")');
  expect(code).toContain("buildModuleMap");
});

test("load：pattern 含引号时字面量正确转义", () => {
  const code = asFn(setup({ pattern: '/src/**/*.server."ts"' }).load!)(MODULES_ID) as string;
  expect(code).toContain(JSON.stringify('/src/**/*.server."ts"'));
});

test("load：stub 生成（prefix/route/timeout 注入）", () => {
  const route = routeHash("/src/api/greet.server.ts");
  const code = asFn(setup({ prefix: "api", timeout: 1_000 }).load!)(`\0kiiii:${route}`) as string;
  expect(code).toContain('import { invoke } from "kiiii/client"');
  expect(code).toContain(`invoke("api", "${route}", args, 1000)`);
});
