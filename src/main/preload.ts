import { contextBridge, ipcRenderer } from "electron";
import type { KernelEvent, RpcContracts, RpcMethod, VoicePlayEvent } from "../shared/contract";

// 选区窗只需要截图 RPC；异常上报走下方独立的 logError 通道，不开放内核通用能力。
// 主进程 tsconfig 不带 DOM lib，这里只声明读取 query 所需的最小 location 形状。
const isCaptureWindow = new URLSearchParams(
  (globalThis as unknown as { location: { search: string } }).location.search,
).get("capture") === "1";

/**
 * preload：把类型化 RPC 客户端与事件订阅挂到 window.lynn。
 * 不暴露 ipcRenderer 本体，不暴露任何 Node 能力。
 */
contextBridge.exposeInMainWorld("lynn", {
  rpc: async <M extends RpcMethod>(
    method: M,
    ...args: RpcContracts[M]["params"] extends void
      ? []
      : [RpcContracts[M]["params"]]
  ): Promise<RpcContracts[M]["result"]> => {
    if (isCaptureWindow && !method.startsWith("capture.")) {
      throw new Error(`选区窗口不允许调用 RPC：${method}`);
    }
    const params = args[0];
    return ipcRenderer.invoke("lynn:rpc", method, params);
  },
  onEvent: (cb: (ev: KernelEvent) => void) => {
    const listener = (_e: unknown, ev: KernelEvent) => cb(ev);
    ipcRenderer.on("lynn:event", listener);
    return () => ipcRenderer.removeListener("lynn:event", listener);
  },
  onVoice: (cb: (ev: VoicePlayEvent) => void) => {
    const listener = (_e: unknown, ev: VoicePlayEvent) => cb(ev);
    ipcRenderer.on("lynn:voice", listener);
    return () => ipcRenderer.removeListener("lynn:voice", listener);
  },
  // 渲染层异常上报：只写日志，不暴露任何能力
  logError: (payload: { kind: string; message: string; stack?: string; source?: string }) => {
    ipcRenderer.send("lynn:log-error", payload);
  },
});
