// 命名式类型守卫：带类型谓词，让 TS 自动收窄

export const isArray = Array.isArray;

export const isString = (v: unknown): v is string => typeof v === "string";

export const isFunction = (v: unknown): v is (...args: unknown[]) => unknown =>
  typeof v === "function";

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export const isError = (v: unknown): v is Error => v instanceof Error;

export const isNil = (v: unknown): v is null | undefined => v == null;

export const isEmpty = (v: { length: number }): boolean => v.length === 0;
