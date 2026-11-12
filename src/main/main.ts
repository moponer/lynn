import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { autoUpdater } from "electron-updater";
import type { CaptureRect, RpcMethod } from "../shared/contract";
import { Kernel } from "./kernel";
import { createCaptureHost } from "./capture-host";
import { defaultDataRoot } from "./settings";
import { resolveFeedUrl, transition, type UpdateState } from "./updater";
import { discoverModels } from "./providers";
import {
  COMPLIANCE_NOTE,
  configureChannel,
  feishuSend,
  loadMessaging,
  qqSend,
  resolveEnabledChannel,
  saveMessaging,
  type ChannelConfig,
  type TokenCache,
} from "./messaging";
import { trayFallbackBuffer, trayIconPaths } from "./tray-icon";
import { needsUserAttention } from "./notify-policy";

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

const kernel = new Kernel();
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
      { label: "桌宠", click: () => createPet() },
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

function bindUpdater(): void {
  if (!app.isPackaged) {
    updateState.supported = false;
    updateState.reason = "开发环境不检查更新（打包后可用）。";
    return;
  }
  const feed = resolveFeedUrl(process.env, kernel.dataRoot);
  if (!feed) {
    updateState.supported = false;
    updateState.reason = "未配置更新源：在 ~/.lynn/updater.json 写 { feedUrl } 或设 LYNN_UPDATE_FEED。";
    return;
  }
  updateState.supported = true;
  updateState.feedUrl = feed;
  autoUpdater.autoDownload = false; // 有新版本先告知，用户确认再下载
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: "generic", url: feed });
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

// 消息平台（M2-16）：合规路径——官方 API + 用户自建应用；凭据加密落盘
const msgTokenCache: Record<"feishu" | "qq", TokenCache> = { feishu: {}, qq: {} };

function decryptSecret(secret: ChannelConfig["secret"]): string {
  return secret.encrypted ? safeStorage.decryptString(Buffer.from(secret.data, "base64")) : secret.data;
}

