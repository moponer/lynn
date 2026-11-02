import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolSchema } from "./llm";
import type { PluginManifest } from "./plugin-manifest";

/**
 * L1 进程内扩展运行时（§4.2.1 / §4.2.3；M0-05 / 实验 2）。
 *
 * 语义全部落在代码里，不靠约定：
 *  - 工具名命名空间 `lynn_<插件id 下划线化>_<短名>`，与内核工具冲突 = 加载失败并明确报错，不静默覆盖
 *  - 停用 = 调模块 deactivate + 反注册（即时、无残留）；执行层还会拦「已停用工具」的调用
 *  - 启用 / 代码更新 = `/reload`（重建模块求值，jiti 每次激活新实例防缓存）；
 *    **Agent 运行中不执行 reload，请求排队到 settled**（§4.2.3 Pi 真实边界）
 *  - 第三方 L1 默认关闭（enabled 判定在 PluginHost.scan），安全模式下 L1 一律不加载
 *
 * 信任模型如实说明：L1 与内核同进程同权限，`api` 面只给 registerTool/log/state 目录——
 * 凭据、会话、任意 fs 不在 api 上，但模块自身仍可 import node 内置模块（= 计划书「高信任」档）。
 * fs/net 逐项强制留到准入流水线补全，这里不谎报已沙箱。
 */

export interface L1ToolDef {
  /** 工具短名（manifest contributes.tools 声明过的子集） */
  name: string;
  description: string;
  /** JSON Schema（object） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

/** 交给扩展的 api 面：能做什么，写死在这里 */
export interface L1Api {
  registerTool(def: L1ToolDef): void;
  /** 插件私有状态目录（~/.lynn/plugins/<目录>/state/，卸载时询问是否保留） */
  dataDir: string;
  log(...args: unknown[]): void;
}

export interface L1Entry {
  id: string;
  dir: string;
  manifest: PluginManifest;
  enabled: boolean;
}

interface LoadedL1 {
  id: string;
  dir: string;
  manifest: PluginManifest;
  /** 全名 → 定义 */
  tools: Map<string, L1ToolDef>;
  deactivateHook?: () => void;
}

export interface L1Deps {
  /** 列出所有 L1 插件（PluginHost 提供；含 enabled 判定与安全模式过滤后的结果） */
  listEntries: () => L1Entry[];
  /** 解析单个插件目录与 manifest */
  manifestOf: (id: string) => { dir: string; manifest: PluginManifest } | null;
  kernelVersion: string;
}

/** 工具全名：lynn_<插件段下划线化>_<短名>（§4.2.2 命名空间；id 的 lynn. 前缀不重复进名；OpenAI 函数名不允许点号） */
export function l1ToolFullName(pluginId: string, shortName: string): string {
  const bare = pluginId.startsWith("lynn.") ? pluginId.slice("lynn.".length) : pluginId;
  return `lynn_${bare.split(".").join("_")}_${shortName}`;
}

async function importL1Module(entryPath: string): Promise<Record<string, unknown>> {
  // 每次激活新建 jiti 实例（moduleCache 关闭）——/reload 才能真正重新求值模块
  const jitiMod = (await import("jiti")) as unknown as {
    createJiti: (id: string, opts?: Record<string, unknown>) => { import: (p: string) => Promise<unknown> };
  };
  const jiti = jitiMod.createJiti(__filename, { moduleCache: false, fsCache: false, interopDefault: true });
  const mod = (await jiti.import(entryPath)) as Record<string, unknown>;
  return mod ?? {};
}

export class L1Host {
  private loaded = new Map<string, LoadedL1>();
  private reloadQueued = new Set<string>();
  private busy = false;
  /** 最近一次启动/重载的诊断（scan 面板显示用） */
  readonly lastErrors: string[] = [];

  constructor(private readonly deps: L1Deps) {}

  // ---------- 工具面 ----------

