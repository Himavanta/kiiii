# kiiii

kiiii is a Vite plugin that turns server-side functions into directly callable client-side proxies. Write functions in files (conventionally `*.server.ts`), import them from client code, and the plugin rewrites those imports into fetch calls at build time. Types come from the original file signatures — no extra type definitions. Built on [h3](https://h3.unjs.io/) 2.0, dev and production share the same protocol: [devalue](https://github.com/Rich-Harris/devalue) serialization, `KiiiiError` business-error envelopes, cancellation, and timeouts.

kiiii 是一个 Vite 插件，把服务端函数变成客户端可直接调用的代理。函数写在普通文件里（惯例为 `*.server.ts`），客户端直接 import 调用——插件在构建时把 import 改写为 fetch 调用。类型来自原文件签名——无需额外类型定义。基于 [h3](https://h3.unjs.io/) 2.0，dev 与生产共用同一协议：[devalue](https://github.com/Rich-Harris/devalue) 序列化、`KiiiiError` 业务错误信封、取消、超时。

## Quick Start / 快速开始

### 1. Install / 安装

```bash
npm install kiiii
```

### 2. Configure the plugin / 配置插件

Register the plugin in `vite.config.ts`. The `pattern` option is required — it decides which files are server functions: client imports that match the pattern are rewritten into remote calls. File names are free; the pattern is the only constraint (`.server.ts` below is just a convention).

在 `vite.config.ts` 注册插件。`pattern` 选项必填——它决定哪些文件是服务器函数：客户端 import 命中 pattern 的文件会被改写为远程调用。文件名随便起；pattern 是唯一约束（下文 `.server.ts` 只是惯例）。

```ts
// vite.config.ts
import { kiiii } from "kiiii";

export default defineConfig({
  plugins: [kiiii({ pattern: "/src/**/*.server.ts" })],
});
```

### 3. Write a server function / 写服务端函数

Write the function as a default export in a file matching the pattern:

在命中 pattern 的文件里写默认导出的函数：

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

Import the server function from client code and call it like a local function. The type comes from the original file signature — no extra type definitions.

在客户端代码里 import 服务端函数，像调用本地函数一样调用。类型来自原文件签名——无需额外类型定义。

```ts
// main.ts
import greet from "./api/greet.server.ts";

const result = await greet("World");
```

### 5. Throw business errors / 抛出业务错误

Business errors thrown on the server arrive at the client as a `KiiiiError` — `message`, `code`, and `data` survive the network. Unexpected errors never leak details in production. Import the helpers from `kiiii/error`:

服务端显式抛出的业务错误以 `KiiiiError` 形态到达客户端——`message`、`code`、`data` 跨网络保真。意外错误在生产环境不泄漏任何细节。辅助函数从 `kiiii/error` 导入：

```ts
// Any module / 任何模块
import { KiiiiError, isKiiiiError } from "kiiii/error";
```

## Call Context / 调用上下文

Every call carries a context: an `AbortSignal` (fires on connection drop, timeout, or client-side cancel) and the raw h3 event. The dispatcher injects it through `this` — read it with an optional `this` parameter:

每次调用都携带上下文：一个 `AbortSignal`（连接断开、超时或客户端主动取消时触发）和原始 h3 事件。分发器通过 `this` 注入——用可选的 `this` 参数读取：

```ts
// src/api/greet.server.ts
import type { KiiiiContext } from "kiiii/server";

export default async function greet(this: unknown, name: string): Promise<string> {
  const ctx = this as KiiiiContext;
  ctx.signal.throwIfAborted(); // exit early when cancelled / 取消时提前退出
  return `Hello ${name}!`;
}
```

`this: unknown` means client calls need no special syntax and still type-check — a strict `this` type would make TypeScript reject plain calls like `greet("World")`. One assertion inside the function recovers the full context type; the body stays a plain function. The signal fires when the connection drops, the client times out, or the client actively cancels. Cancellation is cooperative: call `throwIfAborted()` at safe points — a function that never checks the signal cannot be interrupted. The `event` field is the raw [h3 event](https://h3.unjs.io/guide/event) — read request, headers, and cookies through it (see the h3 docs for the full API).

`this: unknown` 让客户端调用不需要任何特殊语法，类型也不会报错——严格的 this 类型会使 TS 拒绝 `greet("World")` 这样的普通调用。函数内的一次断言恢复完整的上下文类型；函数体保持普通函数形态。信号在连接断开、客户端超时或客户端主动取消时触发。取消是协作式的：在安全点调用 `throwIfAborted()`——从不检查信号的函数无法被中断。`event` 字段是原始 [h3 事件](https://h3.unjs.io/guide/event)——通过它读 request、headers、cookies（完整 API 见 h3 文档）。

## Serialization / 序列化

Arguments and return values are serialized with devalue, not JSON. The wire format keeps types that JSON silently destroys or rejects:

参数与返回值用 devalue 序列化，不是 JSON。JSON 会静默破坏或拒绝的类型，这里完整保留：

- `Date`, `Map`, `Set`, `URL`, `ArrayBuffer`: restored as real instances. JSON turns them into strings or `{}` instead.
- `BigInt`, `undefined`, `NaN`, `Infinity`, `-0`: round-trip exactly. JSON destroys them or throws.
- Circular references: preserved with shared identity. JSON throws.
- Nested structures: any combination of the above, at any depth.

- `Date`、`Map`、`Set`、`URL`、`ArrayBuffer`：还原为真实实例。JSON 会把它们变成字符串或 `{}`。
- `BigInt`、`undefined`、`NaN`、`Infinity`、`-0`：精确往返。JSON 会破坏它们或抛错。
- 循环引用：保留且保共享引用。JSON 会抛错。
- 嵌套结构：以上任意组合、任意深度。

The costs: the payload is not standard JSON (Content-Type is `text/plain`), only devalue-serializable values are allowed (functions and unregistered class instances throw on the sending side), and serialization is slightly slower than JSON (imperceptible for small payloads). [devalue](https://github.com/Rich-Harris/devalue) is maintained by the Svelte team and used in production by SvelteKit; custom class instances need a reducer/reviver registered on both ends.

代价：报文不是标准 JSON（Content-Type 为 `text/plain`）；只允许 devalue 可序列化的值（函数与未注册的类实例在发送端抛错）；序列化略慢于 JSON（小数据无感）。[devalue](https://github.com/Rich-Harris/devalue) 由 Svelte 团队维护，SvelteKit 生产环境在用；自定义类实例需要在两端登记 reducer/reviver。

## Deployment / 部署

One `vp build` produces two output trees: `dist/public/` (client assets — served by the platform or the self-hosted server) and `dist/server/` (server entries: `start.js` for self-hosting, `index.js` the stateless app for platforms). The stateless app only handles remote calls — static assets and history-route fallback are the platform's job.

一次 `vp build` 产出两个产物目录：`dist/public/`（客户端资源——由平台或自托管服务器服务）与 `dist/server/`（服务器入口：`start.js` 自托管用、`index.js` 是给平台的无状态 app）。无状态 app 只处理远程调用——静态资源与 history 路由回退由平台负责。

**Self-hosted (default) / 自托管（默认）：**

```bash
vp build
node dist/server/start.js   # one port: remote calls + static + SPA fallback
PORT=8080 node dist/server/start.js   # custom port
```

**Platform deployment (Vercel, Node Functions) / 平台部署（以 Vercel Node Functions 为例）：**

Platform entries are plain files in your project — the plugin never generates them, since every platform has its own conventions. For Vercel, import the built app and hand it to the platform's runtime, then configure the build command, the static output directory, and the rewrites (RPC → function, SPA fallback) in `vercel.json`:

平台入口是项目里的普通文件——插件不生成它们，因为各平台约定不同。以 Vercel 为例：把构建好的 app 交给平台运行时，再在 `vercel.json` 里配置构建命令、静态产物目录与重写规则（RPC → 函数，SPA fallback）：

```js
// api/index.js — hand the built app to the platform
import { toNodeHandler } from "h3/node";
import app from "../dist/server/index.js";

export default toNodeHandler(app);
```

```json
// vercel.json — build command, static output, rewrites (RPC → function, SPA fallback)
{
  "buildCommand": "pnpm build",
  "outputDirectory": "dist/public",
  "rewrites": [
    { "source": "/kiiii/(.*)", "destination": "/api/index" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

**Cloudflare Workers (Web runtime) / Cloudflare Workers（Web 运行时）：**

The stateless entry does not depend on Node-specific APIs, and h3's web adapter resolves for the `workerd` condition — loading and remote calls verified under `node --conditions=workerd` (a local simulation). A real Cloudflare deploy has not been tested yet; `wrangler` may require tweaks.

无状态入口不依赖 Node 专属 API，h3 的 web 适配按 `workerd` 条件解析——已在 `node --conditions=workerd` 下本地模拟验证加载与远程调用。真实 Cloudflare 部署尚未实测；`wrangler` 可能需要调整。

```js
// worker.js
import { toWebHandler } from "h3";
import app from "./dist/server/index.js";

export default {
  fetch: toWebHandler(app),
};
```

## Options / 选项

- **`pattern`** (required / 必填)

  Glob pattern or array of patterns, relative to the project root. Files matching it become server functions: client imports of these files are rewritten into remote calls. Directories and suffixes are fully open — the plugin does no derivation.

  glob pattern 或 pattern 数组（相对项目 root）。命中 pattern 的文件是服务器函数：客户端 import 它们会被改写为远程调用。目录与后缀完全放开——插件不做任何推导。

- **`prefix`** (optional / 可选)

  URL prefix for the endpoints. Defaults to `"kiiii"` — endpoints look like `/kiiii/{hash}`.

  URL 前缀。默认为 `"kiiii"`——端点形如 `/kiiii/{hash}`。

- **`timeout`** (optional / 可选)

  Client call timeout in milliseconds. Defaults to `30000`. Set to `0` to disable.

  客户端调用超时（毫秒）。默认为 `30000`。设为 `0` 关闭。

- **`bundleDeps`** (optional / 可选)

  Whether to bundle all dependencies into the server output for self-contained deployment. Defaults to `true`. When `false`, dependencies stay external and are resolved from `node_modules` at runtime. Bundling makes the output self-contained at the cost of size (the h3/listhen runtime is included); external mode keeps the output small but requires installing `dependencies` on the deployment host.

  服务器产物是否打包全部依赖（自包含部署）。默认为 `true`。为 `false` 时依赖保持 external——运行时从 `node_modules` 解析。打包让产物自包含，代价是体积（h3/listhen 运行时全量打入）；external 模式产物更小，但部署环境需安装 `dependencies`。

## Package Entries / 入口

| Entry / 入口   | Contents / 内容                                                                                            | Used by / 使用方                           |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `kiiii`        | Vite plugin — `kiiii`, `KiiiiOptions`                                                                      | `vite.config.ts`                           |
|                | Vite 插件——`kiiii`、`KiiiiOptions`                                                                         | `vite.config.ts`                           |
| `kiiii/server` | `KiiiiContext`, `createKiiiiApp`, `createKiiiiHandler`, `buildModuleMap`, `routeHash` — cross-runtime core | Server function files, generated code      |
|                | `KiiiiContext`、`createKiiiiApp`、`createKiiiiHandler`、`buildModuleMap`、`routeHash`——跨运行时核心        | 服务器函数文件、生成代码                   |
| `kiiii/node`   | `createKiiiiServer`, `startServer` — self-hosted startup (Node-only)                                       | `node dist/server/start.js`, custom server |
|                | `createKiiiiServer`、`startServer`——自托管启动（Node 专属）                                                | `node dist/server/start.js`、自定义服务器  |
| `kiiii/client` | `invoke`, `cancel`                                                                                         | Generated stubs, manual cancellation       |
|                | `invoke`、`cancel`                                                                                         | 生成 stub、手动取消                        |
| `kiiii/error`  | `KiiiiError`, `isKiiiiError` — cross-end public entry, zero dependencies                                   | Any module                                 |
|                | `KiiiiError`、`isKiiiiError`——跨端公共入口，零依赖                                                         | 任何模块                                   |

## Build Integration / 构建集成

The plugin declares two environments (Vite 8 environment model): `server` (plugin-managed: SSR + virtual entries, output in `{outDir}/server`) and `client` (yours: only `outDir` is redirected to `{outDir}/public`). Everything else in your config (plugins, alias, css, resolve, base, publicDir, inputs) is inherited unchanged. Your `build.outDir` is the output root.

插件声明两个环境（Vite 8 环境模型）：`server`（插件管理：SSR + 虚拟入口，产物在 `{outDir}/server`）和 `client`（你的：只把 `outDir` 重定向到 `{outDir}/public`）。配置里的其余一切（plugins、alias、css、resolve、base、publicDir、input）原样继承。你的 `build.outDir` 是产物根。

## Trade-offs and Limits / 取舍与边界

- Endpoints are path hashes: the network tab shows `/kiiii/{hash}`, and you cannot tell which function a URL belongs to. The file name is the public API surface — renaming a file changes its route.
- Dev and production run the same code: one virtual module, transformed at runtime in dev (new files work immediately) and expanded into lazy chunks at build time. No environment behavior split.
- No server entry file to write — the plugin generates it (remote calls + static assets + SPA fallback + listening, one port). Platform entries are a few lines in your project, since every platform has its own conventions.

- 端点是路径哈希：network tab 里显示 `/kiiii/{hash}`，从 URL 看不出属于哪个函数。文件名就是公开 API——改名会改路由。
- dev 与生产跑同一份代码：同一个虚拟模块，dev 下运行时转换（新增文件即用），生产构建期展开为 lazy chunks。环境之间没有行为分叉。
- 不用写服务器入口文件——插件生成它（远程调用 + 静态资源 + SPA fallback + 监听，单端口）。平台入口是项目里的几行文件，因为各平台约定不同。

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
node dist/server/start.js   # run the production build (single port)
```
