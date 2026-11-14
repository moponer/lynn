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
import { KnowledgeStore } from "../dist/main/knowledge.js";

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

test("M2-08：抓取表格 → csv 落盘 → 入知识库可检索（工具组合闭环）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-m08-"));
  const kb = new KnowledgeStore(root);
  const tk = new Toolkit(path.join(root, "work"), {
    office: {
      read: () => ({ error: "不测" }),
      write: (file, t) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [t.headers.join(","), ...t.rows.map((r) => r.join(","))].join("\n"), "utf-8");
        return { ok: true };
      },
    },
    kb: { add: (name, md) => kb.addDoc(name, md) },
  });

  // 成员拿到 browser_extract 的 table 后经 office_write_table 落 csv
  const table = { headers: ["名称", "价格"], rows: [["钢笔", "12"], ["墨", "8"]] };
  const w = await tk.execute("office_write_table", { path: "抓取结果.csv", headers: table.headers, rows: table.rows });
  assert.ok(JSON.parse(w).ok);
  assert.ok(fs.existsSync(path.join(root, "work", "抓取结果.csv")), "csv 落在工作区（不在主进程解析 xlsx）");

  // 正文入知识库 → 即时可检索
  const a = await tk.execute("kb_add", { name: "价格速查", markdown: "# 价格速查\n\n钢笔 12 元，墨 8 元。" });
  assert.equal(JSON.parse(a).ok, true);
  assert.ok(kb.search("价格速查").hits.length === 1, "入库即可检索");
  // 同名不覆盖
  const dup = await tk.execute("kb_add", { name: "价格速查", markdown: "# x" });
  assert.ok(JSON.parse(dup).error?.includes("不覆盖"));
  const bare = new Toolkit(path.join(root, "work2"));
  const msg = await bare.execute("kb_add", { name: "x", markdown: "y" });
  assert.ok(msg.includes("未装配"));
});

test("真 Edge 冒烟（本机有 Edge 才跑）：导航+快照+关闭", { timeout: 60_000 }, async () => {
  const ctl = new BrowserController({ headed: false }); // CI/测试用无头
  try {
    let nav = JSON.parse(await ctl.navigate("https://example.com"));
    // 全量并行跑批时，Edge 冷启动会被其它测试抢 CPU，偶尔拖过 CDP 的内部超时（实测 14-20s 才失败）。
    // 这不是回归：单跑稳定 11s。这里对"非 Edge 缺失"的失败重试一次，避免 CI 假红。
    if (!nav.ok && !/Edge/.test(nav.error ?? "")) {
      nav = JSON.parse(await ctl.navigate("https://example.com"));
    }
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
