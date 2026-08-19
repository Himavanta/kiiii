import { expect, test } from "vite-plus/test";
import { routeHash } from "../src/modules.ts";
import { buildModuleMap } from "../src/modules.ts";

test("routeHash：确定性、区分路径、区分同名不同扩展名", () => {
  expect(routeHash("/src/api/greet.server.ts")).toBe(routeHash("/src/api/greet.server.ts"));
  expect(routeHash("/src/api/greet.server.ts")).not.toBe(routeHash("/src/api/user.server.ts"));
  // xx.ts 与 xx.mts 同名不同扩展名——hash 必须不同（路由唯一性）
  expect(routeHash("/src/api/xx.ts")).not.toBe(routeHash("/src/api/xx.mts"));
});

test("buildModuleMap：组装为 路由哈希 → 加载器", () => {
  const loader = async () => ({ default: "greet" });
  const globs = {
    "/src/api/greet.server.ts": loader,
    "/src/api/user.server.ts": async () => ({ default: "user" }),
  };
  const map = buildModuleMap(globs);
  expect(Object.keys(map)).toHaveLength(2);
  expect(map[routeHash("/src/api/greet.server.ts")]).toBe(loader);
});
