import { contextBridge, ipcRenderer } from "electron";
import type { KernelEvent, RpcContracts, RpcMethod } from "../shared/contract";

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
    const params = args[0];
    return ipcRenderer.invoke("lynn:rpc", method, params);
  },
  onEvent: (cb: (ev: KernelEvent) => void) => {
    const listener = (_e: unknown, ev: KernelEvent) => cb(ev);
    ipcRenderer.on("lynn:event", listener);
    return () => ipcRenderer.removeListener("lynn:event", listener);
  },
  // 渲染层异常上报：只写日志，不暴露任何能力
  logError: (payload: { kind: string; message: string; stack?: string; source?: string }) => {
    ipcRenderer.send("lynn:log-error", payload);
  },
});
