// Playwright globalSetup：在任何 spec 执行前把整条链路预热一遍。
//
// 为什么需要：两个 webServer（后端 + Vite dev）就绪探针只保证「端口在服务」，
// 不保证「首个页面加载已经便宜」。第一次真实加载要同时付两笔冷启动账：
//   1. Vite dev 按需转换整个 app（约 700 个模块，冷缓存机器上可超 15s）；
//   2. 后端若干端点的首调冷路径（模块导入/编译，见 Core P-040 的背景）。
// 这些成本落在第一个 spec 的第一条 expect 上（默认 15s 超时），导致「首测
// 必挂、复跑就绿」的假失败。生产桌面端不受此影响（打包产物 + 冻结运行时
// 无按需转换），所以在 harness 预热而不是放宽断言超时。
import { chromium } from "@playwright/test";
import { VITE_PORT } from "./config.mjs";

const WARMUP_BUDGET_MS = 120_000;

export default async function globalWarmup() {
  const started = Date.now();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/`, {
      waitUntil: "domcontentloaded",
      timeout: WARMUP_BUDGET_MS,
    });
    // 等到 app 真正完成首屏（composer 出现），或预算耗尽——超时不让整个
    // 套件失败，只是把冷启动账尽量在这里付掉。
    await page
      .getByRole("textbox", { name: "输入消息" })
      .waitFor({ state: "visible", timeout: WARMUP_BUDGET_MS })
      .catch(() => {});
    console.log(
      `[warmup] first paint settled in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } finally {
    await browser.close();
  }
}
