/**
 * 工具注册表（2026-11-17 P8-1 / 22 章第 4.1 节、23 章第 5.1 节）。
 *
 * 为什么需要它：`toolkit.execute()` 现在是一个 **switch 硬编码**、`TOOLKIT_SCHEMAS` 是常量数组。
 * 后果不是"代码不好看"，而是三件事**在结构上做不到**：
 *   1. 插件只能**新增**工具，不能**替换**内置的（`browser_*` / `office_*` / `read_file`）；
 *   2. 无法做"按 Agent 收窄工具面"（DSH 的 `ctx.tools.restrict()`）——因为工具面是常量；
 *   3. 无法做"权限闸门"（DSH 的 `ctx.tools.guard()`）——因为没有统一的执行入口。
 *
 * 设计上照抄 DSH 的两条洞察（见 23 章）：
 *  - **注册即效果**：`register()` 返回 disposer，卸载/销毁时自动回收，不靠"记得手动清理"；
 *  - **最弱的够用机制**：这里只提供「注册 / 查 / 列」，不提供"改写别人注册的东西"的能力。
 *
 * 一条硬约束：**枚举顺序必须稳定**。工具面在请求最前面，顺序一变就是整段前缀缓存作废
 * （P2-1b / P4-2 都踩过）。所以 `list()` 按名字排序，而不是按注册先后。
 */

import type { ToolSchema } from "./llm";

/** 工具实现。`origin` 用于审计：插件覆盖内置工具时必须能被查出来。 */
export interface ToolImpl {
  /** 工具名（与 schema 的 function.name 一致） */
  name: string;
  /** 发给模型的 schema */
  schema: ToolSchema;
  /** 执行体；抛错由调用方统一转成可读文本 */
  execute: (args: Record<string, unknown>) => string | Promise<string>;
  /**
   * 来源。`builtin` = 内核自带；`plugin:<id>` = 插件注册。
   *
   * 为什么必须记：插件**覆盖**内置工具是合法需求（比如换一个更快的 read_file），
   * 但"内置的 read_file 什么时候被换掉了"必须能查出来，否则排障时无从下手。
   */
  origin: "builtin" | `plugin:${string}`;
  /**
   * 是否常驻工具面（false = 只在 tool_search 命中后才发）。
   * 见 P4-2：热路径常驻，长尾按需。
   */
  resident?: boolean;
}

export interface RegisterOptions {
  /**
   * 允许覆盖同名工具。缺省 false。
   *
   * 默认**不许**覆盖：两个插件抢同一个名字时，静默覆盖会让行为变得不可预测。
   * 要覆盖必须显式声明，并且调用方能从 `list()` 看到 `origin` 变了。
   */
  override?: boolean;
}

export class ToolRegistry {
  private readonly impls = new Map<string, ToolImpl>();

  /**
   * 注册一个工具，返回 **disposer**（DSH 的 effect 模式）。
   *
   * 返回 disposer 而不是"提供一个 unregister 让你自己记得调"：
   * 前者能在作用域结束时自动回收（插件卸载、测试清理），后者迟早会漏。
   */
  register(impl: ToolImpl, opts: RegisterOptions = {}): () => void {
    const name = impl.name;
    if (!name) throw new Error("工具必须有名字");
    if (!impl.schema?.function?.name) throw new Error(`工具 ${name} 缺少 schema.function.name`);
    if (impl.schema.function.name !== name) {
      throw new Error(`工具名与 schema 不一致：${name} vs ${impl.schema.function.name}`);
    }
    const existing = this.impls.get(name);
    if (existing && !opts.override) {
      throw new Error(
        `工具 ${name} 已存在（来源 ${existing.origin}）。要覆盖请显式传 override: true——` +
          "静默覆盖会让行为不可预测",
      );
    }
    this.impls.set(name, impl);
    // disposer 只删"自己注册的那一份"：若期间被别人覆盖过，不要把别人的删掉
    return () => {
      if (this.impls.get(name) === impl) this.impls.delete(name);
    };
  }

  /** 批量注册（常用：内置工具一次装进去），返回一个合并的 disposer */
  registerAll(list: readonly ToolImpl[], opts: RegisterOptions = {}): () => void {
    const disposers = list.map((impl) => this.register(impl, opts));
    return () => {
      for (const d of disposers) d();
    };
  }

  get(name: string): ToolImpl | undefined {
    return this.impls.get(name);
  }

  has(name: string): boolean {
    return this.impls.has(name);
  }

  /**
   * 列出工具，**按名字排序**。
   *
   * 排序不是洁癖：工具面顺序决定请求前缀。按注册先后排会让"加载顺序"影响缓存命中率，
   * 而加载顺序在插件场景下本来就不确定（Map 遍历、异步加载先后）。
   */
  list(): ToolImpl[] {
    return [...this.impls.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 工具面 schema（按名字排序，顺序稳定） */
  schemas(): ToolSchema[] {
    return this.list().map((i) => i.schema);
  }

  /**
   * 按白名单取 schema（成员派单用：只能收窄，不能扩张）。
   * 未知名字静默跳过——调用方（memberToolSchemas）另有"写错名字当场拒"的闸。
   *
   * **顺序按注册顺序**（不是名字排序）：成员的请求前缀在 P2/P4 那几轮已经稳定，
   * 这里换成名字排序会让所有成员的工具段顺序变一次、前缀全废。
   * 保持"注册顺序"= 内置工具仍是 `TOOLKIT_SCHEMAS` 的声明序，与改造前逐字一致。
   */
  schemasFor(allowed: readonly string[]): ToolSchema[] {
    const set = new Set(allowed);
    return [...this.impls.values()].filter((i) => set.has(i.name)).map((i) => i.schema);
  }

  /**
   * 名字清单（诊断/测试用）。**按名字排序**，便于断言与比对；
   * 要发请求请用 `schemas()` 或 `schemasFor()`。
   */
  names(): string[] {
    return this.list().map((i) => i.name);
  }

  /**
   * 按来源过滤（审计用）：回答"哪些内置工具被插件换掉了"。
   * 这是覆盖机制的配套——能覆盖就必须能查。
   */
  overriddenBuiltins(builtinNames: readonly string[]): ToolImpl[] {
    const builtin = new Set(builtinNames);
    return this.list().filter((i) => builtin.has(i.name) && i.origin !== "builtin");
  }

  /** 清空（测试用） */
  clear(): void {
    this.impls.clear();
  }
}