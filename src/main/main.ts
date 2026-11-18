import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { autoUpdater } from "electron-updater";
import type { RpcMethod } from "../shared/contract";
import { Kernel } from "./kernel";
import { createCaptureHost } from "./capture-host";
import { defaultDataRoot } from "./settings";
import { resolveFeedUrl, feedUrlIssue, transition, type UpdateState } from "./updater";
import { newRendererLogGate, RENDERER_LOG_LIMITS, rendererLogGate } from "./log-policy";
import { trayFallbackBuffer, trayIconPaths } from "./tray-icon";
import { startBridge } from "./im-bridge";
import { buildImHandlers } from "./im-handlers";
import { FeishuChannel } from "./im-feishu";
import { needsUserAttention } from "./notify-policy";
import { VoiceService } from "./voice";
import { handleShellRpc, handleKernelAsync, isKernelAsyncMethod, type ShellRpcCtx } from "./shell-rpc";

/**
 * stdout/stderr 被管道提前关闭时（命令行重定向后管道断、IDE 启动器关流），
 * console.log 会抛 EPIPE；Electron 主进程把它当未捕获异常弹错误框，
 * 用户看到的是"A JavaScript error occurred in the main process"，与产品无关。
 * 写日志失败不该弄崩应用——吞掉 EPIPE，其余照旧抛。
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}

/**
 * console.log 写已关闭的管道时会**同步抛** EPIPE（不是 error 事件，拦不住），
 * Electron 主进程会把它弹成"A JavaScript error occurred in the main process"——
 * 用户看到的是崩溃框，其实只是日志写不出去。包一层：写不出去就跳过，别弄崩应用。
 */
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  try {
    rawLog(...args);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EPIPE") throw err;
  }
};

/**
 * Electron 主进程 —— 薄壳（§4.1）。
 * 只做：窗口、生命周期、IPC 转发、safeStorage 凭据加密。
 * 不含 Agent 逻辑、不含工具实现——那些在 kernel.ts（未来换成 Pi 运行时转发）。
 */

// 冷启动：GPU 着色器磁盘缓存在本机常因权限失败反复重试（disk_cache 报错），
// 内容每次都能重编译，关掉它只省磁盘 I/O，不影响画面。
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

/**
 * 低内存模式（LYNN_LOW_MEMORY=1）：关掉独立 GPU 进程与硬件合成。
 * 默认不开——桌面端动效需要合成器；只有内存受限环境显式开启。
 */
if (process.env.LYNN_LOW_MEMORY === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

/**
 * 渲染层异常落盘（白屏可见化）：console 的 error/warning、渲染进程崩溃、加载失败、
 * preload 报错、显式上报全进 logs/renderer.log（审计 #8：此前是裸 appendFileSync，
 * 无轮转/无截断/无限流，渲染进程高频上报能打满磁盘）。现在：
 *  - 每分钟 120 条限流，超限丢弃、窗口翻转时落一条汇总；
 *  - 单条 16K 字符截断；
 *  - 5MB 轮转到 renderer.old.log（只留一份，最坏两份共 10MB）。
 */
let rendererLogGateState = newRendererLogGate();
const logRenderer = (entry: Record<string, unknown>) => {
  try {
    const gate = rendererLogGate(rendererLogGateState, Date.now());
    rendererLogGateState = gate.state;
    const dir = path.join(defaultDataRoot(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "renderer.log");
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > RENDERER_LOG_LIMITS.rotateBytes) {
        fs.renameSync(file, path.join(dir, "renderer.old.log"));
      }
    } catch {
      /* 轮转失败不挡写入 */
    }
    let line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    if (line.length > RENDERER_LOG_LIMITS.entryMaxChars) {
      line = `${line.slice(0, RENDERER_LOG_LIMITS.entryMaxChars)}…（单条截断，原 ${line.length} 字符）\n`;
    }
    fs.appendFileSync(file, line, "utf-8");
    if (gate.droppedSummary) {
      fs.appendFileSync(
        file,
        JSON.stringify({ at: new Date().toISOString(), kind: "log_throttled", dropped: gate.droppedSummary }) + "\n",
        "utf-8",
      );
    }
  } catch {
    /* 日志写不进去不能拖垮界面 */
  }
};

