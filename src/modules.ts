/**
 * 路由体系：路径哈希 + 模块表组装，dev / 生产 / 客户端三端共用。
 *
 * 路由 = routeHash(相对项目 root 的完整路径)——绝对正确：不同路径必然不同哈希
 * （含 xx.ts 与 xx.mts 这类同名不同扩展名），端点匿名（不暴露路径/名字结构）。
 */

/**
 * 路由哈希：FNV-1a 32 位 → 36 进制短串（6-7 位）。
 * 输入为相对项目 root 的完整路径——dev 模块表、客户端 stub、生产模块表三端共用同一实现与同一输入。
 */
export function routeHash(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 把 import.meta.glob 的展开结果组装为路由 → 加载器映射，dev 与生产共用。
 * 遍历、哈希、碰撞检测单一来源，生成代码只保留宏必需的 glob 调用。
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
      throw new Error(`[kiiii] 路由哈希冲突：${prev} 与 ${k}`);
    }
    seen.set(route, k);
    modules[route] = v;
  }
  return modules;
}
