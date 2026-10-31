import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import type { RpcMethod } from "../shared/contract";
import { createMockKernel, MockKernel } from "./mock-kernel";

/**
 * Electron 主进程 —— 薄壳（§4.1）。
 * 只做：窗口、生命周期、IPC 转发。不含 Agent 逻辑、不含工具实现。
 * 内核侧现在是 MockKernel；接入 Pi 运行时后换成 stdio JSON-RPC 转发，
 * 渲染层契约（src/shared/contract.ts）不变。
 */

const kernel: MockKernel = createMockKernel();

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0B1015",
    title: "风铃 Lynn · 指挥台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 渲染器无 Node 直访能力；一切桌面能力过类型化 IPC（§4.1）
  void win.loadFile(path.join(__dirname, "../renderer/index.html"));

  win.on("closed", () => {
    win = null;
  });
}

// 唯一 IPC 通道：JSON-RPC 语义（method + params → result）
ipcMain.handle("lynn:rpc", (_event, method: string, params: unknown) => {
  try {
    return kernel.handle(method as RpcMethod, params);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
