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
  // 舞台视图：LYNN_PREVIEW_STAGE=desk 截原值台，console（默认）截 stage.console 视图
  const stage = process.env.LYNN_PREVIEW_STAGE;
  const stageJs = stage ? `localStorage.setItem('lynn.stage.view', ${JSON.stringify(stage)});` : "";
  await win.webContents.executeJavaScript(
    wantWizard
      ? `localStorage.removeItem('lynn.onboarded'); location.reload();`
      : `localStorage.setItem('lynn.onboarded','1');${stageJs} location.reload();`,
  );
  await new Promise((r) => setTimeout(r, 2000));

  // 冻结运行信号的动画、强制实线环：用于静态截图确证三处信号真实渲染
  // （动画在 50% 帧会把描边淡到 10% 透明，随机截图常落在最弱帧，肉眼难辨）
  if (process.env.LYNN_PREVIEW_FREEZE) {
    await win.webContents.insertCSS(`
      .mcard[data-state="running"] .mcard-avatar { animation: none !important; box-shadow: 0 0 0 2px var(--blue) !important; }
      .mcard-live { animation: none !important; opacity: 1 !important; transform: none !important; }
      .job[data-running="1"] { animation: none !important; box-shadow: 0 0 0 2px var(--blue) !important; }
      .job[data-running="1"] .job-mark { animation: none !important; opacity: 1 !important; transform: none !important; }
      .feed-item.tool.progress.live .feed-badge { box-shadow: 0 0 0 1px var(--blue-line) !important; }
      .live-dot { animation: none !important; opacity: 1 !important; transform: none !important; }
    `);
    await new Promise((r) => setTimeout(r, 300));
  }

  // 可选：点「全权」→ 确认弹窗（夹具默认 ask，必定弹）
  if (process.argv[3] === "perm") {
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.seg-item.danger'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.perm-overlay')`);
    console.log("PERM", clicked, overlay);
  }

  // 可选：打开「我的风铃」面板
  if (process.argv[3] === "settings") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.sf-overlay')`);
    console.log("SETTINGS", ok, overlay);
  }

  // 可选：我的风铃 → 团队（编制管理）
  if (process.argv[3] === "team") {
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.includes('团队')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log(
      "TEAM",
      opened,
      navOk,
      "blocks:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-block').length`),
      "members:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-block .sf-row').length`),
    );
  }

  // 可选：我的风铃 → 团队 → 展开头像库（看 12 张工牌照）
  if (process.argv[3] === "avatars") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.includes('团队')); if (b) b.click(); })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.team-av-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "AVATARS",
      ok,
      "options:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-av-opt').length`),
    );
  }

  // 可选：我的风铃 → 自动化 / 能力页
  if (process.argv[3] === "auto" || process.argv[3] === "plugins") {
    const navLabel = process.argv[3] === "auto" ? "自动化" : "能力";
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.includes(${JSON.stringify(navLabel)})); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log("PANEL", process.argv[3], opened, navOk);
  }

  // 可选：左栏切到「工单」视图
  if (process.argv[3] === "jobs") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    console.log("JOBS", ok, "rows:", await win.webContents.executeJavaScript(`document.querySelectorAll('.job').length`));
  }

  // 可选：归档带走查（默认折叠 5 条 + 第一行模拟 hover 显出 ×）
  if (process.argv[3] === "archband") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    const info = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelectorAll('.arch-row');
      const del = document.querySelector('.arch-del');
      return {
        rows: rows.length,
        delOpacity: del ? getComputedStyle(del).opacity : 'none',
        delLabels: [...document.querySelectorAll('.arch-del')].map(x => x.textContent.trim()).slice(0, 3),
        more: !!document.querySelector('.archive-band .strip-link'),
      };
    })()`);
    console.log("ARCHBAND", info);
    // 只为走查：让第一行的删除动作显形，验证常态是不显的、hover 才有 ×
    await win.webContents.executeJavaScript(
      `(() => { const d = document.querySelector('.arch-del'); if (d) d.style.opacity = '1'; })()`,
    );
  }

  // 可选：工单详情（阶段刻度是否只让当前环节转、页签按钮是否去分层）
  if (process.argv[3] === "jobdetail") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[role="button"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const info = await win.webContents.executeJavaScript(`(() => ({
      steps: document.querySelectorAll('.step').length,
      ring: document.querySelectorAll('.step-ring').length,
      now: [...document.querySelectorAll('.step')].findIndex(x => x.classList.contains('now')),
      tabs: document.querySelectorAll('.tab').length,
      lines: document.querySelectorAll('.step-line').length,
      toolbar: !!document.querySelector('.sheet-toolbar'),
      segWrap: [...document.querySelectorAll('.rail-seg-item')].map(x => x.getBoundingClientRect().height),
    }))()`);
    console.log("JOBDETAIL", ok, info);
  }

  // 可选：顶栏工作区菜单（验证 fixed 定位没有被图纸裁掉/盖住）
  if (process.argv[3] === "wsmenu") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[role="button"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.wsmenu-wrap .crumb-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const info = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.wsmenu');
      if (!m) return { open: false };
      const r = m.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + Math.min(40, r.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      return {
        open: true,
        pos: getComputedStyle(m).position,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        covered: !(hit === m || m.contains(hit)),
        hit: hit ? hit.className : null,
      };
    })()`);
    console.log("WSMENU", opened, info);
  }

  // 可选：成员战绩按需展开（验证 RPC 通路与卡内展示）
  if (process.argv[3] === "record") {
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.mcard-record-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 450));
    const text = await win.webContents.executeJavaScript(
      `document.querySelector('.mcard-stat')?.textContent ?? ''`,
    );
    console.log("RECORD", clicked, JSON.stringify(text));
  }

  // 可选：运行信号（成员卡呼吸环、工单卡呼吸环、进度卡「执行中」）
  if (process.argv[3] === "runningsignal") {
    // 1) 左栏切到「工单」视图
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    // 2) 点开当前在跑的那张单（data-running="1"），中心进入工单详情
    const opened = await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[data-running="1"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    // 3) 工单详情默认在「对话」tab，切到「往来」才能看到带 jobId 的进度卡
    const fedTab = await win.webContents.executeJavaScript(
      `(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('往来')); if (t) t.click(); return !!t; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const info = await win.webContents.executeJavaScript(`(() => ({
      opened: ${opened ? "true" : "false"},
      fedTab: ${fedTab ? "true" : "false"},
      memberRunning: document.querySelectorAll('.mcard[data-state="running"]').length,
      memberDots: document.querySelectorAll('.mcard-live').length,
      jobRunning: document.querySelectorAll('.job[data-running="1"]').length,
      jobPips: document.querySelectorAll('.job[data-running="1"] .pip').length,
      liveCards: document.querySelectorAll('.feed-item.tool.progress.live').length,
      liveDots: document.querySelectorAll('.feed-item.tool.progress.live .live-dot').length,
      liveText: [...document.querySelectorAll('.feed-live-text')].map(x => x.textContent),
    }))()`);
    console.log("RUNSIGNAL", info);
  }

  // 可选：控制台「需用户动手」是否在主界面弹出（待验收 / 待拍板）
  if (process.argv[3] === "waitalert") {
    const info = await win.webContents.executeJavaScript(`(() => {
      const a = document.querySelector('.cs-alert');
      return {
        alert: !!a,
        top: a ? (a.querySelector('.cs-alert-top')?.textContent || '').trim() : null,
        title: a ? (a.querySelector('.cs-alert-t')?.textContent || '').trim() : null,
        detail: a ? (a.querySelector('.cs-alert-d')?.textContent || '').trim() : null,
        acts: a ? [...a.querySelectorAll('.cs-alert-acts button')].map(b => b.textContent.trim()) : [],
        sealMini: (document.querySelector('.cs-seal-mini')?.textContent || '').trim(),
        seal: (document.querySelector('.cs-seal .s-cn')?.textContent || '').trim(),
        readouts: [...document.querySelectorAll('.cs-readout')].map(x => x.textContent.trim()),
      };
    })()`);
    console.log("WAITALERT", info);
  }

  // 可选：控制台产出柜（真文件卡 + 点开内置预览）
  if (process.argv[3] === "outcards") {
    const info = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.cs-out')];
      return {
        count: cards.length,
        names: cards.map(c => (c.querySelector('.cs-oname')?.textContent || '').trim()),
        metas: cards.map(c => (c.querySelector('.cs-ometa')?.textContent || '').trim()),
        thumbKind: cards.map(c => (c.className.match(/k-(\\w+)/) || [])[1]),
        hasImg: document.querySelectorAll('.cs-thumb-img').length,
        hasTxt: document.querySelectorAll('.cs-thumb-txt').length,
        hasExt: document.querySelectorAll('.cs-thumb-ext').length,
        noise: cards.filter(c => /未核|qnj|成员回报|成员自述/.test(c.textContent)).length,
      };
    })()`);
    console.log("OUTCARDS", info);
    // LYNN_PREVIEW_PLAIN=1：只截干净网格（不点开预览）
    if (process.env.LYNN_PREVIEW_PLAIN !== "1") {
      // 先点一张 docx：应真渲染成白纸 HTML（docx-read），而不是退回"没有内置预览"
      const doc = await win.webContents.executeJavaScript(
        `(() => { const c=document.querySelector('.cs-out.k-doc'); if (c) c.click(); return !!c; })()`,
      );
      await new Promise((r) => setTimeout(r, 700));
      const pvDoc = await win.webContents.executeJavaScript(`(() => {
        const d = document.querySelector('.pv-drawer');
        return d ? {
          name: (d.querySelector('.pv-name strong')?.textContent || '').trim(),
          hint: (d.querySelector('.pv-hint')?.textContent || '').trim().slice(0, 60),
          act: (d.querySelector('.pv-hint-act')?.textContent || '').trim(),
          docFrame: !!d.querySelector('iframe.pv-doc'),
        } : null;
      })()`);
      console.log("OUTCARD_DOC", doc, pvDoc);
      // 关抽屉走关闭按钮（合成 Esc 不可靠：遮罩层的 mousedown 会先吃掉下一次点击）
      await win.webContents.executeJavaScript(
        `(() => { const b=[...document.querySelectorAll('.pv-acts .ghost-btn')].pop(); if (b) b.click(); return !!b; })()`,
      );
      await new Promise((r) => setTimeout(r, 400));
      // 再点第一张（文本类）：应直接开内置预览（而不是跳到"这张单的战果"）
      await win.webContents.executeJavaScript(
        `(() => { const c=document.querySelector('.cs-out'); if (c) c.click(); return !!c; })()`,
      );
      await new Promise((r) => setTimeout(r, 900));
      const pv = await win.webContents.executeJavaScript(`(() => {
        const d = document.querySelector('.pv-drawer');
        return {
          drawer: !!d,
          name: d ? (d.querySelector('.pv-name strong')?.textContent || '').trim() : null,
          kind: d ? (d.querySelector('.pv-body')?.firstElementChild?.className || '') : null,
          hint: d ? (d.querySelector('.pv-hint')?.textContent || '').trim().slice(0, 40) : null,
        };
      })()`);
      console.log("OUTCARD_PREVIEW", pv);
    }
  }

  // 可选：战果抽屉（产出柜「全部 N 件」入口）——产物清单是否只列真文件、是否可点开
  if (process.argv[3] === "outdrawer") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.cs-linkbtn')].find(x=>x.textContent.includes('全部')); if(b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const info = await win.webContents.executeJavaScript(`(() => ({
      secs: [...document.querySelectorAll('.cs-drawer .cs-sec')].map(x=>x.textContent.trim()),
      rows: [...document.querySelectorAll('.cs-drawer .cs-ev-row')].map(r => ({
        n: (r.querySelector('.cs-ev-n')?.textContent||'').trim(),
        p: (r.querySelector('.cs-ev-p')?.textContent||'').trim(),
        clickable: r.tagName === 'BUTTON',
      })),
      counts: [...document.querySelectorAll('.cs-drawer .cs-cell')].map(x=>x.textContent.trim()),
    }))()`);
    console.log("OUTDRAWER", JSON.stringify(info, null, 1));
  }

  // 可选：内置预览抽屉（交付箱 → 第一份报告），验证 md 排版与代码高亮
  if (process.argv[3] === "preview") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][2]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const r=[...document.querySelectorAll('.thread-row')].find(x=>!x.disabled); if (r) r.click(); return !!r; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log(
      "PREVIEW",
      ok,
      "drawer:",
      await win.webContents.executeJavaScript(`!!document.querySelector('.pv-drawer')`),
      "code:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.hljs-keyword').length`),
    );
  }

  // 可选：控制台 → 档案抽屉（看无主单清理出口）
  if (process.argv[3] === "archive") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.cs-tool')].find(x=>x.textContent.includes('档案')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    console.log(
      "ARCHIVE",
      ok,
      "orphan:",
      await win.webContents.executeJavaScript(`!!document.querySelector('.cs-orphan')`),
    );
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

  // 可选：群聊渲染走查（用户右对齐 / 成员带头像与岗位 / @芯片 / 陌生 @ 的提示）
  if (process.argv[3] === "groupchat") {
    const info = await win.webContents.executeJavaScript(`(() => {
      const feed = document.querySelector('.feed');
      const box = feed ? feed.getBoundingClientRect() : null;
      const items = [...document.querySelectorAll('.feed-item')];
      const users = items.filter((x) => x.classList.contains('user'));
      const talks = items.filter((x) => x.classList.contains('talk'));
      const u = users[users.length - 1];
      return {
        items: items.length,
        users: users.length,
        talks: talks.length,
        atChips: document.querySelectorAll('.at-chip').length,
        chipText: [...document.querySelectorAll('.at-chip')].map((x) => x.textContent.trim()),
        talkNames: [...document.querySelectorAll('.feed-item.talk .fv-name')].map((x) => x.textContent.trim()),
        talkRoles: [...document.querySelectorAll('.fv-role')].map((x) => x.textContent.trim()),
        talkAvatars: document.querySelectorAll('.feed-item.talk .fv-who img').length,
        userRightGap: u && box ? Math.round(box.right - u.getBoundingClientRect().right) : null,
        userLeftGap: u && box ? Math.round(u.getBoundingClientRect().left - box.left) : null,
        unknownNotice: [...document.querySelectorAll('.feed-item.system')].map((x) => x.textContent.trim()).filter((t) => t.includes('群里没有')),
      };
    })()`);
    console.log("GROUPCHAT", JSON.stringify(info));
    // @ 补全：输入 "@顾" 应先列群里的人（本群成员排前面），再列文件
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.composer-in');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '@顾');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const pop = await win.webContents.executeJavaScript(`(() => ({
      pop: !!document.querySelector('.mention-pop'),
      items: [...document.querySelectorAll('.mention-item')].map((x) => x.textContent.trim()),
    }))()`);
    console.log("ATPOP", JSON.stringify(pop));
    // 滚到群聊卡（用户 @成员 / 风铃点名 / 成员交付）——默认贴底看不到它们
    await win.webContents.executeJavaScript(
      `(() => { const t=document.querySelector('.feed-item.talk'); if (t) t.scrollIntoView({ block: 'center' }); })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
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

  // 贴底走查：思考流式补字后 [scrollTop, 最大可滚距离] 应该相等
  const feedPos = await win.webContents.executeJavaScript(
    `(() => { const n=document.querySelector('[data-feed-scroll]'); return n ? [Math.round(n.scrollTop), Math.round(n.scrollHeight-n.clientHeight)] : null; })()`,
  );
  console.log("FEED_SCROLL", feedPos);
  const gauge = await win.webContents.executeJavaScript(
    `(() => { const n=document.querySelector('.gauge-bar'); return n ? Array.from(n.children).map(i => getComputedStyle(i).backgroundColor) : null; })()`,
  );
  console.log("GAUGE", gauge);

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