const kernel = new Kernel();
/** IM 端点句柄（未启用时为 null；退出时要关掉，否则进程退不干净） */
let imBridge: Awaited<ReturnType<typeof startBridge>> | null = null;
/** 飞书渠道句柄（未启用为 null；退出时要停，否则 WSClient 的 socket 会让进程退不干净） */
let feishu: FeishuChannel | null = null;
// 用系统凭据库加密 API Key（§4.7：凭据只经内核注入，不下发渲染层）
kernel.setEncryptors(
  (plain) => safeStorage.encryptString(plain),
  () => safeStorage.isEncryptionAvailable(),
  (blob) => safeStorage.decryptString(blob),
);
// 系统通知通道（M2-03）：提醒/定时任务必达双通道之一；notifyOnce 自带"窗口可见就不打扰"
kernel.setNotifier((title, body) => notifyOnce(title, body));

let win: BrowserWindow | null = null;
let pet: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * 语音播报（2026-11-13）：内核只注入「该说什么」，合成与播放都在壳层。
 * 独立 lynn:voice 通道，不污染内核事件流；音频是 MP3 data URL，不落临时文件。
 */
const voice = new VoiceService({
  getPrefs: () => kernel.getPrefs(),
  emit: (ev) => {
    // 只发主窗口：桌宠是同一个渲染层的另一个 BrowserWindow，广播会双份播放
    if (win && !win.isDestroyed()) win.webContents.send("lynn:voice", ev);
  },
  isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
  // 合成失败/限流只写日志：界面不弹窗、不刷卡片，用户看到的只是"这次没播"
  onSynthesizeError: (message, reason) => kernel.noteVoiceFailure(message, reason),
});
kernel.setVoice(voice);

/**
 * 区域截图（M2-13 消费侧）：全局快捷键 / 托盘 / 输入框按钮都能起。
 * 截好的图先推事件、再留一份待取队列兜底（窗口刚起来或焦点切换时事件可能漏接），
 * 渲染层按 shot.id 去重；图片只进「本轮随附」，用户自己决定发不发。
 */
const captureHost = createCaptureHost({
  indexHtml,
  preload,
  hotkey: kernel.getPrefs().captureHotkey,
  focusMain: () => focusMain(),
  onShot: (shot) => {
    if (win && !win.isDestroyed()) win.webContents.send("lynn:event", { type: "capture", shot });
  },
});

/**
 * 应用窗口图标（2026-11-14）：assets/icon.png 是真正的 512×512 位图（不是 SVG）。
 * 打包时 assets/** 会一起带过去；build/icon.ico 只在安装器/快捷方式上用（见 electron-builder.yml）。
 * 找不到就返回 undefined —— 交给 Electron 默认图标，不假装设置成功。
 */
function appIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "assets", "icon.png"),
    path.join(__dirname, "..", "..", "assets", "icon.png"),
    path.join(app.getAppPath(), "build", "icon.ico"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** 托盘图标（M1-18）：assets/tray.png；路径解析失败时内嵌兜底，绝不给空图标 */
function trayIcon() {
  for (const p of trayIconPaths(app.getAppPath(), __dirname)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  const fallback = nativeImage.createFromBuffer(trayFallbackBuffer());
  if (fallback.isEmpty()) console.warn("[tray] 托盘图标文件缺失，内嵌兜底也失败");
  return fallback;
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("风铃 Lynn");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开指挥台", click: () => focusMain() },
      // 桌宠自 2026-11-15 起停用（渲染层 ?pet=1 返回 null）；恢复时取消下一行注释即可。
      // { label: "桌宠", click: () => createPet() },
      {
        label: "区域截图",
        click: () => {
          const r = captureHost.start();
          if (!r.ok) console.warn(`[capture] ${r.error ?? "截图没能启动"}`);
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => focusMain());
}

/** 全局快捷键：Alt+Shift+L 呼出指挥台（M1-18） */
function registerHotkey(): void {
  const combo = "Alt+Shift+L";
  try {
    const ok = globalShortcut.register(combo, () => focusMain());
    if (!ok) console.warn(`[hotkey] ${combo} 注册失败（可能被占用），托盘仍可用`);
  } catch (err) {
    console.warn(`[hotkey] 注册异常：${err instanceof Error ? err.message : String(err)}`);
  }
  // 截图快捷键单独注册：失败不牵连呼出键，状态可在设置里如实看到
  captureHost.register();
}

/** 系统通知（M1-18）：只在主窗口不可见时发，不做打扰源 */
function notifyOnce(title: string, body: string): void {
  const visible = win !== null && win.isVisible() && win.isFocused();
  if (visible || !kernel.getPrefs().notify) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => focusMain());
  n.show();
}

// ---------------- M1-23 更新器 ----------------

const updateState: UpdateState = {
  supported: false,
  version: app.getVersion(),
  phase: "idle",
};

function updateBroadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("lynn:event", { type: "update", state: { ...updateState } });
  }
}

