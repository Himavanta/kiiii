/**
 * 路由命名：文件名（第一个点之前）+ "-" + 路径哈希（FNV-1a 32 位 → 36 进制，6-7 位）。
 * 可读（知道是哪个函数）+ 匿名（目录结构不可见、hash 防枚举）+ 稳定（新增文件不影响其他端点）。
 * dev 模块表、客户端 stub、生产模块表三端共用同一实现、同一输入（相对项目 root 的完整路径）。
 */
export function routeName(path: string): string {
  const file = path.split("/").pop() ?? "";
  const name = file.split(".")[0];
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${name}-${(h >>> 0).toString(36)}`;
}
