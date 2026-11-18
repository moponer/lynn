// 把构建后的渲染层用 Electron 打开、截图，供设计走查。
// 用法：npx electron scripts/preview-shot.cjs [输出路径] [settings|review|standby|wizard|pet|pending] [主题:亮暗]
// 窄窗走查：LYNN_PREVIEW_WIDTH=1180 LYNN_PREVIEW_HEIGHT=900
const { app, BrowserWindow } = require("electron");

// 审批卡走查：夹具由 preload 按这个变量决定是否带 family

if (process.argv[3] === "allowfamily") process.env.LYNN_PREVIEW_APPROVE = "1";
const path = require("node:path");
const fs = require("node:fs");

const out = process.argv[2] || path.join(__dirname, "..", "shots", "desk.png");
// 走查「信任询问」：假装用户真选了一个目录（必须在窗口/preload 起来之前设，preload 拿的是进程启动时的环境）
if (process.argv[3] === "trustask") process.env.LYNN_PREVIEW_PICKDIR = "F:/spiker/hermix-desktop";
// 表格回报走查：夹具同样要在 preload 起来之前挂上
if (process.argv[3] === "reporttable") process.env.LYNN_PREVIEW_TABLEREPORT = "1";
// 群内协作走查（2026-11-16）：成员的进展/结论/疑问与风铃的回答（夹具同 preload，必须提前设）
if (process.argv[3] === "dialogue") process.env.LYNN_PREVIEW_DIALOGUE = "1";
const W = Number(process.env.LYNN_PREVIEW_WIDTH) || 1600;
const H = Number(process.env.LYNN_PREVIEW_HEIGHT) || 1000;

// stdout 被管道提前关闭时（PowerShell 的 Select-Object -First / Select-String 截断），
// 继续写日志会 EPIPE；Electron 主进程把它当未捕获异常弹框，整次走查直接崩掉。
// 写日志失败不该弄崩走查——吞掉 EPIPE，其余照旧抛。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}

/**
 * 等页面真的就绪（固定等待在冷启动时不靠谱：Electron 首次起进程可能慢一拍，
 * 走查代码一抛错整条链就断在截图之前 → 走查跑完却没有图）。
 */
async function waitFor(check, timeoutMs = 10000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await check()) return true;
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** 走查结果落文件：别指望 stdout（管道随时可能被截断） */
function writeJson(name, data) {
  try {
    const file = path.join(path.dirname(out), path.basename(out, path.extname(out)) + ".json");
    fs.writeFileSync(file, JSON.stringify({ [name]: data }, null, 2), "utf-8");
  } catch {
    /* 落盘失败不影响截图 */
  }
}

// stdout 被管道提前关闭时（PowerShell 的 Select-Object -First / Select-String 截断），
// 继续写日志会 EPIPE。EPIPE 在写已关闭的管道时是**同步抛出**（堆栈：console.log →
// WriteStream.write → throw），'error' 事件拦不住，会变成 unhandled exception，
// 被 Electron 主进程弹成"A JavaScript error occurred in the main process"。
// 两道防线：stream 事件 + 包住 console.log。写日志失败不该弄崩走查。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}
const rawLog = console.log.bind(console);
console.log = (...args) => {
  try {
    rawLog(...args);
  } catch (err) {
    if (!err || err.code !== "EPIPE") throw err;
  }
};

// stdout 的 EPIPE 在 Node 里默认会让进程直接退出（SIGPIPE 语义）——
// 走查脚本因此可能"跑了一半什么都没产出"。吞掉 EPIPE，让它跑完并把结果写文件。
process.on("uncaughtException", (err) => {
  const code = err && err.code;
  if (code === "EPIPE") return;
  throw err;
});