let updaterInitialized = false;

/** 开关与事件监听只做一次；启动时没 feed 也不能跳过，否则懒配置会退回自动下载/自动安装。 */
function initializeUpdaterOnce(): void {
  if (updaterInitialized) return;
  updaterInitialized = true;
  autoUpdater.autoDownload = false; // 有新版本先告知，用户确认再下载
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => void 0);
  autoUpdater.on("update-available", (it) => {
    Object.assign(updateState, transition(updateState, { type: "available", version: it?.version }));
    updateBroadcast();
    notifyOnce(`有新版本 ${it?.version ?? ""}`, "到「我的风铃 → 数据与日志」下载安装。");
  });
  autoUpdater.on("update-not-available", () => {
    Object.assign(updateState, transition(updateState, { type: "not-available" }));
    updateBroadcast();
  });
  autoUpdater.on("download-progress", (p) => {
    Object.assign(updateState, transition(updateState, { type: "progress", percent: p.percent }));
    updateBroadcast();
  });
  autoUpdater.on("update-downloaded", (it) => {
    Object.assign(updateState, transition(updateState, { type: "downloaded", version: it?.version }));
    updateBroadcast();
    notifyOnce("更新已就绪", "重启应用即完成安装。");
  });
  autoUpdater.on("error", (err) => {
    Object.assign(updateState, transition(updateState, { type: "error", message: err?.message }));
    updateBroadcast();
  });
}

function bindUpdater(): void {
  initializeUpdaterOnce();
  if (!app.isPackaged) {
    updateState.supported = false;
    updateState.reason = "开发环境不检查更新（打包后可用）。";
    return;
  }
  const feed = resolveFeedUrl(process.env, kernel.dataRoot);
  const feedIssue = feed ? feedUrlIssue(feed) : null;
  if (!feed || feedIssue) {
    updateState.supported = false;
    updateState.reason = feedIssue ?? "未配置更新源：在 ~/.lynn/updater.json 写 { feedUrl } 或设 LYNN_UPDATE_FEED。";
    return;
  }
  updateState.supported = true;
  updateState.feedUrl = feed;
  autoUpdater.setFeedURL({ provider: "generic", url: feed });
}

// 消息平台（M2-16）已于 2026-11-18 移除：只能发不能收的半成品。
// IM 能力改由插件提供（外部网关通过本地 HTTP 端点接入）。

