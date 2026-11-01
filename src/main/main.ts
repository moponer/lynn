import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
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
);

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#FFFFFF",
    title: "风铃 Lynn · 指挥台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // 唯一 RPC 通道
  ipcMain.handle("lynn:rpc", (_event, method: string, params: unknown) => {
    try {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
