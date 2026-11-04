// 把构建后的渲染层用 Electron 打开、截图，供设计走查。
// 用法：npx electron scripts/preview-shot.cjs [输出路径] [settings|review|standby|wizard|pet|pending] [主题:亮暗]
// 窄窗走查：LYNN_PREVIEW_WIDTH=1180 LYNN_PREVIEW_HEIGHT=900
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const out = process.argv[2] || path.join(__dirname, "..", "shots", "desk.png");
const W = Number(process.env.LYNN_PREVIEW_WIDTH) || 1600;
const H = Number(process.env.LYNN_PREVIEW_HEIGHT) || 1000;

app.disableHardwareAcceleration();
// review/e3 模式都要见到验收印章（决策印章优先级更高），关掉 A5 演示裁决
if (process.argv[3] === "review" || process.argv[3] === "e3") process.env.LYNN_PREVIEW_NO_DECISIONS = "1";
app.whenReady().then(async () => {
  const isPet = process.argv[3] === "pet";
  const win = new BrowserWindow({
    width: isPet ? 240 : W,
    height: isPet ? 300 : H,
    show: false,
    frame: !isPet,
    transparent: isPet,
    backgroundColor: isPet ? "#00000000" : "#0d1116",
    webPreferences: {
      preload: path.join(__dirname, "preview-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 渲染层报错必须可见：截图全黑时靠这条日志定位（而不是盯着黑图猜）
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => console.log("RENDER GONE", details));

  await win.loadFile(
    path.join(__dirname, "..", "dist", "renderer", "index.html"),
    isPet ? { query: { pet: "1" } } : undefined,
  );
  await new Promise((r) => setTimeout(r, 1200));

  if (isPet) {
    await new Promise((r) => setTimeout(r, 800));
    win.showInactive();
    await new Promise((r) => setTimeout(r, 400));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 200));
    const img0 = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img0.toPNG());
    console.log("SHOT", out, img0.getSize());
    app.quit();
    return;
  }

  // 造铃向导：默认跳过（否则每张截图都被首启向导挡住）；要截向导就传 wizard
  const wantWizard = process.argv[3] === "wizard";
  await win.webContents.executeJavaScript(
    wantWizard
      ? `localStorage.removeItem('lynn.onboarded'); location.reload();`
      : `localStorage.setItem('lynn.onboarded','1'); location.reload();`,
  );
  await new Promise((r) => setTimeout(r, 2000));

  // 可选：打开「我的风铃」面板
  if (process.argv[3] === "settings") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.sf-overlay')`);
    console.log("SETTINGS", ok, overlay);
  }

  // 可选：进待机（Ctrl+.）
  if (process.argv[3] === "standby") {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log("STANDBY", await win.webContents.executeJavaScript(`!!document.querySelector('.standby')`));
  }

  // 可选：窄窗下点顶栏「待办 (n)」把右栏抽屉拉开
  if (process.argv[3] === "pending") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.pending-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    console.log("PENDING", ok, await win.webContents.executeJavaScript(`!!document.querySelector('.right.open')`));
  }

  // 可选：进入审查台（E3 后印章"打回"就地展开，进审查台走「打开完整验收包」链接）
  if (process.argv[3] === "review") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.seal-review-link'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const rev = await win.webContents.executeJavaScript(`!!document.querySelector('.rev-pair')`);
    console.log("REVIEW", ok, rev);
  }

  // 可选：E3 打回三要素在印章就地展开
  if (process.argv[3] === "e3") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.sealcard .btn-reject'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.seal-reject .seal-field').length`);
    console.log("E3", ok, "fields:", n);
  }

  // 可选：Ctrl+K 命令面板（E6）
  if (process.argv[3] === "palette") {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const items = await win.webContents.executeJavaScript(`document.querySelectorAll('.cmdk-item').length`);
    console.log("PALETTE", await win.webContents.executeJavaScript(`!!document.querySelector('.cmdk')`), "items:", items);
  }

  // 可选：点开当前会话条，展示会话面板（E4：会话全文搜索框）
  if (process.argv[3] === "threads") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.thread-cur'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    console.log("THREADS", ok, await win.webContents.executeJavaScript(`!!document.querySelector('.thread-panel')`));
  }

  // 可选：会话改名 / 删除入口（C5）：先验改名输入框出现并 Esc 可取消，再展开删除确认条
  if (process.argv[3] === "threadedit") {
    await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.thread-cur'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    const clickedRename = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const pen = row && row.querySelector('.thread-act');
      if (!pen) return false;
      pen.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const renameOpen = await win.webContents.executeJavaScript(`!!document.querySelector('.thread-rename')`);
    await win.webContents.executeJavaScript(
      `(() => { const el=document.querySelector('.thread-rename'); if (el) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const renameClosed = await win.webContents.executeJavaScript(`!document.querySelector('.thread-rename')`);
    const clickedDelete = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const del = row && row.querySelectorAll('.thread-act')[1];
      if (!del) return false;
      del.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "THREADEDIT",
      "rename:",
      clickedRename,
      renameOpen,
      renameClosed,
      "delete:",
      clickedDelete,
      await win.webContents.executeJavaScript(`!!document.querySelector('.thread-ask')`),
    );
  }

  // 可选：任务总览（多任务并行：几个在跑、各自团队与进度、去会话）
  if (process.argv[3] === "overview") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.tasks-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    console.log(
      "OVERVIEW",
      ok,
      await win.webContents.executeJavaScript(`!!document.querySelector('.tov')`),
      "jobs:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.tov-job').length`),
    );
  }

  // 可选：工单卡右键菜单（卡住的单：打开 / 去会话 / 停 / 取消 / 删除）
  if (process.argv[3] === "jobmenu") {
    const ok = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.job');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 24 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "JOBMENU",
      ok,
      "items:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.jobmenu-item').length`),
    );
  }

  // 可选：多条挂起裁决翻到下一条（A5）
  if (process.argv[3] === "sealnext") {
    const before = await win.webContents.executeJavaScript(
      `document.querySelector('.seal-pager .chip')?.textContent ?? "no-pager"`,
    );
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.seal-pager .icon-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const after = await win.webContents.executeJavaScript(
      `document.querySelector('.seal-pager .chip')?.textContent ?? "no-pager"`,
    );
    console.log("SEALNEXT", before, "->", after, "clicked:", ok);
  }

  // 可选：切主题，参数形如 night:light / paper:dark / celadon:dark
  const themeArg = process.argv[4];
  if (themeArg) {
    const [id, mode] = themeArg.split(":");
    await win.webContents.executeJavaScript(
      `localStorage.setItem('lynn.theme', ${JSON.stringify(id)}); localStorage.setItem('lynn.mode', ${JSON.stringify(mode)}); location.reload();`,
    );
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 隐藏窗口在部分合成器上只保留首帧：截图前短暂显示并重绘一次
  win.showInactive();
  await new Promise((r) => setTimeout(r, 400));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 200));

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log("SHOT", out, img.getSize());
  app.quit();
});
