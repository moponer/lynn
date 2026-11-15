/**
 * 文件名: rpc-registry.ts
 * 描述: RPC 方法注册表，把 kernel.handle 的巨型 switch 拆成注册表模式（第一批）
 *
 * 第一批只注册已经委托给 settingsRpc 的 model.* 方法：
 *   - model.list / model.save / model.remove
 *   - model.setDefault / model.setThread / model.test
 *
 * 其余方法保留在 kernel.handle 的 switch 中，后续批次逐步迁移。
 */
import type { Kernel } from "./kernel";
import type { RpcContracts, RpcMethod } from "../shared/contract";

/** RPC 处理器签名：params 是原始 unknown，由 handler 内部做类型断言 */
export type RpcHandler<M extends RpcMethod> = (
  params: Record<string, unknown>,
  ctx: { kernel: Kernel },
) => RpcContracts[M]["result"];

/** 类型擦除后的处理器（用于注册表内部存储） */
type AnyRpcHandler = (params: Record<string, unknown>, ctx: { kernel: Kernel }) => unknown;

/** RPC 方法注册表 */
export class RpcRegistry {
  private handlers = new Map<string, AnyRpcHandler>();

  /** 注册一个 RPC 方法 */
  register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): void {
    this.handlers.set(method, handler as AnyRpcHandler);
  }

  /** 检查方法是否已注册 */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /** 处理 RPC 调用 */
  handle<M extends RpcMethod>(
    method: M,
    params: Record<string, unknown>,
    ctx: { kernel: Kernel },
  ): RpcContracts[M]["result"] {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`unknown rpc method: ${method}`);
    }
    return handler(params, ctx) as RpcContracts[M]["result"];
  }
}

/** 构建 kernel 的 RPC 注册表（第一批：已委托给 settingsRpc 的 model.* 方法） */
export function buildKernelRegistry(): RpcRegistry {
  const registry = new RpcRegistry();

  // ---------- 模型库：多条配置 / 全局默认 / 每对话覆盖 ----------
  // 这些方法已经委托给 settingsRpc，这里直接透传
  registry.register("model.list", (_params, ctx) =>
    ctx.kernel.settingsRpc.modelList() as RpcContracts["model.list"]["result"],
  );

  registry.register("model.save", (params, ctx) =>
    ctx.kernel.settingsRpc.modelSave(params) as RpcContracts["model.save"]["result"],
  );

  registry.register("model.remove", (params, ctx) =>
    ctx.kernel.settingsRpc.modelRemove(params) as RpcContracts["model.remove"]["result"],
  );

  registry.register("model.setDefault", (params, ctx) =>
    ctx.kernel.settingsRpc.modelSetDefault(params) as RpcContracts["model.setDefault"]["result"],
  );

  registry.register("model.setThread", (params, ctx) =>
    ctx.kernel.settingsRpc.modelSetThread(params) as RpcContracts["model.setThread"]["result"],
  );

  registry.register("model.test", (params, ctx) =>
    ctx.kernel.settingsRpc.modelTest(params) as RpcContracts["model.test"]["result"],
  );

  return registry;
}
