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

/**
 * 对话面域能力（窄接口，第二批）。
 * 入参/返回值同样取契约类型——ThreadRpc 内部是 unknown，收口在 Kernel.threadRpcDeps()。
 * 注意 thread.halt 不在这一批：它要停成员、断回合、清待验收，属跨域编排，留在 kernel。
 */
export interface ThreadRpcDeps {
  list(): RpcContracts["thread.list"]["result"];
  create(params: RpcContracts["thread.new"]["params"]): RpcContracts["thread.new"]["result"];
  switchTo(params: RpcContracts["thread.switch"]["params"]): RpcContracts["thread.switch"]["result"];
  rename(params: RpcContracts["thread.rename"]["params"]): RpcContracts["thread.rename"]["result"];
  pin(params: RpcContracts["thread.pin"]["params"]): RpcContracts["thread.pin"]["result"];
  announce(params: RpcContracts["thread.announcement"]["params"]): RpcContracts["thread.announcement"]["result"];
  draftNotice(params: RpcContracts["thread.draftNotice"]["params"]): RpcContracts["thread.draftNotice"]["result"];
  remove(params: RpcContracts["thread.remove"]["params"]): RpcContracts["thread.remove"]["result"];
  search(params: RpcContracts["thread.search"]["params"]): RpcContracts["thread.search"]["result"];
}

/** 日历域能力（窄接口，第三批）；scan 的"落卡 + 通知"留在内核，域里只有扫描入口 */
export interface CalendarRpcDeps {
  add(params: RpcContracts["calendar.add"]["params"]): RpcContracts["calendar.add"]["result"];
  list(params: RpcContracts["calendar.list"]["params"]): RpcContracts["calendar.list"]["result"];
  finish(params: RpcContracts["calendar.finish"]["params"]): RpcContracts["calendar.finish"]["result"];
  todoAdd(params: RpcContracts["calendar.todo.add"]["params"]): RpcContracts["calendar.todo.add"]["result"];
  todoList(): RpcContracts["calendar.todo.list"]["result"];
  todoFinish(params: RpcContracts["calendar.todo.finish"]["params"]): RpcContracts["calendar.todo.finish"]["result"];
  scan(): RpcContracts["calendar.scan"]["result"];
}

/** 定时任务域能力（窄接口，第三批）；tick 起对话由内核编排 */
export interface ScheduleRpcDeps {
  tick(): RpcContracts["schedule.tick"]["result"];
  add(params: RpcContracts["schedule.add"]["params"]): RpcContracts["schedule.add"]["result"];
  list(): RpcContracts["schedule.list"]["result"];
  remove(params: RpcContracts["schedule.remove"]["params"]): RpcContracts["schedule.remove"]["result"];
  toggle(params: RpcContracts["schedule.toggle"]["params"]): RpcContracts["schedule.toggle"]["result"];
}

/** 知识库域能力（窄接口，第三批） */
export interface KbRpcDeps {
  search(params: RpcContracts["kb.search"]["params"]): RpcContracts["kb.search"]["result"];
  list(): RpcContracts["kb.list"]["result"];
  read(params: RpcContracts["kb.read"]["params"]): RpcContracts["kb.read"]["result"];
  reindex(): RpcContracts["kb.reindex"]["result"];
}

/** 注册表可注入的全部域能力；后续批次按域加字段，而不是把 Kernel 整个塞进来 */
export interface RpcDeps {
  models: ModelRpcDeps;
  threads: ThreadRpcDeps;
  calendar: CalendarRpcDeps;
  schedules: ScheduleRpcDeps;
  kb: KbRpcDeps;
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

  // ---------- 对话面：群列表 / 新建 / 切换 / 改名 / 置顶 / 公告 / 起草 / 删除 / 搜索 ----------
  registry.register("thread.list", () => deps.threads.list());
  registry.register("thread.new", (params) => deps.threads.create(params));
  registry.register("thread.switch", (params) => deps.threads.switchTo(params));
  registry.register("thread.rename", (params) => deps.threads.rename(params));
  registry.register("thread.pin", (params) => deps.threads.pin(params));
  registry.register("thread.announcement", (params) => deps.threads.announce(params));
  registry.register("thread.draftNotice", (params) => deps.threads.draftNotice(params));
  registry.register("thread.remove", (params) => deps.threads.remove(params));
  registry.register("thread.search", (params) => deps.threads.search(params));

  // ---------- 日历：事件 / 待办 / 到期扫描 ----------
  registry.register("calendar.add", (params) => deps.calendar.add(params));
  registry.register("calendar.list", (params) => deps.calendar.list(params));
  registry.register("calendar.finish", (params) => deps.calendar.finish(params));
  registry.register("calendar.todo.add", (params) => deps.calendar.todoAdd(params));
  registry.register("calendar.todo.list", () => deps.calendar.todoList());
  registry.register("calendar.todo.finish", (params) => deps.calendar.todoFinish(params));
  registry.register("calendar.scan", () => deps.calendar.scan());

  // ---------- 定时任务：到点起一轮 / 增删启停 ----------
  registry.register("schedule.tick", () => deps.schedules.tick());
  registry.register("schedule.add", (params) => deps.schedules.add(params));
  registry.register("schedule.list", () => deps.schedules.list());
  registry.register("schedule.remove", (params) => deps.schedules.remove(params));
  registry.register("schedule.toggle", (params) => deps.schedules.toggle(params));

  // ---------- 知识库：检索 / 清单 / 读 / 重建索引 ----------
  registry.register("kb.search", (params) => deps.kb.search(params));
  registry.register("kb.list", () => deps.kb.list());
  registry.register("kb.read", (params) => deps.kb.read(params));
  registry.register("kb.reindex", () => deps.kb.reindex());

  return registry;
}
