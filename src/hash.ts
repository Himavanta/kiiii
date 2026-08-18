/**
 * 路由哈希：FNV-1a 32 位 → 36 进制短串（6-7 位）。
 * 输入为相对项目 root 的完整路径——绝对正确：不同路径必然不同哈希
 * （含 xx.ts 与 xx.mts 这类同名不同扩展名），端点匿名（不暴露路径/名字结构）。
 * dev 模块表、客户端 stub、生产模块表三端共用同一实现与同一输入。
 */
export function routeHash(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
