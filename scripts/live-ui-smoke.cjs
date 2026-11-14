/**
 * 真 UI 业务闭环冒烟（2026-11-14）：真 Electron 窗口 + 真 preload/IPC + 真 Kernel + 真 Pi 会话 + 真模型。
 *
 * 与 preview-shot 的区别：走查用 preview-preload.cjs 的**假桥**；这里 require 真实
 * dist/main/main.js，窗口里点的是真实输入框与发送按钮，消息经 ipcMain → kernel.handle
 * ("feed.send") → PiRpcHost → 模型，回来的卡片与顶栏读数都是真数据。
 *
 * 用 `electron scripts/live-ui-smoke.cjs` 跑。临时 LYNN_HOME + 临时 userData（复制 Local State
 * 供 safeStorage 解密），既隔离用户数据根、也绕开单实例锁（按 userData 判定）。
 * 不打印 API Key。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL_USER_DATA = path.join(os.homedir(), "AppData", "Roaming", "lynn");
const PROBE_USER_DATA = path.join(os.tmpdir(), "lynn-ui-smoke-userdata");
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ui-smoke-"));

fs.mkdirSync(PROBE_USER_DATA, { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, "logs"), { recursive: true });
const localState = path.join(REAL_USER_DATA, "Local State");
if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(PROBE_USER_DATA, "Local State"));
fs.copyFileSync(path.join(os.homedir(), ".lynn", "settings.json"), path.join(DATA_ROOT, "settings.json"));

app.setName("Lynn");
app.setPath("userData", PROBE_USER_DATA);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("remote-debugging-port", "0");
// 必须在 require(main.js) 之前：Kernel 构造时读 defaultDataRoot()
process.env.LYNN_HOME = DATA_ROOT;
// 主进程真身（同一个 app 实例，两个 whenReady 回调并行；靠轮询拿窗口）
require("../dist/main/main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usageRows() {
  const f = path.join(DATA_ROOT, "logs", "usage.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
}

async function waitWindow(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents);
    if (w) return w;
    await sleep(300);
  }
  return null;
}

async function waitDom(win, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await win.webContents
      .executeJavaScript("!!document.querySelector('.composer-in') && !!document.querySelector('button.send')")
      .catch(() => false);
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

const SET_TEXT = `
(() => {
  const ta = document.querySelector('.composer-in');
  if (!ta) return { ok: false, why: 'no .composer-in' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, %TEXT%);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return { ok: true };
})()
`;

async function send(win, text) {
  const script = SET_TEXT.replace("%TEXT%", JSON.stringify(text));
  const set = await win.webContents.executeJavaScript(script);
  if (!set.ok) return set;
  await sleep(400); // 等 React 受控 state 更新，按钮才从 disabled 放开
  const clicked = await win.webContents.executeJavaScript(
    "(() => { const b = document.querySelector('button.send'); if (!b || b.disabled) return { ok:false, why:'send disabled' }; b.click(); return { ok:true }; })()",
  );
  return clicked;
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(`(() => {
    const txt = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g, ' ').trim();
    const cards = [...document.querySelectorAll('.feed-item')].slice(-4).map(c => c.textContent.replace(/\\s+/g,' ').trim().slice(0,110));
    return {
      cacheBadge: txt('.cache-badge'),
      topRail: document.querySelector('header')?.textContent.replace(/\\s+/g,' ').trim().slice(0, 220) || '',
      composerValue: document.querySelector('.composer-in')?.value || '',
      cards,
      bodyTail: document.body.innerText.replace(/\\s+/g,' ').slice(-320),
    };
  })()`);
}

async function main() {
  console.log("\n=== 真 UI 冒烟：真窗口 + 真 Pi 会话 + 真模型（2 轮） ===");
  console.log(`数据根 ${DATA_ROOT}`);
  const win = await waitWindow();
  if (!win) {
    console.log("没等到窗口（main.js 未创建或启动失败）");
    return;
  }
  if (!(await waitDom(win))) {
    console.log("窗口起来了，但没找到 .composer-in / button.send（渲染层未就绪）");
    return;
  }
  console.log("窗口与渲染层就绪");

  const results = [];
  const questions = [
    "请只回复 OK 两个字，不要解释，不要调用任何工具。",
    "再确认一次：同样只回复 OK 两个字，不要解释。",
  ];
  for (let i = 0; i < questions.length; i += 1) {
    const before = usageRows().length;
    const sent = await send(win, questions[i]);
    console.log(`\n轮 ${i + 1} 发送：${JSON.stringify(sent)}`);
    if (!sent.ok) {
      results.push({ round: i + 1, sent });
      continue;
    }
    const t0 = Date.now();
    let row = null;
    while (Date.now() - t0 < 120_000) {
      const rows = usageRows();
      if (rows.length > before) {
        row = rows[rows.length - 1];
        break;
      }
      await sleep(500);
    }
    await sleep(600);
    const dom = await snapshot(win).catch(() => ({}));
    const rec = {
      round: i + 1,
      waitedMs: Date.now() - t0,
      usage: row
        ? { source: row.source, in: row.in, out: row.out, cacheRead: row.cacheRead, breakReason: row.cacheBreakReason }
        : null,
      cacheBadge: dom.cacheBadge ?? "",
      composerCleared: (dom.composerValue ?? "") === "",
      cards: dom.cards ?? [],
      bodyTail: dom.bodyTail ?? "",
    };
    results.push(rec);
    console.log(`  usage=${JSON.stringify(rec.usage)}  waited=${rec.waitedMs}ms`);
    console.log(`  缓存徽章="${rec.cacheBadge}"  输入框已清空=${rec.composerCleared}`);
    console.log(`  最后卡片=${JSON.stringify(rec.cards.slice(-2))}`);
  }

  const shot = path.join(__dirname, "..", "shots", "live-ui-smoke.png");
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    console.log(`\n截图 ${shot}`);
  } catch (err) {
    console.log(`截图失败：${err?.message ?? err}`);
  }
  const out = path.join(__dirname, "..", "shots", "live-ui-smoke.json");
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2), "utf8");
  console.log(`结果已写 ${out}`);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error("UI 冒烟失败：", err?.stack ?? err);
  } finally {
    // 不调用 kernel.dispose（main.js 内部持有）；直接退出进程，临时数据根留在磁盘供回查
    setTimeout(() => app.exit(0), 300);
  }
});
