import { contextBridge, ipcRenderer } from "electron";
import type { RpcMethod, RpcContracts } from "../shared/contract";

/**
 * preload：把类型化 RPC 客户端挂到 window.lynn。
 * 只暴露一个 rpc(method, params) 方法，参数与返回值由 contract.ts 约束；
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
});
