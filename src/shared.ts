import { isError } from "./guards.ts";

/**
 * 业务错误：服务端显式抛出（new KiiiiError），客户端经网络还原后以同形态错误 reject——
 * 两端共用同一类型与同一守卫（message/code/data 跨网络保真）。
 * 普通 throw 的 Error 属于意外错误，生产环境不泄漏任何细节。
 */
export class KiiiiError extends Error {
  code?: string;
  data?: unknown;

  constructor(message: string, code?: string, data?: unknown) {
    super(message);
    this.name = "KiiiiError";
    this.code = code;
    this.data = data;
  }
}

/**
 * 判断一个错误是否为 KiiiiError（服务端抛出的 / 客户端还原的）。
 * 用 name 品牌判断而非 instanceof：dev 下插件链（配置加载）与 .server.ts 链
 * （ssrLoadModule）会各自加载一份模块，instanceof 跨模块实例会失效。
 */
export function isKiiiiError(error: unknown): error is KiiiiError {
  return isError(error) && error.name === "KiiiiError";
}
