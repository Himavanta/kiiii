# kiiii

kiiii is a Vite plugin that turns server-side functions into directly callable client-side proxies. You write functions in files (conventionally `*.server.ts`) and import them from client code — the plugin rewrites those imports into fetch calls at build time. Types come from the original file signatures, so no extra type definitions are needed.

kiiii 是一个 Vite 插件，把服务端函数变成客户端可直接调用的代理。函数写在普通文件里（惯例为 `*.server.ts`），客户端直接 import 调用——插件在构建时把 import 改写为 fetch 调用。类型来自原文件签名，无需额外类型定义。

Built on [h3](https://h3.unjs.io/) 2.0 and Vite. Dev and production share the same protocol: [devalue](https://github.com/Rich-Harris/devalue) serialization, `KiiiiError` business-error envelopes, cancellation, and timeouts.

基于 [h3](https://h3.unjs.io/) 2.0 + Vite。dev 与生产共用同一协议：[devalue](https://github.com/Rich-Harris/devalue) 序列化、`KiiiiError` 业务错误信封、取消、超时。

## Quick Start / 快速开始

### 1. Install / 安装

```bash
npm install kiiii
```

kiiii requires Vite as a peer dependency.

kiiii 以 Vite 为 peer 依赖。

### 2. Configure the plugin / 配置插件

```ts
// vite.config.ts
import { kiiii } from "kiiii";

export default defineConfig({
  plugins: [kiiii({ pattern: "/src/**/*.server.ts" })],
});
```

The `pattern` option is required. It decides which files are server modules: client imports that match the pattern are rewritten into remote calls. File names are completely free — the pattern is the only constraint (`.server.ts` below is just a convention).

`pattern` 选项必填。它决定哪些文件是服务器模块：客户端 import 命中 pattern 的文件会被改写为远程调用。文件名完全自由——pattern 是唯一约束（下文 `.server.ts` 只是惯例）。

### 3. Write a server function / 写服务端函数

```ts
// src/api/greet.server.ts
import { KiiiiError } from "kiiii/error";

export default async function greet(name: string): Promise<string> {
  if (!name) throw new KiiiiError("名字不能为空", "EMPTY_NAME");
  return `Hello ${name}!`;
}
```

- The file matches the configured `pattern`.
- The function is a default export and must be async.
- Arguments and return values must be serializable (devalue). See [Serialization / 序列化](#serialization--序列化).

- 文件命中配置的 `pattern`。
- 函数为默认导出，且必须为 async。
- 参数与返回值必须可序列化（devalue）。见 [Serialization / 序列化](#serialization--序列化)。

### 4. Call it from the client / 客户端调用

```ts
// main.ts
import greet from "./api/greet.server.ts";

const result = await greet("World");
```

Calling a server function looks exactly like calling a local one. The type comes from the original file signature.

调用服务端函数与调用本地函数无异。类型来自原文件签名。

### 5. Throw business errors / 抛出业务错误

Business errors thrown on the server arrive at the client as a `KiiiiError` — `message`, `code`, and `data` are preserved across the network. Unexpected errors never leak details in production.

服务端显式抛出的业务错误以 `KiiiiError` 形态到达客户端——`message`、`code`、`data` 跨网络保真。意外错误在生产环境不泄漏任何细节。

```ts
// Any module / 任何模块
import { KiiiiError, isKiiiiError } from "kiiii/error";
```

## Call Context / 调用上下文

Every call carries a context: an `AbortSignal` for cancellation (connection drop, timeout, or client-side cancel) and the raw h3 event. The dispatcher injects it through `this` — read it with the optional `this` parameter:

每次调用携带上下文：用于取消的 `AbortSignal`（连接断开、超时或客户端主动取消）和原始 h3 事件。分发器通过 `this` 注入——用可选的 `this` 参数读取：

```ts
// src/api/greet.server.ts
import type { KiiiiContext } from "kiiii/server";

export default async function greet(this: unknown, name: string): Promise<string> {
  const ctx = this as KiiiiContext;
  ctx.signal.throwIfAborted(); // exit early when cancelled / 取消时提前退出
  return `Hello ${name}!`;
}
```

The `this: unknown` signature keeps client-side calls free of type errors — a strict `this` type would make TypeScript reject plain calls like `greet("World")`. The single assertion inside the function recovers the full context type; the function body is otherwise identical to a plain function.

`this: unknown` 的签名让客户端普通调用不报类型错误——严格的 this 类型会使 TS 拒绝 `greet("World")` 这样的调用。函数内的一次断言恢复完整的上下文类型；除此之外函数体与普通函数无异。

The signal fires when the connection drops, the client times out, or the client actively cancels. Cancellation is cooperative: call `throwIfAborted()` at safe points to exit early — a function that never checks the signal cannot be interrupted.

信号在连接断开、客户端超时或客户端主动取消时触发。取消是协作式的：在安全点调用 `throwIfAborted()` 提前退出——从不检查信号的函数无法被中断。

The `event` field is the raw [h3 event](https://h3.unjs.io/guide/event) — access request, headers, and cookies through it. Refer to the h3 docs for the full API.

`event` 字段是原始 [h3 事件](https://h3.unjs.io/guide/event)——通过它访问 request、headers、cookies。完整 API 见 h3 文档。

## Serialization / 序列化

Arguments and return values travel with devalue — not JSON. The wire format preserves types that JSON silently destroys or rejects:

参数与返回值用 devalue 传输——不是 JSON。JSON 会静默破坏或拒绝的类型，这里完整保留：

- `Date`, `Map`, `Set`, `URL`, `ArrayBuffer`: restored as real instances. JSON turns them into strings or `{}` instead.
- `BigInt`, `undefined`, `NaN`, `Infinity`, `-0`: round-trip exactly. JSON destroys them or throws.
- Circular references: preserved with shared identity. JSON throws.
- Nested structures: any combination of the above, at any depth.

- `Date`、`Map`、`Set`、`URL`、`ArrayBuffer`：还原为真实实例。JSON 会把它们变成字符串或 `{}`。
- `BigInt`、`undefined`、`NaN`、`Infinity`、`-0`：精确往返。JSON 会破坏它们或抛错。
- 循环引用：保留且保共享引用。JSON 会抛错。
- 嵌套结构：以上任意组合、任意深度。

The trade-offs: the payload is not standard JSON (Content-Type is `text/plain`), and only devalue-serializable values are allowed — functions and unregistered class instances throw explicitly on the sending side.

代价：报文不是标准 JSON（Content-Type 为 `text/plain`），且只允许 devalue 可序列化的值——函数与未注册的类实例在发送端显式抛错。

[devalue](https://github.com/Rich-Harris/devalue) is maintained by the Svelte team and used in production by SvelteKit. Custom class instances need a reducer/reviver registered on both ends; serialization is slightly slower than JSON (imperceptible for small payloads).

[devalue](https://github.com/Rich-Harris/devalue) 由 Svelte 团队维护，SvelteKit 生产环境在用。自定义类实例需要在两端登记 reducer/reviver；序列化性能略低于 JSON（小数据无感）。

## Package Entries / 入口约定

| Entry / 入口   | Contents / 内容                                                                                            | Used by / 使用方                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `kiiii`        | Vite plugin — `kiiii`, `KiiiiOptions`                                                                      | `vite.config.ts`                      |
|                | Vite 插件——`kiiii`、`KiiiiOptions`                                                                         | `vite.config.ts`                      |
| `kiiii/server` | `KiiiiContext`, `createKiiiiApp`, `createKiiiiHandler`, `buildModuleMap`, `routeHash` — cross-runtime core | Server function files, generated code |
|                | `KiiiiContext`、`createKiiiiApp`、`createKiiiiHandler`、`buildModuleMap`、`routeHash`——跨运行时核心        | 服务器函数文件、生成代码              |
| `kiiii/node`   | `createKiiiiServer`, `startServer` — self-hosted startup (Node-only)                                       | `node dist/start.js`, escape hatch    |
|                | `createKiiiiServer`、`startServer`——自托管启动（Node 专属）                                                | `node dist/start.js`、逃生舱          |
| `kiiii/client` | `invoke`, `cancel`                                                                                         | Generated stubs, manual cancellation  |
|                | `invoke`、`cancel`                                                                                         | 生成 stub、手动取消                   |
| `kiiii/error`  | `KiiiiError`, `isKiiiiError` — cross-end public entry, zero dependencies                                   | Any module                            |
|                | `KiiiiError`、`isKiiiiError`——跨端公共入口，零依赖                                                         | 任何模块                              |

## Options / 选项

- **`pattern`** (required / 必填)

  Glob pattern or array of patterns, relative to the project root. Files matching it are treated as server modules: client imports of these files are rewritten into remote calls. Directories and suffixes are fully open — the plugin does no derivation.

  glob pattern 或 pattern 数组（相对项目 root）。命中 pattern 的文件是服务器模块：客户端 import 它们会被改写为远程调用。目录与后缀完全放开——插件不做任何推导。

- **`prefix`** (optional / 可选)

  URL prefix for the endpoints. Defaults to `"kiiii"` — endpoints look like `/kiiii/{hash}`.

  URL 前缀。默认为 `"kiiii"`——端点形如 `/kiiii/{hash}`。

- **`timeout`** (optional / 可选)

  Client call timeout in milliseconds. Defaults to `30000`. Set to `0` to disable.

  客户端调用超时（毫秒）。默认为 `30000`。设为 `0` 关闭。

- **`bundleDeps`** (optional / 可选)

  Whether to bundle all dependencies into the server output for self-contained deployment. Defaults to `true`. When `false`, dependencies stay external and are resolved from `node_modules` at runtime.

  服务器产物是否打包全部依赖（自包含部署）。默认为 `true`。为 `false` 时依赖保持 external——运行时从 `node_modules` 解析。

  Bundling makes the output self-contained at the cost of size (the h3/listhen runtime is included). External mode keeps the output small but requires installing `dependencies` on the deployment host.

  打包让产物自包含，代价是体积（h3/listhen 运行时全量打入）。external 模式产物更小，但部署环境需安装 `dependencies`。

## Features / 特性

- The `pattern` option is the single source of truth — no suffix or directory derivation. Matching is delegated to glob, and the route is a hash of the full path: anonymous, stable, and absolutely correct (different paths never collide). The trade-off: endpoints look like `/kiiii/{hash}` in the network tab.
- Dev and production share the same code path — the same virtual module (`import.meta.glob`), transformed at runtime in dev (no directory scanning; new files work immediately) and expanded into lazy chunks at build time in production.
- No server entry file: the production server entry is generated by the plugin (h3: remote calls + static assets + SPA fallback + listhen, single port). One `vp build` produces both server and client environments.
- Self-contained deployment: dependencies are bundled into the server output by default (`bundleDeps: false` switches to external).
- Business-error protocol: `KiiiiError` is restored across the network (200 + envelope); unexpected errors never leak.

- `pattern` 是唯一事实来源——不做后缀/目录推导。匹配交给 glob，路由 = 完整路径哈希：匿名、稳定、绝对正确（不同路径必然不同哈希）。代价：network tab 里的端点形如 `/kiiii/{hash}`，不可读。
- dev 与生产共用同一份代码——同一虚拟模块（`import.meta.glob`），dev 下运行时转换（无目录扫描；新增文件即用），生产构建期展开为 lazy chunks。
- 无服务器入口文件：生产服务器入口由插件生成（h3：远程调用 + 静态资源 + SPA fallback + listhen，单端口）。一个 `vp build` 完成服务器 + 客户端两个环境。
- 自包含部署：依赖默认全量打包进服务器产物（`bundleDeps: false` 切换为 external）。
- 业务错误协议：`KiiiiError` 跨网络还原（200 + 信封）；意外错误不泄漏。

## Deployment / 部署

Two entry artifacts are produced by one `vp build`: `dist/start.js` (self-hosted: wraps `index` — app + static + listen) and `dist/index.js` (the platform entry: exports the stateless app). The stateless app only handles remote calls — static assets and history-route fallback are the platform's job (Vercel `public`, Cloudflare assets, etc.). Running `node dist/index.js` directly exits silently (it never starts a server).

一次 `vp build` 产出两个入口产物：`dist/start.js`（自托管：`index` 的封装——app + 静态 + 监听）与 `dist/index.js`（平台入口：导出无状态 app）。无状态 app 只处理远程调用——静态资源与 history 路由回退由平台负责（Vercel `public`、Cloudflare assets 等）。直接运行 `node dist/index.js` 会静默退出（它不启动任何服务器）。

**Self-hosted (default):**

**自托管（默认）：**

```bash
vp build
node dist/start.js   # single port: remote calls + static + SPA fallback
PORT=8080 node dist/start.js   # custom port
```

**Platform deployment (Vercel, Node Functions):**

**平台部署（以 Vercel Node Functions 为例）：**

```js
// api/index.js — import the built app and hand it to the platform
import { toNodeHandler } from "h3/node";
import app from "../dist/index.js";

export default toNodeHandler(app);
```

The platform entry is a plain file in your project (a few lines) — the plugin never generates it, since every platform has its own conventions.

平台入口是项目里的普通文件（几行代码）——插件不生成它，因为各平台约定不同。

**Cloudflare Workers / EdgeOne (Web runtime):**

**Cloudflare Workers / EdgeOne（Web 运行时）：**

```js
// worker.js
import { toWebHandler } from "h3";
import app from "./dist/index.js";

export default {
  fetch: toWebHandler(app),
};
```

The stateless entry has zero Node dependencies in its chunk graph (verified), and the h3 web adapter resolves via the `workerd` export condition — loading and remote calls verified under `node --conditions=workerd`. A real Cloudflare deploy has not been tested yet; `wrangler` may require config tweaks.

无状态入口的 chunk 依赖图零 node 引用（已实测），h3 的 web 适配经 `workerd` 条件导出解析——已在 `node --conditions=workerd` 下验证加载与远程调用。真实 Cloudflare 部署尚未实测；`wrangler` 可能需少量配置调整。

## Development / 开发

Build, test, and check the package itself:

构建、测试并检查包本身：

```bash
vp pack      # build the package (dist/)
vp test      # run unit tests
vp check     # lint, format, and type-check
```

Run the example app:

运行示例应用：

```bash
cd packages/example
pnpm dev         # example dev server (remote calls + HMR)
pnpm build       # example build (server + client)
node dist/start.js   # run the production build (single port)
```
