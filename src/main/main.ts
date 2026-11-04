import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { autoUpdater } from "electron-updater";
import type { RpcMethod } from "../shared/contract";
import { Kernel } from "./kernel";
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

/**
 * Electron 主进程 —— 薄壳（§4.1）。
 * 只做：窗口、生命周期、IPC 转发、safeStorage 凭据加密。
 * 不含 Agent 逻辑、不含工具实现——那些在 kernel.ts（未来换成 Pi 运行时转发）。
 */

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

/** 托盘图标（M1-18）：assets/tray.png（scripts/gen-tray-icon.mjs 生成） */
function trayIcon() {
  const p = path.join(__dirname, "..", "assets", "tray.png");
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("风铃 Lynn");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开指挥台", click: () => focusMain() },
      { label: "桌宠", click: () => createPet() },
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

const preload = () => path.join(__dirname, "preload.js");
const indexHtml = () => path.join(__dirname, "../renderer/index.html");

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
    width: 240,
    height: 300,
    x: workArea.x + workArea.width - 260,
    y: workArea.y + workArea.height - 320,
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
  await kernel.init(); // 动态加载 Pi（ESM）；失败自动降级直连
  // 启动即打插件集指纹；10 分钟内第 3 次启动自动进安全模式（§4.11.4）
  const boot = kernel.noteKernelStart();
  console.log(`[plugins] fingerprint=${boot.fingerprint} safeMode=${boot.safeMode} starts=${boot.starts}`);
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
        if (!target.startsWith(base + path.sep)) {
          return { ok: false, error: "证据路径越界，已拒绝" };
        }
        if (!fs.existsSync(target)) return { ok: false, error: "文件不存在（可能已被移动）" };
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
      if (method === "app.restart") {
        // 一键重启：改了代码 / 内核比界面旧时，用户不必自己去托盘翻「退出」
        app.relaunch();
        setTimeout(() => app.exit(0), 80);
        return { ok: true };
      }
      if (method === "app.openData") {
        const kind = (params as { kind: "data" | "logs" }).kind;
        const target = kind === "logs" ? path.join(kernel.dataRoot, "logs") : kernel.dataRoot;
        fs.mkdirSync(target, { recursive: true });
        void shell.openPath(target);
        return { ok: true, path: target };
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
        notifyOnce("风铃遇到了问题", (c.text || "").slice(0, 120));
      }
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;

app.on("before-quit", (event) => {
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
