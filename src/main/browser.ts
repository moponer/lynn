// M2-07：lynn-browser —— Playwright/Edge 驱动（§3.6 L319–321）。
//  - playwright-core + 用户本机 Edge（channel: "msedge"）：零浏览器下载，headed 可见可随时接管。
//  - 安全边界（§3.6）：登录/支付/验证码页面**强制 ask**（sensitiveUrl 纯函数，gate 特判，
//    auto/full 档也拦）；全程留痕（每次动作返回 url+title 摘要）。
//  - 单页会话：一次只开一个页（可随时接管 = headed + 不屏蔽用户输入）。
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

// ---------- 敏感页判定（纯函数，可测） ----------

const SENSITIVE_PATTERNS = [
  /login/i,
  /signin/i,
  /sign-in/i,
  /auth/i,
  /password/i,
  /pay/i,
  /checkout/i,
  /billing/i,
  /captcha/i,
  /verify/i,
  /oauth/i,
  /验证码/,
  /登录/,
  /支付/,
];

export function sensitiveUrl(url: string): { sensitive: boolean; why?: string } {
  const u = (url ?? "").toLowerCase();
  if (/^chrome|^about|^edge-|^devtools/i.test(u)) return { sensitive: false };
  for (const p of SENSITIVE_PATTERNS) {
    if (p.test(u)) return { sensitive: true, why: `URL 命中敏感特征（${p.source}）：登录/支付/验证码类页面强制 ask` };
  }
  return { sensitive: false };
}

/** 动作目标是否指向敏感域（点击/填表的 ref 可能落到敏感页元素上——以当前页 URL 判定） */
export function sensitivePage(url: string): boolean {
  return sensitiveUrl(url).sensitive;
}

// ---------- 控制器 ----------

export interface BrowserStatus {
  running: boolean;
  url?: string;
  title?: string;
  headed: boolean;
  error?: string;
}

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly headed: boolean;

  constructor(opts: { headed?: boolean } = {}) {
    this.headed = opts.headed ?? true; // 默认有头：用户可随时接管
  }

  get status(): BrowserStatus {
    return {
      running: this.page !== null,
      url: this.page?.url(),
      title: undefined,
      headed: this.headed,
    };
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) {
      const { chromium } = (await import("playwright-core")) as typeof import("playwright-core");
      // channel msedge：用用户已装的 Edge，零下载；失败如实抛（不假装开起来了）
      this.browser = await chromium.launch({ channel: "msedge", headless: !this.headed });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  /** 关键：Edge 缺失/启动失败要如实报，不能吞 */
  async navigate(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      return JSON.stringify({ ok: false, error: `只支持 http(s) URL：${url}` });
    }
    try {
      const page = await this.ensurePage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined); // SPA 宽限
      return this.outcome(page, { ok: true, url: page.url(), title: await page.title() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: `导航失败：${msg.includes("Executable") || msg.includes("channel") ? "本机 Edge 不可用（未安装或版本过旧）" : msg}` });
    }
  }

  /** 可访问性快照（aria snapshot）：给模型看的页面结构，ref 可直接用于 click/fill */
  async snapshot(): Promise<string> {
    try {
      const page = await this.ensurePage();
      const aria = await page.locator("body").ariaSnapshot().catch(() => "");
      return this.outcome(page, { ok: true, url: page.url(), title: await page.title(), snapshot: aria || "（页面无可访问性结构）" });
    } catch (err) {
      return JSON.stringify({ ok: false, error: `快照失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async click(target: string): Promise<string> {
    try {
      const page = await this.ensurePage();
      if (sensitivePage(page.url())) {
        return JSON.stringify({ ok: false, askRequired: true, error: `当前页面是敏感页（${page.url()}）：登录/支付/验证码类操作需要用户批准。` });
      }
      await page.locator(target).first().click({ timeout: 10_000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      return this.outcome(page, { ok: true, clicked: target });
    } catch (err) {
      return JSON.stringify({ ok: false, error: `点击失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async fill(target: string, value: string): Promise<string> {
    try {
      const page = await this.ensurePage();
      if (sensitivePage(page.url())) {
        return JSON.stringify({ ok: false, askRequired: true, error: `当前页面是敏感页（${page.url()}）：登录/支付/验证码类填写需要用户批准。` });
      }
      await page.locator(target).first().fill(value, { timeout: 10_000 });
      return this.outcome(page, { ok: true, filled: target, length: value.length });
    } catch (err) {
      return JSON.stringify({ ok: false, error: `填写失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  /** 抓取：正文文本或表格（表格给 csv 片段，配合 office_write_table 落盘 = M2-08） */
  async extract(kind: "text" | "table", selector?: string): Promise<string> {
    try {
      const page = await this.ensurePage();
      const loc = selector ? page.locator(selector).first() : page.locator("body");
      if (kind === "table") {
        const rows = await loc.locator("tr").evaluateAll((trs) =>
          trs.slice(0, 200).map((tr) =>
            Array.from(tr.querySelectorAll("th,td")).map((c) => ((c as { textContent?: string }).textContent ?? "").trim()),
          ),
        );
        return this.outcome(page, { ok: true, kind: "table", headers: rows[0] ?? [], rows: rows.slice(1) });
      }
      const text = (await loc.innerText({ timeout: 10_000 })).slice(0, 8000);
      return this.outcome(page, { ok: true, kind: "text", text });
    } catch (err) {
      return JSON.stringify({ ok: false, error: `抓取失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async close(): Promise<string> {
    try {
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
      return JSON.stringify({ ok: true, closed: true });
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  private async outcome(page: Page, extra: Record<string, unknown>): Promise<string> {
    let title = "";
    try {
      title = await page.title();
    } catch {
      /* 页面跳转中拿不到 title：如实留空 */
    }
    return JSON.stringify({ ...extra, pageUrl: page.url(), pageTitle: title, sensitive: sensitivePage(page.url()) });
  }
}

/** 下载到任务卷宗（M2-08 用）：page 内 fetch 简单资源落盘 */
export function saveText(dataRoot: string, rel: string, content: string): { ok: boolean; file?: string; error?: string } {
  const full = path.join(dataRoot, "downloads", rel);
  if (!full.startsWith(path.join(dataRoot, "downloads"))) return { ok: false, error: "路径越界" };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return { ok: true, file: full };
}