async function handleUpdateRpc(method: string): Promise<unknown> {
  // update.check 可能在这里才补配 feed；幂等初始化必须先于任何 feed 校验。
  initializeUpdaterOnce();
  if (method === "update.status") return { ...updateState };
  if (!updateState.supported) {
    if (method === "update.check") {
      // 每次都重读配置：用户可能刚写好 updater.json
      const feed = resolveFeedUrl(process.env, kernel.dataRoot);
      const feedIssue = feed ? feedUrlIssue(feed) : null;
      if (feed && !feedIssue && app.isPackaged) {
        updateState.supported = true;
        updateState.reason = undefined;
        updateState.feedUrl = feed;
        autoUpdater.setFeedURL({ provider: "generic", url: feed });
      } else {
        // 配了但不是 HTTPS：把原因如实写进状态，别让用户对着"不可更新"猜
        if (feedIssue) {
          updateState.supported = false;
          updateState.reason = feedIssue;
        }
        return { ...updateState, error: updateState.reason ?? "不可更新" };
      }
    } else {
      return { ...updateState, error: updateState.reason ?? "不可更新" };
    }
  }
  try {
    if (method === "update.check") {
      Object.assign(updateState, transition(updateState, { type: "checking" }));
      await autoUpdater.checkForUpdates();
      return { ...updateState };
    }
    if (method === "update.download") {
      if (updateState.phase !== "available") return { ...updateState, error: "没有待下载的更新" };
      updateState.phase = "downloading";
      updateBroadcast();
      await autoUpdater.downloadUpdate();
      return { ...updateState };
    }
    if (method === "update.install") {
      if (updateState.phase !== "downloaded") return { ...updateState, error: "更新还没下载完" };
      quitting = true;
      autoUpdater.quitAndInstall(false, true);
      return { ...updateState };
    }
  } catch (err) {
    Object.assign(updateState, transition(updateState, { type: "error", message: err instanceof Error ? err.message : String(err) }));
    return { ...updateState };
  }
  return { ...updateState };
}

// 函数声明而非 const 箭头：截图壳层在模块顶层就要拿到这两个路径（提升，避开 TDZ）
function preload(): string {
  return path.join(__dirname, "preload.js");
}
function indexHtml(): string {
  return path.join(__dirname, "../renderer/index.html");
}

