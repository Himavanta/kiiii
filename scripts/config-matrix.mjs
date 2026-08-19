// 配置压力测试：把真实项目常见配置逐项注入 example 构建，验证"不丢、不炸、产物正确"。
// 用法：node scripts/config-matrix.mjs
// 每个变体：备份 vite.config.ts → 注入变体配置 → vp build → 断言产物 → 还原。
// 失败收集汇总（不中断），结束时还原一切；有失败则退出码 1。
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const example = join(root, "packages", "example");
const configPath = join(example, "vite.config.ts");
const original = readFileSync(configPath, "utf8");
const outDirs = ["dist", "build", "out"];

const template = (extra, extraPlugins = "") => `import { defineConfig } from "vite-plus";
import { kiiii } from "kiiii";

export default defineConfig({
${extra}  plugins: [${extraPlugins}${extraPlugins ? ", " : ""}kiiii({ pattern: "/src/**/*.server.ts", timeout: 5_000 })],
});
`;

const scan = (dir, pred) => {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (pred(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const variants = [
  {
    name: "基线（无额外配置）",
    config: "",
    expect: (d) =>
      existsSync(join(d, "dist/server/start.js")) && existsSync(join(d, "dist/public/index.html")),
  },
  {
    name: "自定义 outDir（build/）",
    config: '  build: { outDir: "build" },\n',
    expect: (d) =>
      existsSync(join(d, "build/server/start.js")) &&
      existsSync(join(d, "build/public/index.html")),
  },
  {
    name: "多入口（数组形态 input）",
    config: '  build: { rolldownOptions: { input: ["index.html", "admin.html"] } },\n',
    setup: () => {
      writeFileSync(
        join(example, "admin.html"),
        '<!doctype html><html><head><title>admin</title></head><body><script type="module" src="/src/admin.ts"></script></body></html>',
      );
      writeFileSync(
        join(example, "src/admin.ts"),
        'document.body.insertAdjacentHTML("beforeend", "<p>admin</p>");\n',
      );
    },
    cleanup: () => {
      rmSync(join(example, "admin.html"), { force: true });
      rmSync(join(example, "src/admin.ts"), { force: true });
    },
    expect: (d) =>
      existsSync(join(d, "dist/public/admin.html")) &&
      !existsSync(join(d, "dist/server/admin.js")) &&
      !existsSync(join(d, "dist/server/main.js")),
  },
  {
    name: "manifest",
    config: "  build: { manifest: true },\n",
    expect: (d) => existsSync(join(d, "dist/public/.vite/manifest.json")),
  },
  {
    name: "sourcemap",
    config: "  build: { sourcemap: true },\n",
    expect: (d) => scan(join(d, "dist/public/assets"), (n) => n.endsWith(".map"))?.length > 0,
  },
  {
    name: "base（子路径部署）",
    config: '  base: "/app/",\n',
    expect: (d) => readFileSync(join(d, "dist/public/index.html"), "utf8").includes("/app/assets/"),
  },
  {
    name: "rollupOptions 旧字段（函数形态 manualChunks）",
    config:
      '  build: { rollupOptions: { output: { manualChunks: (id) => id.includes("devalue") ? "vendor" : undefined } } },\n',
    expect: (d) => scan(join(d, "dist/public/assets"), (n) => n.startsWith("vendor-"))?.length > 0,
  },
  {
    name: "自定义插件（transform 注入标记）",
    config: "",
    plugins: `{
      name: "inject-mark",
      transform(code, id) {
        if (id.endsWith("main.ts")) return code + '\\nconsole.log("INJECTED_MARK");';
      },
    }`,
    expect: (d) => {
      const chunks = scan(join(d, "dist/public/assets"), (n) => n.endsWith(".js"));
      return chunks?.some((f) => readFileSync(f, "utf8").includes("INJECTED_MARK"));
    },
  },
  {
    name: "组合（outDir + manifest + base + alias）",
    config: `  base: "/sub/",
  build: { outDir: "out", manifest: true },
  resolve: { alias: { "@": "/src" } },
`,
    expect: (d) =>
      existsSync(join(d, "out/public/.vite/manifest.json")) &&
      readFileSync(join(d, "out/public/index.html"), "utf8").includes("/sub/assets/"),
  },
];

// ---- 执行 ----
const failures = [];
for (const variant of variants) {
  // 隔离：清掉所有可能产物目录
  for (const dir of outDirs) rmSync(join(example, dir), { recursive: true, force: true });
  variant.setup?.();
  writeFileSync(configPath, template(variant.config, variant.plugins));
  try {
    execSync("pnpm exec vp build", { cwd: example, stdio: "pipe", timeout: 120_000 });
    const ok = variant.expect(example);
    if (ok) {
      console.log(`✓ ${variant.name}`);
    } else {
      failures.push(variant.name);
      console.log(`✗ ${variant.name}（构建成功但产物断言失败）`);
    }
  } catch (error) {
    failures.push(variant.name);
    const msg = String(error.stderr ?? error)
      .split("\n")
      .filter(Boolean)
      .slice(-6)
      .join("\n");
    console.log(`✗ ${variant.name}（构建失败）\n  ${msg}`);
  } finally {
    variant.cleanup?.();
    writeFileSync(configPath, original);
  }
}

console.log(
  failures.length === 0 ? "\n全部通过 ✓" : `\n失败 ${failures.length} 项: ${failures.join(", ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
