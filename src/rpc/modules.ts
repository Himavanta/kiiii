import { routeHash } from "./hash";

/**
 * 把 import.meta.glob 的展开结果组装为路由 → 加载器映射。
 * 由模块表虚拟模块在 dev（Vite 运行时转换）与生产（构建期展开）两端调用——
 * 逻辑单一来源：遍历、哈希、碰撞检测都在这里，生成代码只保留宏必需的 glob 调用。
 * 哈希碰撞（不同路径同哈希，理论上可忽略）在此报错，带完整路径。
 */
export function buildModuleMap(
  globs: Record<string, () => Promise<{ default: unknown }>>,
): Record<string, () => Promise<{ default: unknown }>> {
  const seen = new Map<string, string>();
  const modules: Record<string, () => Promise<{ default: unknown }>> = {};
  for (const [k, v] of Object.entries(globs)) {
    const route = routeHash(k);
    const prev = seen.get(route);
    if (prev) {
      throw new Error(`[fly-rpc] 路由哈希冲突：${prev} 与 ${k}`);
    }
    seen.set(route, k);
    modules[route] = v;
  }
  return modules;
}
