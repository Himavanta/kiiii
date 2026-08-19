// 集成测试：远程调用类型传输保真（devalue 全链路：客户端 stringify → 服务端 parse → 回显 → 客户端 parse）
// 用 h3 app + createKiiiiHandler 内存起服（随机端口），fetch 直调，不经真实网络端口冲突。
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { H3 } from "h3";
import { toNodeHandler } from "h3/node";
import { parse, stringify } from "devalue";
import { createKiiiiHandler } from "../src/server.ts";
import { routeHash } from "../src/modules.ts";

const prefix = "kiiii";
const route = routeHash("/tests/fixtures/echo.server.ts");
const failRoute = routeHash("/tests/fixtures/fail.server.ts");
const modules = {
  [route]: () => import("./fixtures/echo.server.ts"),
  [failRoute]: () => import("./fixtures/fail.server.ts"),
};

let base = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const app = new H3();
  app.use(`/${prefix}/**`, createKiiiiHandler({ modules, prefix, isDev: false }));
  server = createServer(toNodeHandler(app));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

/** 等效客户端 invoke：devalue 编码参数数组 → POST → devalue 解码响应 */
async function invoke(value: unknown): Promise<unknown> {
  const res = await fetch(`${base}/${prefix}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: stringify([value]),
  });
  expect(res.ok).toBe(true);
  return parse(await res.text());
}

async function invokeFail(): Promise<unknown> {
  const res = await fetch(`${base}/${prefix}/${failRoute}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: stringify([]),
  });
  expect(res.ok).toBe(true); // 业务错误走 200 + 信封
  return parse(await res.text());
}

test("基本类型传输", async () => {
  expect(await invoke("hello")).toBe("hello");
  expect(await invoke(42)).toBe(42);
  expect(await invoke(true)).toBe(true);
  expect(await invoke(null)).toBeNull();
  expect(await invoke(undefined)).toBeUndefined();
});

test("Date 毫秒级还原", async () => {
  const result = await invoke(new Date("2024-06-01T12:00:00.000Z"));
  expect(result).toBeInstanceOf(Date);
  expect((result as Date).getTime()).toBe(1717243200000);
});

test("Map / Set 实例还原", async () => {
  const map = await invoke(
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
  );
  expect(map).toBeInstanceOf(Map);
  expect((map as Map<string, number>).get("a")).toBe(1);
  expect((map as Map<string, number>).get("b")).toBe(2);

  const set = await invoke(new Set([1, 2, 3]));
  expect(set).toBeInstanceOf(Set);
  expect((set as Set<number>).has(3)).toBe(true);
  expect((set as Set<number>).size).toBe(3);
});

test("BigInt 大数精确", async () => {
  const result = await invoke(12345678901234567890n);
  expect(typeof result).toBe("bigint");
  expect(result).toBe(12345678901234567890n);
});

test("NaN / Infinity / -Infinity / -0 保真", async () => {
  expect(await invoke(NaN)).toBeNaN();
  expect(await invoke(Infinity)).toBe(Infinity);
  expect(await invoke(-Infinity)).toBe(-Infinity);
  expect(Object.is(await invoke(-0), -0)).toBe(true);
});

test("深层嵌套结构（Date 在深层、Map 值含 Set）", async () => {
  const value = {
    nested: {
      deep: [1, "x", { d: new Date("2020-01-01") }],
      m: new Map([["k", new Set([1])]]),
    },
  };
  const result = (await invoke(value)) as typeof value;
  expect(result.nested.deep[0]).toBe(1);
  expect((result.nested.deep[2] as { d: Date }).d).toBeInstanceOf(Date);
  expect(result.nested.m.get("k")).toBeInstanceOf(Set);
});

test("循环引用（共享引用保真）", async () => {
  const cyclic: Record<string, unknown> = { name: "cycle" };
  cyclic.self = cyclic;
  const result = (await invoke(cyclic)) as Record<string, unknown>;
  expect(result.self).toBe(result);
});

test("ArrayBuffer 字节还原", async () => {
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const result = await invoke(buf);
  expect(result).toBeInstanceOf(ArrayBuffer);
  expect(new Uint8Array(result as ArrayBuffer)[1]).toBe(2);
});

test("URL 实例还原", async () => {
  const result = await invoke(new URL("https://example.com/path?q=1"));
  expect(result).toBeInstanceOf(URL);
  expect((result as URL).href).toBe("https://example.com/path?q=1");
});

test("业务错误信封：KiiiiError 跨网络还原（message/code/data 保真）", async () => {
  const envelope = (await invokeFail()) as {
    ok: false;
    name: string;
    message: string;
    code: string;
    data: { at: Date };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.name).toBe("KiiiiError");
  expect(envelope.message).toBe("业务失败");
  expect(envelope.code).toBe("BUSINESS_FAIL");
  // data 复杂类型保真（Date 实例还原）
  expect(envelope.data.at).toBeInstanceOf(Date);
  expect(envelope.data.at.getTime()).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
});
