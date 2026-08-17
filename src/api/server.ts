import { createServerFunction } from "@thednp/rpc/server";

export const sayHi = createServerFunction("say-hi", async (signal: AbortSignal, name: string) => {
  signal.throwIfAborted();
  await new Promise((res) => setTimeout(res, 1500));
  return `Hello ${name}!`;
});