  /** 当前生效的 L1 工具（直连路径并入 TOOL_JSON；Pi 路径在会话重建时注入） */
  toolSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const p of this.loaded.values()) {
      for (const [full, def] of p.tools) {
        out.push({
          type: "function",
          function: { name: full, description: def.description, parameters: def.parameters },
        });
      }
    }
    return out;
  }

  has(fullName: string): boolean {
    for (const p of this.loaded.values()) if (p.tools.has(fullName)) return true;
    return false;
  }

  /** 指纹：工具名集合（Pi 会话重建判定用） */
  fingerprint(): string {
    return this.toolSchemas().map((t) => t.function.name).sort().join(",");
  }

  async execute(fullName: string, args: Record<string, unknown>): Promise<string> {
    for (const p of this.loaded.values()) {
      const def = p.tools.get(fullName);
      if (!def) continue;
      try {
        return await def.execute(args);
      } catch (err) {
        return `插件工具执行失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // 执行层兜底：停用/卸载后残留的调用一律明确拒绝（不变式 1：无残留）
    return `工具 ${fullName} 未激活（可能已停用或卸载）。`;
  }

  // ---------- 生命周期 ----------

  /** 启动时加载所有 enabled 的 L1 插件；单个失败不影响别的 */
  async loadAll(): Promise<void> {
    for (const entry of this.deps.listEntries()) {
      if (!entry.enabled) continue;
      try {
        await this.activate(entry.id);
      } catch (err) {
        this.lastErrors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * activate：加载模块 → 调工厂 → 收集注册的工具。
   * 冲突（与内核工具名或其它插件重名）→ 明确报错并回滚本插件已注册项。
   */
  async activate(id: string): Promise<{ ok: boolean; detail: string }> {
    if (this.loaded.has(id)) return { ok: false, detail: `${id} 已在运行中` };
    const found = this.deps.manifestOf(id);
    if (!found) return { ok: false, detail: "插件不存在" };
    const { dir, manifest } = found;
    if (manifest.tier !== "L1") return { ok: false, detail: `${manifest.tier} 不归 L1 加载器管` };
    if (typeof manifest.entry !== "string" || !manifest.entry.endsWith(".ts")) {
      return { ok: false, detail: "manifest 缺少 entry（.ts）" };
    }
    const entryPath = path.resolve(dir, manifest.entry);
    if (!entryPath.startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, detail: "entry 跳出插件目录" };
    }
    if (!fs.existsSync(entryPath)) return { ok: false, detail: `entry 不存在：${manifest.entry}` };

    const mod = await importL1Module(entryPath);
    const factory = mod.default;
    if (typeof factory !== "function") {
      return { ok: false, detail: "entry 必须默认导出 activate(api) 工厂函数" };
    }

    const declared = new Set(manifest.contributes?.tools ?? []);
    const tools = new Map<string, L1ToolDef>();
    const api: L1Api = {
      dataDir: path.join(dir, "state"),
      log: (...args: unknown[]) => console.log(`[l1:${id}]`, ...args),
      registerTool: (def: L1ToolDef) => {
        if (!def || typeof def.name !== "string" || typeof def.execute !== "function") {
          throw new Error("registerTool 需要 { name, description, parameters, execute }");
        }
        const full = l1ToolFullName(id, def.name);
        if (declared.size > 0 && !declared.has(def.name)) {
          throw new Error(`工具 "${def.name}" 未在 manifest contributes.tools 声明（先声明再注册）`);
        }
        if (this.has(full) || tools.has(full)) {
          throw new Error(`工具名冲突：${full} 已存在——冲突时插件加载失败，不静默覆盖（§4.2.2）`);
        }
        tools.set(full, def);
      },
    };

    try {
      await factory(api);
    } catch (err) {
      throw new Error(`activate 失败：${err instanceof Error ? err.message : String(err)}`);
    }

    this.loaded.set(id, { id, dir, manifest, tools, deactivateHook: typeof mod.deactivate === "function" ? (mod.deactivate as () => void) : undefined });
    return { ok: true, detail: `已激活（${tools.size} 个工具：${[...tools.keys()].join("、") || "无"}）` };
  }

  /** 停用 = 反注册 + 调模块钩子。即时生效，无残留（§4.2.3 两级语义的第①级） */
  deactivate(id: string): boolean {
    const p = this.loaded.get(id);
    if (!p) return false;
    try {
      p.deactivateHook?.();
    } catch (err) {
      console.warn(`[l1:${id}] deactivate 钩子出错（仍完成反注册）：`, err);
    }
    this.loaded.delete(id);
    return true;
  }

  /** 卸载 = 停用（重建留给下次 /reload；目录删除由调用方做并询问 state 保留） */
  unload(id: string): boolean {
    return this.deactivate(id);
  }

  // ---------- /reload 排队语义（§4.2.3：Agent 运行中禁止 reload → 排队到 settled） ----------

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) void this.drainReloads();
  }

  /**
   * 请求重载：空闲则立即重载（重新求值模块）；运行中则排队，settled 后执行。
   * 返回当前生效描述（调用方可直接回复用户）。
   */
  async requestReload(id: string): Promise<string> {
    if (this.busy) {
      this.reloadQueued.add(id);
      return `她正在执行中，重载已排队——这一轮结束（agent_settled）后自动生效（§4.2.3）。`;
    }
    return this.reloadNow(id);
  }

  private async reloadNow(id: string): Promise<string> {
    const wasLoaded = this.loaded.has(id);
    if (wasLoaded) this.deactivate(id);
    try {
      const r = await this.activate(id);
      if (!r.ok) return `重载失败：${r.detail}`;
      return `${wasLoaded ? "已重载" : "已启用"}：${r.detail}`;
    } catch (err) {
      return `重载失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async drainReloads(): Promise<void> {
    if (this.busy || this.reloadQueued.size === 0) return;
    const ids = [...this.reloadQueued];
    this.reloadQueued.clear();
    for (const id of ids) {
      const msg = await this.reloadNow(id);
      console.log(`[l1] 排队的重载已执行：${id} — ${msg}`);
    }
  }

  /** queued（供面板/测试断言排队语义） */
  queuedReloads(): string[] {
    return [...this.reloadQueued];
  }

  activeIds(): string[] {
    return [...this.loaded.keys()];
  }
}
