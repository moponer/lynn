// M2-07：lynn-browser —— 敏感页判定、未装配如实提示、真 Edge 冒烟（有则跑）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sensitiveUrl } from "../dist/main/browser.js";
import { BrowserController } from "../dist/main/browser.js";
import { Toolkit, TOOLKIT_SCHEMAS } from "../dist/main/toolkit.js";
import { MEMBER_EXEC_TOOLS } from "../dist/main/member-runner.js";

test("sensitiveUrl：登录/支付/验证码命中；普通页与内部协议不误报", () => {
  for (const u of [
    "https://x.com/login",
    "https://mail.example.com/signin?next=/",
    "https://id.example.com/oauth/authorize",
    "https://shop.example.com/checkout/step2",
    "https://api.example.com/pay/create",
    "https://x.com/captcha?token=1",
    "https://x.com/用户登录",
  ]) {
    assert.equal(sensitiveUrl(u).sensitive, true, u);
    assert.ok(sensitiveUrl(u).why, "给得出原因");
  }
  for (const u of [
    "https://example.com/docs/page-1",
    "https://news.example.com/article/123",
    "about:blank",
    "edge://version",
  ]) {
    assert.equal(sensitiveUrl(u).sensitive, false, u);
  }
});

test("成员工具面含 browser 六件；未装配如实提示（不假装打开）", async () => {
  const names = TOOLKIT_SCHEMAS.map((s) => s.function.name);
  for (const t of ["browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_extract", "browser_close"]) {
    assert.ok(names.includes(t), `缺 ${t}`);
    assert.ok(MEMBER_EXEC_TOOLS.includes(t), `成员执行面缺 ${t}`);
  }
  const tk = new Toolkit(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-br-")));
  const r = await tk.execute("browser_navigate", { url: "https://example.com" });
  assert.ok(r.includes("未装配"), "未桥接如实说");
});

test("真 Edge 冒烟（本机有 Edge 才跑）：导航+快照+关闭", { timeout: 60_000 }, async () => {
  const ctl = new BrowserController({ headed: false }); // CI/测试用无头
  try {
    const nav = JSON.parse(await ctl.navigate("https://example.com"));
    if (!nav.ok && /Edge/.test(nav.error ?? "")) {
      console.log(`  skip：${nav.error}`);
      return;
    }
    assert.equal(nav.ok, true, nav.error ?? "");
    assert.equal(nav.sensitive, false);
    const snap = JSON.parse(await ctl.snapshot());
    assert.equal(snap.ok, true);
    assert.ok(snap.snapshot.length > 0, "有可访问性结构");
    assert.ok(snap.pageUrl.includes("example.com"));
  } finally {
    await ctl.close();
  }
});
