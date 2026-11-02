import { app, BrowserWindow, ipcMain, safeStorage, screen, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcMethod } from "../shared/contract";
import { Kernel } from "./kernel";

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

let win: BrowserWindow | null = null;
let pet: BrowserWindow | null = null;

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
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win?.show());
  // 外链一律交给系统浏览器；应用内导航只允许同一个 file:// 文档
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault();
  });

  void win.loadFile(indexHtml());
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
      if (method === "plugins.probe") {
        return kernel.probePlugin((params as { id: string }).id);
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
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on("before-quit", (event) => {
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
