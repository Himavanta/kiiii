import "./style.css";
import { isKiiiiError } from "kiiii/error";
import { cancel } from "kiiii/client";
import greet from "./api/greet.server.ts";
import slow from "./api/slow.server.ts";

// kiiii 示例：三个演示区——业务错误 / 主动取消 / 超时

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>kiiii 示例</h1>

  <section class="demo">
    <h2>1. 远程调用 + 业务错误</h2>
    <div class="row">
      <input id="name" placeholder="名字（留空触发业务错误）" />
      <button id="greet-btn">调用 greet</button>
    </div>
    <p id="greet-result" class="result"></p>
  </section>

  <section class="demo">
    <h2>2. 慢任务 + 主动取消</h2>
    <div class="row">
      <button id="slow-btn">发起慢任务（10 秒）</button>
      <button id="cancel-btn" disabled>取消</button>
    </div>
    <p id="slow-result" class="result"></p>
  </section>

  <section class="demo">
    <h2>3. 超时（全局 timeout 5 秒）</h2>
    <div class="row">
      <button id="timeout-btn">发起超时演示</button>
    </div>
    <p id="timeout-result" class="result"></p>
  </section>
`;

// 1. greet：业务错误以 KiiiiError 到达客户端（isKiiiiError + code 分支）
const nameInput = document.querySelector<HTMLInputElement>("#name")!;
const greetResult = document.querySelector<HTMLParagraphElement>("#greet-result")!;
document.querySelector<HTMLButtonElement>("#greet-btn")!.addEventListener("click", async () => {
  greetResult.textContent = "调用中…";
  try {
    const result = await greet(nameInput.value);
    greetResult.textContent = `✓ ${result}`;
  } catch (e) {
    if (isKiiiiError(e)) {
      greetResult.textContent = `✗ 业务错误：${e.message}（code: ${e.code}）`;
    } else {
      greetResult.textContent = `✗ 其他错误：${(e as Error).message}`;
    }
  }
});

// 2. 慢任务 + 主动取消：cancel(promise, reason) → 服务端 signal → throwIfAborted 提前退出
const slowBtn = document.querySelector<HTMLButtonElement>("#slow-btn")!;
const cancelBtn = document.querySelector<HTMLButtonElement>("#cancel-btn")!;
const slowResult = document.querySelector<HTMLParagraphElement>("#slow-result")!;
let slowPromise: Promise<unknown> | null = null;

slowBtn.addEventListener("click", async () => {
  slowBtn.disabled = true;
  cancelBtn.disabled = false;
  slowResult.textContent = "慢任务进行中…（服务端循环中检查取消信号）";
  slowPromise = slow(10);
  try {
    const result = await slowPromise;
    slowResult.textContent = `✓ ${String(result)}`;
  } catch (e) {
    slowResult.textContent = `✗ ${(e as Error).message}`;
  } finally {
    slowBtn.disabled = false;
    cancelBtn.disabled = true;
    slowPromise = null;
  }
});

cancelBtn.addEventListener("click", () => {
  if (slowPromise) {
    cancel(slowPromise, "用户取消了");
    slowResult.textContent = "已请求取消（服务端感知 signal 后提前退出）";
  }
});

// 3. 超时：全局 timeout 5 秒（vite.config.ts）——服务端同时收到 abort，协作式退出
const timeoutBtn = document.querySelector<HTMLButtonElement>("#timeout-btn")!;
const timeoutResult = document.querySelector<HTMLParagraphElement>("#timeout-result")!;
timeoutBtn.addEventListener("click", async () => {
  timeoutBtn.disabled = true;
  timeoutResult.textContent = "发起 10 秒慢任务，5 秒后全局超时…";
  try {
    await slow(10);
    timeoutResult.textContent = "✓ 完成";
  } catch (e) {
    timeoutResult.textContent = `✗ ${(e as Error).message}`;
  } finally {
    timeoutBtn.disabled = false;
  }
});
