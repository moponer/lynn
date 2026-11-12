// 复现验证：真实插件目录 → 设置页点「沉浸控制台」→ 断言 DOM → 截图
//
// 用法（必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 会退化成纯 Node）：
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
//     design-previews/2026-11-08-events/plugin-sample/verify.cjs [输出前缀]
//
// 前置：npm run build:renderer && npm run build:main
//     插件已装到 ~/.lynn/plugins/lynn.theme.console/
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "../../..");
const TMPDIR = path.join(ROOT, "dist", "_tmp");
const PRELOAD = path.join(TMPDIR, "verify-preload.cjs");
const OUT = process.argv[2] || path.join(TMPDIR, "verify-theme");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成 preload：只把 plugins.list 换成真实 PluginHost 扫描，其余沿用项目预览桩 */
function writePreload() {
  let src = fs.readFileSync(path.join(ROOT, "scripts", "preview-preload.cjs"), "utf-8");
  const start = src.indexOf('if (method === "plugins.list") {');
  const end = src.indexOf('if (method === "plugins.status")');
  if (start < 0 || end < 0) throw new Error("preview-preload.cjs 的 plugins.list 分支找不到");
  src = src.slice(0, start) + 'if (method === "plugins.list") return loadRealPlugins();\n    ' + src.slice(end);
  const header = [
    "// 由 verify.cjs 生成：plugins.list 走真实 PluginHost",
    "const REAL_DATA_ROOT = " + JSON.stringify(path.join(os.homedir(), ".lynn")) + ";",
    "function loadRealPlugins() {",
    "  try {",
    "    const { PluginHost } = require(" + JSON.stringify(path.join(ROOT, "dist", "main", "plugin-host.js")) + ");",
    "    const r = new PluginHost(REAL_DATA_ROOT).scan();",
    '    console.log("[preload] real scan:", r.plugins.length, "errors:", JSON.stringify(r.errors));',
    "    return { plugins: r.plugins, errors: r.errors };",
    "  } catch (e) {",
    '    console.log("[preload] scan failed:", String((e && e.message) || e));',
    '    return { plugins: [], errors: ["scan failed"] };',
    "  }",
    "}",
    "",
  ].join("\n");
  fs.mkdirSync(TMPDIR, { recursive: true });
  fs.writeFileSync(PRELOAD, header + src);
}

const probe = `(() => {
  const root = document.documentElement;
  const el = document.getElementById('lynn-plugin-style');
  const t = document.querySelector('.panel-h .t') || document.querySelector('.h-cap');
  const cs = t ? getComputedStyle(t) : null;
  const r = getComputedStyle(root);
  return {
    attr: root.dataset.themePlugin || null,
    styleEl: !!el,
    styleLen: el ? el.textContent.length : 0,
    desk: r.getPropertyValue('--desk').trim(),
    ink2: r.getPropertyValue('--ink-2').trim(),
    term: r.getPropertyValue('--term').trim(),
    titleFont: cs ? cs.fontFamily.split(',')[0] : null,
    titleSize: cs ? cs.fontSize : null,
    titleShadow: cs ? cs.boxShadow.slice(0, 32) : null,
  };
})()`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  writePreload();
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: "#0d1116",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on("console-message", (_e, level, msg) => console.log("[renderer:" + level + "] " + msg));

  await win.loadFile(path.join(ROOT, "dist", "renderer", "index.html"));
  await sleep(1200);
  await win.webContents.executeJavaScript("localStorage.setItem('lynn.onboarded','1'); location.reload();");
  await sleep(2400);

  const out = { before: await win.webContents.executeJavaScript(probe) };

  const okSettings = await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /我的风铃|设置/.test(x.textContent || ''));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(900);
  const tab = await win.webContents.executeJavaScript(`(() => {
    const it = [...document.querySelectorAll('.sf-nav-item')];
    const t = it.find((x) => /插件|能力|plugins/i.test(x.textContent || '')) || it[4];
    if (t) { t.click(); return (t.textContent || '').trim(); } return null;
  })()`);
  await sleep(1200);
  const applied = await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.sf-btn')].find((x) => (x.textContent || '').includes('沉浸控制台'));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(800);
  out.settings = { okSettings, tab, applied };
  out.after = await win.webContents.executeJavaScript(probe);

  let img = await win.webContents.capturePage();
  fs.writeFileSync(OUT + "-settings.png", img.toPNG());

  await win.webContents.executeJavaScript(`(() => { const x = document.querySelector('.sf-x'); if (x) x.click(); })()`);
  await sleep(900);
  win.showInactive();
  await sleep(500);
  win.webContents.invalidate();
  await sleep(300);
  img = await win.webContents.capturePage();
  fs.writeFileSync(OUT + "-applied.png", img.toPNG());

  out.verdict = {
    attrApplied: out.after.attr !== null,
    styleInjected: out.after.styleLen > 0,
    tokenChanged: out.before.desk !== out.after.desk,
    termDerived: out.after.term !== "",
    titleMono: /Mono/.test(out.after.titleFont || ""),
    shots: [OUT + "-settings.png", OUT + "-applied.png"],
  };
  console.log(JSON.stringify(out, null, 2));
  app.quit();
});
