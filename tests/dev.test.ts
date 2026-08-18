// dev 模式集成测试：真实 Vite dev server（middlewareMode，不开端口）+ watcher 事件驱动验证。
// 覆盖：RPC 往返、新增文件即用、内容修改不重建模块表、删除文件 404。
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "devalue";
import { kiiii } from "../src/plugin.ts";
import { routeHash } from "../src/hash.ts";
import { invoke, cancel } from "../src/client.ts";

const root = join(import.meta.dirname, "fixtures", "dev-app");
const srcDir = join(root, "src", "api");
const tempFile = join(srcDir, "temp.server.ts");
const tempRoute = routeHash("/src/api/temp.server.ts");
const helloRoute = routeHash("/src/api/hello.server.ts");
const slowRoute = routeHash("/src/api/slow.server.ts");
const prefix = "kiiii";

let vite: ViteDevServer;
let httpServer: ReturnType<typeof createHttpServer>;
let base = "";

/** 等待 watcher 事件（先注册监听再写文件，避免竞态） */
function waitFor(event: string, fileName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 watcher ${event} 超时`)), 5_000);
    const on = (file: string) => {
      if (file.endsWith(fileName)) {
        clearTimeout(timer);
        vite.watcher.off(event, on);
        resolve();
      }
    };
    vite.watcher.on(event, on);
  });
}

/** 等效客户端 invoke */
async function call(route: string, expectOk = true): Promise<unknown> {
  const res = await fetch(`${base}/${prefix}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: stringify([]),
  });
  if (!expectOk) return res.status;
  expect(res.ok).toBe(true);
  return parse(await res.text());
}

beforeAll(async () => {
  vite = await createServer({
    root,
    plugins: [kiiii({ pattern: "/src/**/*.server.ts" })],
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  httpServer = createHttpServer(vite.middlewares);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

  // invoke 用相对路径 fetch（浏览器约定）；node 测试环境补 base
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    return origFetch(url as never, init);
  }) as typeof fetch;
});

afterAll(async () => {
  // 清理测试创建的临时文件（若残留）
  try {
    await unlink(tempFile);
  } catch {
    /* 不存在则忽略 */
  }
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await vite.close();
});

test("RPC 往返（初始模块）", async () => {
  expect(await call(helloRoute)).toBe("hello");
});

test("新增文件即用（无需重启）", async () => {
  await writeFile(
    tempFile,
    `export default async function (): Promise<string> { return "temp"; }\n`,
  );
  await waitFor("add", "temp.server.ts");
  expect(await call(tempRoute)).toBe("temp");
});

test("内容修改：新代码生效且不重建模块表", async () => {
  const moduleBefore = vite.moduleGraph.getModuleById(`\0${prefix}:modules`)?.transformResult;

  const changed = waitFor("change", "temp.server.ts");
  await writeFile(
    tempFile,
    `export default async function (): Promise<string> { return "temp2"; }\n`,
  );
  await changed;

  expect(await call(tempRoute)).toBe("temp2");

  // watcher 优化验证：内容修改不应 invalidate 模块表（transformResult 引用不变）
  const moduleAfter = vite.moduleGraph.getModuleById(`\0${prefix}:modules`)?.transformResult;
  expect(moduleAfter).toBe(moduleBefore);
});

test("删除文件：旧路由 404", async () => {
  const removed = waitFor("unlink", "temp.server.ts");
  await unlink(tempFile);
  await removed;
  expect(await call(tempRoute, false)).toBe(404);
});

test("超时：invoke 超时后 reject（TimeoutError）", async () => {
  await expect(invoke(prefix, slowRoute, [10], 200)).rejects.toMatchObject({
    name: "TimeoutError",
  });
});

test("主动取消：cancel(promise) 使调用 reject", async () => {
  const promise = invoke(prefix, slowRoute, [10], 0);
  cancel(promise, "用户取消了");
  await expect(promise).rejects.toBeDefined();
});

test("取消与超时不产生 [kiiii] 错误日志（预期行为静默）", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
    original(...args);
  };
  try {
    const promise = invoke(prefix, slowRoute, [10], 0);
    cancel(promise, "用户取消了");
    await promise.catch(() => {});
    await invoke(prefix, slowRoute, [10], 200).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等服务端处理完
    expect(errors.filter((args) => String(args[0]).includes("[kiiii]"))).toHaveLength(0);
  } finally {
    console.error = original;
  }
});