app.disableHardwareAcceleration();
// review/e3 模式都要见到验收印章（决策印章优先级更高），关掉 A5 演示裁决
if (process.argv[3] === "review" || process.argv[3] === "e3") process.env.LYNN_PREVIEW_NO_DECISIONS = "1";
app.whenReady().then(async () => {
  // 走查代码抛错不该连累截图：截图在最后，异常一路冒上来就什么都没有了
  try {
  const isPet = process.argv[3] === "pet";
  const win = new BrowserWindow({
    // 与 main.ts createPet() 的真实桌宠窗保持一致（300×450），
    // 走查窗偏小会把角色下半身裁掉，误判成「素材看不到全身」。
    width: isPet ? 300 : W,
    height: isPet ? 450 : H,
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

  const petMood = process.env.LYNN_PET_MOOD;
  await win.loadFile(
    path.join(__dirname, "..", "dist", "renderer", "index.html"),
    isPet ? { query: petMood ? { pet: "1", mood: petMood } : { pet: "1" } } : undefined,
  );
  await new Promise((r) => setTimeout(r, 600));
  // 等应用真的画出来（冷启动可能慢）：左栏群行或右栏成员卡出现即视为就绪
  await waitFor(
    () => win.webContents.executeJavaScript("!!document.querySelector('.thread-row, .mcard, .feed-item')"),
    12000,
  );

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
  // 可选：打开「我的风铃」面板
  // 可选：我的风铃 → 权限与安全（看「顾问审阅」一行：标题/说明/开关文案）
  // 可选：审批卡「这类以后都允许」
  // 走查模式注册表（2026-11-14）：每加一个场景就在 scripts/shots/ 放一个 .cjs，
  // 主文件不再堆 if 块。args[3] 命中哪个 mode 就跑哪个。
  const shotsDir = path.join(__dirname, "shots");
  const shotModules = fs.existsSync(shotsDir)
    ? fs
        .readdirSync(shotsDir)
        .filter((f) => f.endsWith(".cjs"))
        .map((f) => require(path.join(shotsDir, f)))
    : [];
  const shotModule = shotModules.find((m) => m.mode === process.argv[3]);
  if (shotModule) await shotModule.run({ win, app, fs, path, writeJson, out, W, H });

  // 可选：我的风铃 → 团队（编制管理）
  // 可选：我的风铃 → 团队 → 展开头像库（看 12 张工牌照）
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
  // 可选：归档带走查（默认折叠 5 条 + 第一行模拟 hover 显出 ×）
  // 可选：工单详情（阶段刻度是否只让当前环节转、页签按钮是否去分层）
  // 可选：右栏编制区读数（2026-11-12）：chip 计数、分组标题、群公告是否渲染
  // 可选：消耗看板（2026-11-13）：右栏编制区上方应出现风铃/成员的命中率与消耗行
  // 可选：右键菜单在窗口底部应向上弹出（2026-11-13 修复：此前溢出窗口看不见）
  // 可选：群公告长文本应折叠（2026-11-13 修复：此前全部铺开顶着右栏）
  // 诊断：列出预览 DOM 里可用于右键的候选元素
  // 可选：字头像各处尺寸实读（2026-11-13）：群聊头 20px / 成员卡 36px / 资料卡 40px
  // 可选：对话里「产物」chip 的右键菜单（2026-11-13）
  // 可选：证据链页签里的右键菜单（2026-11-13：证据与产物共用「文件」菜单）
  // 可选：交付箱右键菜单 + 「查看所属」资料卡（2026-11-13）
  if (process.argv[3] === "outmenu" || process.argv[3] === "outinfo") {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')].find(x=>(x.textContent||'').includes('交付箱')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    // 在行上派发 contextmenu（合成事件带坐标，菜单才能定位）
    await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.out-row');
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: Math.round(r.x + 40), clientY: Math.round(r.y + 12),
      }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const menu = await win.webContents.executeJavaScript(`(() => ({
      items: [...document.querySelectorAll('.jobmenu-item')].map(b => b.textContent.trim()),
      title: document.querySelector('.jobmenu-title')?.textContent.trim() ?? null,
      sub: document.querySelector('.jobmenu-sub')?.textContent.trim() ?? null,
    }))()`);
    console.log("OUTMENU", JSON.stringify(menu));

    // 删除交付物 → 统一确认卡片（2026-11-15）：两个后果明确摆出来，不再二次弹系统确认
    if (process.argv[3] === "outmenu") {
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => x.textContent.includes('删除'));
        if (!it) return false;
        it.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 450));
      const card = await win.webContents.executeJavaScript(`(() => {
        const c = document.querySelector('.ask-card');
        if (!c) return null;
        return {
          title: c.querySelector('.ask-title')?.textContent.trim() ?? null,
          body: c.querySelector('.ask-body')?.textContent.trim() ?? null,
          note: c.querySelector('.ask-note')?.textContent.trim() ?? null,
          btns: [...c.querySelectorAll('.ask-btn')].map((b) => ({
            t: b.textContent.trim(),
            cls: b.className.replace('ask-btn ', ''),
            bg: getComputedStyle(b).backgroundColor,
          })),
          focused: document.activeElement?.textContent?.trim() ?? null,
        };
      })()`);
      console.log("OUTDELETE", clicked, JSON.stringify(card, null, 1));
    }
  }

  // 可选：交付箱（2026-11-13）：同一物理文件被多张单更新时只能有一行
  // 可选：在跑成员的动态信号（2026-11-13）：扩散环 + 卡底进度线真的在动
  // 可选：长回报折叠（2026-11-13）：超一屏的回报应折成前几行 + 「展开全文」
  // 可选：编制区标题右侧的图标按钮（2026-11-13）：点「新建」应出命名输入行
  // 可选：信任询问（2026-11-13）：选目录当场问「信任并加载 / 先不信任」
  // 可选：右栏「去那个群」跳转（点组头 → 切到那个群 → 本群/他群重新分家）
  // 可选：顶栏工作区菜单（验证 fixed 定位没有被图纸裁掉/盖住）
  // 可选：成员战绩按需展开（验证 RPC 通路与卡内展示）
  // 可选：运行信号（成员卡呼吸环、工单卡呼吸环、进度卡「执行中」）
  // 可选：控制台「需用户动手」是否在主界面弹出（待验收 / 待拍板）
  // 可选：控制台产出柜（真文件卡 + 点开内置预览）
  // 可选：战果抽屉（产出柜「全部 N 件」入口）——产物清单是否只列真文件、是否可点开
  // 可选：内置预览抽屉（交付箱 → 第一份报告），验证 md 排版与代码高亮
  // 可选：控制台 → 档案抽屉（看无主单清理出口）
  // 可选：进待机（Ctrl+.）
  // 可选：窄窗下点顶栏「待办 (n)」把右栏抽屉拉开
  // 可选：进入审查台（E3 后印章"打回"就地展开，进审查台走「打开完整验收包」链接）
  // 可选：E3 打回三要素在印章就地展开
  // 可选：Ctrl+K 命令面板（E6）
  // 可选：点开当前会话条，展示会话面板（E4：会话全文搜索框）
  // 可选：会话改名 / 删除入口（C5）：先验改名输入框出现并 Esc 可取消，再展开删除确认条
  // 可选：任务总览（多任务并行：几个在跑、各自团队与进度、去会话）
  // 可选：工单卡右键菜单（卡住的单：打开 / 去会话 / 停 / 取消 / 删除）
  // 可选：多条挂起裁决翻到下一条（A5）
  // 可选：群聊渲染走查（用户右对齐 / 成员带头像与岗位 / @芯片 / 陌生 @ 的提示）
  // 可选：群聊 P1 走查（左栏群列表 + 右栏本群置顶 + 成员右键菜单）
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
  } catch (err) {
    // 走查失败要说清，别只留下"没有图"
    console.log("SHOT_ERR", String(err && err.stack ? err.stack : err));
    try {
      app.quit();
    } catch {
      /* 退出失败无所谓 */
    }
  }
});