async function handleMsgRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "msg.configure") {
    const p = params as { channel: "feishu" | "qq"; appId: string; appSecret?: string; enable?: boolean };
    const encrypt: (plain: string) => ChannelConfig["secret"] = (plain) =>
      safeStorage.isEncryptionAvailable()
        ? { encrypted: true, data: safeStorage.encryptString(plain).toString("base64") }
        : { encrypted: false, data: plain };
    const r = configureChannel(loadMessaging(kernel.dataRoot), p.channel, p, encrypt);
    if (!r.ok) return { ok: false, error: r.error };
    saveMessaging(kernel.dataRoot, r.next);
    return { ok: true, compliance: COMPLIANCE_NOTE };
  }

  // msg.send
  const p = params as { channel: "feishu" | "qq"; receiveId: string; text: string };
  const guard = resolveEnabledChannel(loadMessaging(kernel.dataRoot), p.channel);
  if (!guard.ok) return { ok: false, error: guard.error };
  const secret = decryptSecret(guard.ch.secret);
  try {
    return p.channel === "feishu"
      ? await feishuSend({ appId: guard.ch.appId, appSecret: secret }, String(p.receiveId), String(p.text), globalThisFetch, msgTokenCache.feishu)
      : await qqSend({ appId: guard.ch.appId, appSecret: secret }, String(p.receiveId), String(p.text), globalThisFetch, msgTokenCache.qq);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const globalThisFetch = ((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  fetch(url, init as RequestInit)) as never;

async function handleUpdateRpc(method: string): Promise<unknown> {
  if (method === "update.status") return { ...updateState };
  if (!updateState.supported) {
    if (method === "update.check") {
      // 每次都重读配置：用户可能刚写好 updater.json
      const feed = resolveFeedUrl(process.env, kernel.dataRoot);
      if (feed && app.isPackaged) {
        updateState.supported = true;
        updateState.reason = undefined;
        updateState.feedUrl = feed;
        autoUpdater.setFeedURL({ provider: "generic", url: feed });
      } else {
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

  /**
   * 渲染层异常落盘（白屏可见化）：白屏时没有任何现场，之前只能靠猜。
   * console 的 error/warning、渲染进程崩溃、加载失败、preload 报错、显式上报全进 logs/renderer.log。
   */
  const logRenderer = (entry: Record<string, unknown>) => {
    try {
      const dir = path.join(defaultDataRoot(), "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "renderer.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
    } catch {
      /* 日志写不进去不能拖垮界面 */
    }
  };
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

  // 渲染层显式上报（window.onerror / unhandledrejection / React 边界）：只写日志
  ipcMain.on("lynn:log-error", (_event, payload: { kind: string; message: string; stack?: string; source?: string }) => {
    try {
      const dir = path.join(defaultDataRoot(), "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "renderer.log"), JSON.stringify({ at: new Date().toISOString(), ...payload }) + "\n", "utf-8");
    } catch {
      /* 同上：写不进去不炸 */
    }
  });

  // 唯一 RPC 通道
  ipcMain.handle("lynn:rpc", async (_event, method: string, params: unknown) => {
    try {
      // 窗口相关的调用归壳（不进内核）
      if (method === "pet.open") {
        createPet();
        return { ok: true };
      }
      if (method === "pet.close") {
        pet?.close();
        return { ok: true };
      }
      if (method === "pet.focus") {
        focusMain();
        return { ok: true };
      }
      if (method.startsWith("update.")) {
        return await handleUpdateRpc(method);
      }
      if (method === "providers.discover") {
        const p = params as { baseUrl: string; apiKey?: string };
        if (!p.baseUrl) return { models: [], error: "缺 baseUrl" };
        return await discoverModels(p.baseUrl, p.apiKey);
      }
      if (method === "msg.configure" || method === "msg.send") {
        return await handleMsgRpc(method, params as Record<string, unknown>);
      }
      if (method === "plugins.probe") {
        return kernel.probePlugin((params as { id: string }).id);
      }
      // 区域截图：捕获与窗口都在壳层，内核完全不参与（不进模型工具面）
      if (method === "capture.status") return captureHost.status();
      if (method === "capture.start") return captureHost.start();
      if (method === "capture.frame") return captureHost.frame();
      if (method === "capture.commit") {
        const p = params as { rect?: Partial<CaptureRect>; dataUrl?: string; action?: string } | undefined;
        const r = p?.rect;
        if (!r || ![r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
          return { ok: false, error: "选区坐标无效" };
        }
        if (typeof p?.dataUrl !== "string" || !["attach", "copy", "save"].includes(p.action ?? "")) {
          return { ok: false, error: "完成动作或图片数据无效" };
        }
        return captureHost.commit({ rect: r as CaptureRect, dataUrl: p.dataUrl, action: p.action as "attach" | "copy" | "save" });
      }
      if (method === "capture.cancel") return captureHost.cancel();
      if (method === "capture.pending") return { shots: captureHost.takePending() };
      // 改了截图快捷键要立刻重注册全局热键（设置页只跟内核打交道，热键归壳层）
      if (method === "config.prefs") {
        const r = kernel.handle("config.prefs", params);
        const p = params as { captureHotkey?: string };
        const out = r as { ok?: boolean; captureHotkey?: string };
        if (p.captureHotkey !== undefined && out.ok && out.captureHotkey) {
          const changed = captureHost.setHotkey(out.captureHotkey);
          if (!changed.ok) console.warn(`[capture] ${changed.error ?? "改键没生效"}`);
        }
        return r;
      }
      // 自绘标题栏：窗口控制归壳（不经过内核）
      if (method === "window.control") {
        const p = params as { action: "minimize" | "maximize" | "close" | "query" };
        if (!win || win.isDestroyed()) return { ok: true, maximized: false };
        if (p.action === "minimize") {
          win.minimize();
        } else if (p.action === "maximize") {
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
        } else if (p.action === "close") {
          // 走 close 事件：尊重"关窗进托盘"设置（真退由托盘菜单触发）
          win.close();
        }
        return { ok: true, maximized: win.isMaximized() };
      }
      if (method === "app.appearance") {
        const p = params as { mode?: string; desk?: string };
        if (typeof p.desk === "string") win?.setBackgroundColor(p.desk);
        try {
          fs.writeFileSync(
            path.join(app.getPath("userData"), "appearance.json"),
            JSON.stringify({ mode: p.mode, desk: p.desk }),
            "utf-8",
          );
        } catch {
          /* 写不了就下次再试 */
        }
        return { ok: true };
      }
      if (method === "evidence.open") {
        const p = params as { taskId: string; ref: string };
        const base = path.resolve(kernel.dataRoot, "tasks", p.taskId);
        const target = path.resolve(base, p.ref);
        // 目录外的交付物（只读根原件 / 超 10MB 未复制进 artifacts）只登记绝对路径：
        // 认 task.json 里登记过的那几个，别的一律照旧拒绝。
        if (!target.startsWith(base + path.sep)) {
          const abs = path.isAbsolute(String(p.ref ?? ""));
          if (!abs || !kernel.isTaskDeliverable(p.taskId, String(p.ref ?? ""))) {
            return { ok: false, error: "证据路径越界，已拒绝" };
          }
        }
        if (!fs.existsSync(target)) return { ok: false, error: "文件不存在（可能已被移动）" };
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
      if (method === "preview.read") {
        // 内置预览：只把内容交给渲染层，不调 shell.openPath，外部程序零启动开销。
        // 路径守卫与 evidence.open 完全一致，前端拿不到工作区之外的字节。
        const p = params as { taskId: string; ref: string };
        const base = path.resolve(kernel.dataRoot, "tasks", p.taskId);
        const target = path.resolve(base, String(p.ref ?? ""));
        if (!target.startsWith(base + path.sep)) {
          const abs = path.isAbsolute(String(p.ref ?? ""));
          if (!abs || !kernel.isTaskDeliverable(p.taskId, String(p.ref ?? ""))) {
            return { ok: false, kind: "missing", error: "预览路径越界，已拒绝" };
          }
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return { ok: false, kind: "missing", error: "文件不存在（可能已被移动）" };
        }
        const ext = path.extname(target).slice(1).toLowerCase();
        const bytes = fs.statSync(target).size;
        const mime: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
          webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
        };
        if (mime[ext]) {
          if (bytes > 8 * 1024 * 1024) return { ok: true, kind: "binary", ext, bytes };
          const buf = fs.readFileSync(target);
          return { ok: true, kind: "image", dataUrl: `data:${mime[ext]};base64,${buf.toString("base64")}`, ext, bytes };
        }
        // PDF：沙箱 iframe 里开不了 Chromium 阅读器，返回标记由抽屉引导开独立预览窗口
        if (ext === "pdf") return { ok: true, kind: "pdf", ext, bytes };
        // Office 三件套（docx/xlsx/pptx）：渲染层用开源库保真渲染（docx-preview /
        // @js-preview/excel / pptx-preview，懒加载），主进程只递字节。此前自研的
        // docx→HTML 只能出"素颜正文"，图片样式全丢；正文提取仍走 docx-read（read_artifact）。
        if (ext === "docx" || ext === "docm" || ext === "xlsx" || ext === "xlsm" || ext === "pptx") {
          const OFFICE_LIMIT = 16 * 1024 * 1024;
          if (bytes > OFFICE_LIMIT) {
            return { ok: true, kind: "binary", ext, bytes, error: "文件超过 16MB，内置预览带不动，请用系统程序打开。" };
          }
          return { ok: true, kind: "office", ext, bytes, dataBase64: fs.readFileSync(target).toString("base64") };
        }
        const LIMIT = 600_000;
        const fd = fs.openSync(target, "r");
        const take = Math.min(bytes, LIMIT);
        const buf = Buffer.alloc(take);
        try {
          fs.readSync(fd, buf, 0, take, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (bytes === 0) return { ok: true, kind: "empty", ext, bytes };
        // 二进制（xlsx/pptx/zip…）不做乱码文本预览，如实说清有什么替代路径
        if (buf.includes(0)) {
          const hint: Record<string, string> = {
            xlsx: "Excel 文件暂无内置预览。可以让风铃用 office_read_table 把数据读出来，或转存成 CSV 再看。",
            pptx: "演示文稿暂无内置预览，可用系统程序打开。",
            doc: "旧版 .doc 不支持内置预览；让风铃转存成 .docx 就能直接看。",
            zip: "压缩包不做解包预览，可用系统程序打开。",
          };
          return { ok: true, kind: "binary", ext, bytes, error: hint[ext] };
        }
        return { ok: true, kind: "text", text: buf.toString("utf8"), ext, bytes, truncated: bytes > LIMIT };
      }
      if (method === "preview.pdfWindow") {
        // PDF 预览：应用内独立窗口，Chromium 自带阅读器（翻页/缩放/搜索都有）。
        // 路径守卫与 preview.read 完全一致：只放行 tasks/<id>/ 内或已登记的交付物。
        const p = params as { taskId: string; ref: string };
        const base = path.resolve(kernel.dataRoot, "tasks", p.taskId);
        const target = path.resolve(base, String(p.ref ?? ""));
        if (!target.startsWith(base + path.sep)) {
          const abs = path.isAbsolute(String(p.ref ?? ""));
          if (!abs || !kernel.isTaskDeliverable(p.taskId, String(p.ref ?? ""))) {
            return { ok: false, error: "预览路径越界，已拒绝" };
          }
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, error: "文件不存在（可能已被移动）" };
        if (!win || win.isDestroyed()) return { ok: false, error: "主窗口不在了" };
        const pdfWin = new BrowserWindow({
          width: 1080,
          height: 860,
          parent: win,
          autoHideMenuBar: true,
          title: `${path.basename(target)} · 预览`,
          backgroundColor: "#26282d",
        });
        void pdfWin.loadFile(target);
        return { ok: true };
      }
      if (method === "app.pickDirs") {
        // 只读授权多选：一次选多个目录（整盘等敏感选择由内核再验）
        const p = params as { title?: string } | undefined;
        if (!win || win.isDestroyed()) return { canceled: true };
        const r = await dialog.showOpenDialog(win, {
          title: p?.title ?? "选择要授权只读访问的目录（可多选）",
          properties: ["openDirectory", "multiSelections"],
        });
        return r.canceled || !r.filePaths.length ? { canceled: true } : { paths: r.filePaths };
      }
      if (method === "app.pickDir") {
        // 只读授权的目录选择：原生对话框，用户亲手选，模型无法代为选择
        const p = params as { title?: string } | undefined;
        if (!win || win.isDestroyed()) return { canceled: true };
        const r = await dialog.showOpenDialog(win, {
          title: p?.title ?? "选择要授权只读访问的目录",
          properties: ["openDirectory"],
        });
        return r.canceled || !r.filePaths[0] ? { canceled: true } : { path: r.filePaths[0] };
      }
      if (method === "app.restart") {
        // 一键重启：改了代码 / 内核比界面旧时，用户不必自己去托盘翻「退出」
        app.relaunch();
        setTimeout(() => app.exit(0), 80);
        return { ok: true };
      }
      if (method === "app.openPath") {
        // 只允许打开数据根内的文件（导出包 / 工件），不当前端可调的任意文件执行器
        const p = params as { path: string };
        const base = path.resolve(kernel.dataRoot);
        const target = path.resolve(String(p.path ?? ""));
        if (!target.startsWith(base + path.sep)) return { ok: false, error: "只能打开风铃数据目录里的文件" };
        if (!fs.existsSync(target)) return { ok: false, error: "文件不存在" };
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
      if (method === "app.openData") {
        const kind = (params as { kind: "data" | "logs" }).kind;
        const target = kind === "logs" ? path.join(kernel.dataRoot, "logs") : kernel.dataRoot;
        fs.mkdirSync(target, { recursive: true });
        void shell.openPath(target);
        return { ok: true, path: target };
      }
      // 端点发现/健康检查/本机网关探测要真发 HTTP，走异步方法，不塞进同步 handle
      if (method === "model.discover") return kernel.modelDiscover(params as never);
      if (method === "model.health") return kernel.modelHealth(params as never);
      if (method === "gateway.list") return kernel.listGateways();
      if (method === "app.openExternal") {
        const p = params as { url: string };
        try {
          const u = new URL(String(p.url ?? ""));
          if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "只允许打开 http/https 链接" };
          await shell.openExternal(u.toString());
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
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
  void kernel.dispose().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export { createPet, focusMain };
