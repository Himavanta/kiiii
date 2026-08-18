/**
 * 路由哈希：FNV-1a 32 位 → 36 进制短串。
 * 确定性、纯 JS、无依赖——dev 模块表、客户端 stub、生产模块表三端共用同一实现、
 * 同一输入（相对项目 root 的完整路径），保证端点一致。
 */
export function routeHash(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