/** 上次用的主题底色：渲染层切换时写进来，首帧直接用，避免亮色主题先闪一帧暗底 */
function lastBackground(): string {
  try {
    const file = path.join(app.getPath("userData"), "appearance.json");
    const j = JSON.parse(fs.readFileSync(file, "utf-8")) as { desk?: string };
    if (typeof j.desk === "string" && /^#[0-9a-f]{6}$/i.test(j.desk)) return j.desk;
  } catch {
    /* 首次启动没有这个文件 */
  }
  return "#0d1116";
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    // 首帧就是上次的主题底色（默认夜航暗色），不闪白也不闪错色
    backgroundColor: lastBackground(),
    show: false,
    icon: appIcon(),
    title: "风铃 Lynn · 指挥台",
    // 自绘标题栏：不要系统标题栏，最小化/最大化/关闭由渲染层顶栏实现（拖拽走 -webkit-app-region）
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // logRenderer 已提升为模块级（createWindow 与 lynn:log-error 上报共用一份限流/轮转状态）
  // Electron 29+ 改成 (event, details) 对象；旧签名是 (event, level:number, message, line, sourceId)。
  // 两种都兜住，免得升级/降级后日志静默失效。
  type ConsoleArgs = [unknown, unknown, unknown?, unknown?, unknown?];
  (win.webContents as unknown as { on(ev: string, cb: (...a: ConsoleArgs) => void): void }).on("console-message", (...args) => {
    const maybe = args[1];
    const obj = typeof maybe === "object" && maybe !== null ? (maybe as { level?: string; message?: string; lineNumber?: number; sourceId?: string }) : null;
    const level =
      obj?.level ??
      (typeof maybe === "number" ? (maybe >= 3 ? "error" : maybe === 2 ? "warning" : "info") : "info");
    if (level !== "error" && level !== "warning") return;
    const message = obj?.message ?? (typeof args[2] === "string" ? args[2] : "");
    logRenderer({
      kind: "console",
      level,
      message: message.slice(0, 4000),
      source: obj?.sourceId ?? (typeof args[4] === "string" ? args[4] : undefined),
      line: obj?.lineNumber ?? (typeof args[3] === "number" ? args[3] : undefined),
    });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logRenderer({ kind: "render-process-gone", reason: details.reason, exitCode: details.exitCode });
    // 渲染进程没了就是白屏：直接重载一次，别让用户对着空白窗口
    if (!win?.isDestroyed() && details.reason !== "clean-exit") setTimeout(() => win?.reload(), 300);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    logRenderer({ kind: "did-fail-load", code, desc, url });
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logRenderer({ kind: "preload-error", preloadPath, message: error?.message, stack: error?.stack });
  });

  win.once("ready-to-show", () => win?.show());
  // 最大化状态同步给渲染层（自绘按钮要显示"最大化/还原"两个态）
  const sendMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send("lynn:event", { type: "window", maximized: win.isMaximized() });
  };
  win.on("maximize", sendMaximized);
  win.on("unmaximize", sendMaximized);
  // 外链一律交给系统浏览器；应用内导航只允许同一个 file:// 文档
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault();
  });

  void win.loadFile(indexHtml());
  // M1-18：关窗进托盘（可关），不杀会话；托盘菜单「退出」才真退
  win.on("close", (event) => {
    if (!quitting && kernel.getPrefs().trayOnClose) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

/** 桌宠模式（P2）：无边框透明置顶小窗，形象自己待机；单击唤回主界面 */
function createPet(): void {
  if (pet) {
    pet.show();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  pet = new BrowserWindow({
    width: 300,
    height: 450,
    x: workArea.x + workArea.width - 320,
    y: workArea.y + workArea.height - 470,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pet.setAlwaysOnTop(true, "floating");
  void pet.loadFile(indexHtml(), { query: { pet: "1" } });
  pet.on("closed", () => {
    pet = null;
  });
}

function focusMain(): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
  pet?.close();
}

/** 单实例：两个实例会抢同一个 session/*.jsonl 与会话文件 */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", () => focusMain());

app.whenReady().then(async () => {
  if (!singleInstance) return;
  // 首屏优先：窗口、托盘、快捷键、更新器先起来，不等内核的插件/MCP/office 探测。
  // 内核构造函数已经把会话、记忆、台账、工具面备好；后台 init 完成后，
  // L1/MCP 指纹变化会让下一条消息自动重建 Pi worker（不丢能力）。
  createWindow();
  createTray();
  registerHotkey();
  bindUpdater();

  // 渲染层显式上报（window.onerror / unhandledrejection / React 边界）：走统一限流/轮转通道
  ipcMain.on("lynn:log-error", (_event, payload: { kind: string; message: string; stack?: string; source?: string }) => {
    logRenderer(payload);
  });

  // 唯一 RPC 通道：壳层方法走注册表（shell-rpc.ts，审计 #14 拆分第一刀），未命中落回内核
  const shellCtx: ShellRpcCtx = {
    kernel,
    getWin: () => win,
    createPet,
    closePet: () => pet?.close(),
    focusMain,
    captureHost,
    voice,
    handleUpdate: handleUpdateRpc,
  };
  ipcMain.handle("lynn:rpc", async (_event, method: string, params: unknown) => {
    try {
      const handled = await handleShellRpc(method, params, shellCtx);
      if (handled !== undefined) return handled;
      if (isKernelAsyncMethod(method)) return handleKernelAsync(method, params, shellCtx);
      return kernel.handle(method as RpcMethod, params);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 事件流：流式 delta / 工具卡 / 完成 / 错误 → 渲染层
  kernel.onEvent((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send("lynn:event", ev);
    }
    // M1-18：窗口不可见时用系统通知触达（成员交活 / 需要拍板 / 出错）
    const evAny = ev as { type?: string; card?: { kind?: string; badge?: string; title?: string; text?: string; code?: string } };
    if (evAny.type === "card" && evAny.card) {
      const c = evAny.card;
      if (c.kind === "tool" && (c.badge === "回报" || c.badge === "需要你拍板")) {
        notifyOnce(c.title || "成员交活了", (c.text || "进审查台看看。").slice(0, 120));
      } else if (c.kind === "system" && c.code) {
        // 5xx / 429 / 网络抖动是转瞬即逝的运行错误，落 feed 就够；
        // 只有「用户必须动手」的错误才发系统通知，避免右下角反复弹「风铃遇到了问题」。
        if (needsUserAttention(c.code)) notifyOnce("风铃遇到了问题", (c.text || "").slice(0, 120));
      }
    }
  });

  // 内核后台初始化：不再挡首屏。失败只记日志，不把窗口变白屏。
  void (async () => {
    try {
      await kernel.init();
      const boot = kernel.noteKernelStart();
      console.log(`[plugins] fingerprint=${boot.fingerprint} safeMode=${boot.safeMode} starts=${boot.starts}`);
      /**
       * IM 端点（2026-11-18 P13-5）。
       *
       * **默认不启动**：它是联网能力（外部 IM 网关会连进来），
       * 与"完全本地"的约束冲突，必须由用户显式开启。
       *
       * 开启方式：设置 `LYNN_IM_BRIDGE=1` 环境变量，或将来在设置页加开关。
       * 未开启时**一个端口都不监听**——不给攻击面留口子。
       */
      if (process.env.LYNN_IM_BRIDGE === "1") {
        try {
          imBridge = await startBridge({ handlers: buildImHandlers(kernel.imHost()) });
          console.log(`[im] 端点已启动：${imBridge.baseUrl}`);
          /**
           * token 打到日志里是有意的：这是**本机**的一次性凭据，
           * 用户要从日志里复制它去配 IM 网关。不写日志用户就配不上。
           * 它只在本进程生命周期内有效，重启即换。
           */
          console.log(`[im] token: ${imBridge.token}`);
          console.log(`[im] 用法：POST ${imBridge.baseUrl}/api/host.describe`);

          /**
           * 飞书渠道（2026-11-18 P14-1）：端点起来后按配置启动。
           *
           * 三道闸都在 `FeishuChannel` 里：白名单为空拒绝启动、发送者不在白名单忽略、
           * 群聊默认不响应。这里只负责解密 secret 并传下去。
           */
          const fs2 = kernel.imChannels().feishu;
          if (fs2?.enabled) {
            try {
              feishu = new FeishuChannel({
                config: {
                  appId: fs2.appId,
                  appSecret: fs2.appSecret,
                  allowOpenIds: fs2.allowOpenIds,
                  allowGroup: fs2.allowGroup,
                },
                ask: async (text) => {
                  const host = kernel.imHost();
                  host.submitTurn(text);
                  await host.waitTurn();
                  // 取这一轮最后一条助手消息作为回答
                  const msgs = host.threadHistory(host.currentThreadId());
                  const last = [...msgs].reverse().find((m) => (m as { role?: string }).role === "assistant");
                  return String((last as { text?: string })?.text ?? "（这一轮没有产出文本）");
                },
                log: (event, detail) => kernel.logFromShell(event, detail),
                onState: (state, detail) => console.log(`[im] 飞书：${state}${detail ? `（${detail}）` : ""}`),
              });
              await feishu.start();
              console.log("[im] 飞书渠道已连接");
            } catch (err) {
              // 渠道连不上不该影响应用启动
              console.error("[im] 飞书渠道启动失败：", err instanceof Error ? err.message : err);
            }
          }
        } catch (err) {
          // 端点起不来不该影响应用启动——记日志，继续用本地功能
          console.error("[im] 端点启动失败：", err);
        }
      }
    } catch (err) {
      console.error("[kernel] init failed:", err);
    }
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;

app.on("before-quit", (event) => {
  captureHost.dispose();
  globalShortcut.unregisterAll();
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  // 收尾：Pi 子进程与 MCP server 都要停掉，不靠进程退出时被顺带回收
  void (async () => {
    // IM 渠道先停：WSClient 持有 socket，不关会让进程退不干净
    try {
      feishu?.stop();
    } catch (err) {
      console.error("[im] 停止飞书渠道失败：", err);
    }
    // 再关端点：它监听端口
    try {
      await imBridge?.close();
    } catch (err) {
      console.error("[im] 关闭端点失败：", err);
    }
    await kernel.dispose();
  })().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export { createPet, focusMain };
