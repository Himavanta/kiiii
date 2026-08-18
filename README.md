# kiiii

类 Server Actions 的 RPC 工具：服务器函数写在普通文件里（默认约定 `*.server.ts`），
客户端直接 `import` 调用——Vite 插件自动把它转换为 fetch 调用，类型零成本（来自原文件签名）。

基于 h3 2.0 + Vite，dev / 生产共用同一协议（devalue 传输、RpcError 业务错误信封、取消、超时）。

## 使用

```ts
// vite.config.ts
import { rpc } from "kiiii";

export default defineConfig({
  plugins: [rpc({ pattern: "/src/**/*.server.ts" })],
});
```

```ts
// src/api/greet.server.ts —— 服务端函数（文件即函数，默认导出）
import { RpcError } from "kiiii/shared"; // 错误协议（两端共用）
import type { RpcContext } from "kiiii/server";

export default async function greet(name: string): Promise<string> {
  if (!name) throw new RpcError("名字不能为空", "EMPTY_NAME");
  return `Hello ${name}!`;
}
```

```ts
// 客户端：与普通函数调用无区别（类型来自原文件签名）
import greet from "./api/greet.server.ts";
const result = await greet("World");
```

## 特性

- **pattern 是唯一事实来源**：目录/后缀完全放开，支持数组（多重匹配）；插件不做任何
  后缀/目录推导，匹配交给 glob，路由 = 完整路径哈希（匿名、稳定、绝对正确）
- **dev / 生产一致**：同一虚拟模块（`import.meta.glob`），dev 运行时转换（无目录扫描、
  新增文件即用），生产构建期展开为 lazy chunks
- **无服务器入口文件**：生产服务器入口由插件生成（h3：RPC + 静态资源 + SPA fallback +
  listhen 单端口）；构建 `vp build` 一个命令完成服务器 + 客户端两个环境
- **自包含部署**：依赖默认全量打包进服务器产物（`bundleDeps: false` 可切换为 external）
- **业务错误协议**：RpcError 跨网络还原（200 + 信封），意外错误不泄漏

## 选项

| 选项         | 默认    | 说明                                          |
| ------------ | ------- | --------------------------------------------- |
| `pattern`    | 必填    | glob pattern 或数组，决定哪些文件是服务器模块 |
| `prefix`     | `"rpc"` | URL 前缀（端点形如 `/rpc/{hash}`）            |
| `timeout`    | `30000` | 客户端调用超时（毫秒），`0` 关闭              |
| `bundleDeps` | `true`  | 服务器产物是否打包全部依赖（自包含部署）      |

## 开发

```bash
vp pack          # 构建包（dist/）
vp test          # 单元测试
vp check         # lint + format + type

cd packages/example
pnpm dev         # 示例应用 dev（RPC + HMR）
pnpm build       # 示例构建（服务器 + 客户端）
node dist/index.js   # 运行构建产物（RPC + 静态资源，单端口 3000）
```
