/**
 * 文件名: rpc-registry.ts
 * 描述: RPC 方法注册表——kernel.handle 巨型 switch 按域迁移的落点。
 *
 * 迁移约定（2026-11-15 接手修订）：
 *   1. handler 只依赖「窄接口 RpcDeps」，不接收 Kernel 实例，也不把整块 SettingsRpc 公开出去；
 *   2. handler 的 params / result 类型直接取契约 RpcContracts[M]，禁止把参数放宽成 unknown 再断言；
 *   3. 已迁移的方法必须从 kernel.ts 的 switch 里删掉 case——同一方法两个实现点，
 *      改一处漏一处只有点到才炸（历史事故：task.detail 被误删）。
 *
 * 第一批：model.list / model.save / model.remove / model.setDefault / model.setThread / model.test
 * 其余方法仍在 kernel.handle 的 switch 中，后续批次逐一迁移。
 */
import type { RpcContracts, RpcMethod } from "../shared/contract";

/**
 * 模型库域能力（窄接口）。
 * kernel 侧负责把 SettingsRpc 的 unknown 返回值收口成契约类型（见 Kernel.modelRpcDeps），
 * 注册表这一侧看到的就是契约类型，不需要再做断言。
 */
export interface ModelRpcDeps {
  list(): RpcContracts["model.list"]["result"];
  save(params: RpcContracts["model.save"]["params"]): RpcContracts["model.save"]["result"];
  remove(params: RpcContracts["model.remove"]["params"]): RpcContracts["model.remove"]["result"];
  setDefault(params: RpcContracts["model.setDefault"]["params"]): RpcContracts["model.setDefault"]["result"];
  setThread(params: RpcContracts["model.setThread"]["params"]): RpcContracts["model.setThread"]["result"];
  test(params: RpcContracts["model.test"]["params"]): RpcContracts["model.test"]["result"];
}

/** 注册表可注入的全部域能力；后续批次按域加字段，而不是把 Kernel 整个塞进来 */
export interface RpcDeps {
  models: ModelRpcDeps;
}

/** 一个 RPC handler：入参与返回值都由契约推导 */
export type RpcHandler<M extends RpcMethod> = (
  params: RpcContracts[M]["params"],
) => RpcContracts[M]["result"];

/**
 * 类型擦除后的存储形态。
 * Map 里装不下逐方法的泛型（函数参数逆变），所以存储层擦除、handle() 出口按 M 还原一次——
 * 这是注册表模式的固有成本，全仓只允许在这一处出现。
 */
type StoredHandler = (params: unknown) => unknown;

/** RPC 方法注册表 */
export class RpcRegistry {
  private handlers = new Map<RpcMethod, StoredHandler>();

  /** 注册一个 RPC 方法；同一方法重复注册直接报错，避免后注册者静默覆盖 */
  register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): void {
    if (this.handlers.has(method)) {
      throw new Error(`rpc registry: 方法重复注册 ${method}`);
    }
    this.handlers.set(method, handler as unknown as StoredHandler);
  }

  has(method: RpcMethod): boolean {
    return this.handlers.has(method);
  }

  /** 已注册的方法名（自检与测试用——不要让测试去正则扫源码） */
  methods(): RpcMethod[] {
    return [...this.handlers.keys()];
  }

  handle<M extends RpcMethod>(method: M, params: RpcContracts[M]["params"]): RpcContracts[M]["result"] {
    const handler = this.handlers.get(method);
    if (!handler) {
      // 与 kernel.ts switch 的 default 文案区分开：排查时一眼看出是注册表缺项还是 switch 缺 case
      throw new Error(`rpc registry: 方法未注册 ${method}`);
    }
    return handler(params) as RpcContracts[M]["result"];
  }
}

/** 构建 kernel 的 RPC 注册表（第一批：模型库域） */
export function buildKernelRegistry(deps: RpcDeps): RpcRegistry {
  const registry = new RpcRegistry();

  // ---------- 模型库：多条配置 / 全局默认 / 每对话覆盖 ----------
  registry.register("model.list", () => deps.models.list());
  registry.register("model.save", (params) => deps.models.save(params));
  registry.register("model.remove", (params) => deps.models.remove(params));
  registry.register("model.setDefault", (params) => deps.models.setDefault(params));
  registry.register("model.setThread", (params) => deps.models.setThread(params));
  registry.register("model.test", (params) => deps.models.test(params));

  return registry;
}
