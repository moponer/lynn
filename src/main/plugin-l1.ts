import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolSchema } from "./llm";
import type { PluginManifest } from "./plugin-manifest";
import { drainUtf8Lines } from "./rpc-lines";
import { killProcessTree } from "./process-tree";

/**
 * L1 扩展运行时（§4.2.1 / §4.2.3；M0-05 / 实验 2；2026-11-13 审计 #3 加进程隔离）。
 *
 * 语义全部落在代码里，不靠约定：
 *  - 工具名命名空间 `lynn_<插件id 下划线化>_<短名>`，与内核工具冲突 = 加载失败并明确报错，不静默覆盖
 *  - 停用 = 调模块 deactivate + 反注册（即时、无残留）；执行层还会拦「已停用工具」的调用
 *  - 启用 / 代码更新 = `/reload`（重建模块求值，jiti 每次激活新实例防缓存）；
 *    **Agent 运行中不执行 reload，请求排队到 settled**（§4.2.3 Pi 真实边界）
 *  - 第三方 L1 默认关闭（enabled 判定在 PluginHost.scan），安全模式下 L1 一律不加载
 *  - **进程隔离**：配置 workerEntry 时每个插件跑在独立进程（agent/l1-worker.mjs）——
 *    崩溃不带内核、超时强杀进程、api.log 转发回 host；`execute` 串行闸照旧生效。
 *    未配置（默认测试路径）保持进程内 jiti 直跑，超时只能放弃等待（无法强杀，文案如实说明）。
 *
 * 信任模型如实说明：api 面只给 registerTool/log/state 目录——凭据、会话、任意 fs
 * 不在 api 上；但插件自身仍可 import node 内置模块，fs/net 逐项强制仍是声明而非
 * 沙箱（进程内 require 拦不住，这里不谎报）。
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
  /** 隔离进程句柄（workerEntry 配置时存在；进程内路径为空） */
  worker?: L1Worker;
}

export interface L1Deps {
  /** 列出所有 L1 插件（PluginHost 提供；含 enabled 判定与安全模式过滤后的结果） */
  listEntries: () => L1Entry[];
  /** 解析单个插件目录与 manifest */
  manifestOf: (id: string) => { dir: string; manifest: PluginManifest } | null;
  kernelVersion: string;
  /** 单次工具调用超时（默认 30s；测试可调小）。进程内路径超时只能放弃等待，同进程无法强杀——如实告知模型 */
  toolTimeoutMs?: number;
  /** worker 入口（agent/l1-worker.mjs）：配置后 L1 一律隔离进程加载（审计 #3）；不传 = 进程内（测试/逃生口） */
  workerEntry?: string;
  /** 隔离进程单次调用超时（默认 30s）：超时直接杀进程树——进程可强杀，文案如实说明 */
  workerCallTimeoutMs?: number;
  /** spawn 实现（测试注入） */
  spawnImpl?: typeof spawn;
}

/** 进程内路径默认超时（审计 #21）：死循环/长阻塞的插件不该占死调用方 */
export const L1_TOOL_TIMEOUT_MS = 30_000;
/** 隔离进程路径默认超时（审计 #3）：超时 = 杀进程树 */
export const L1_WORKER_CALL_TIMEOUT_MS = 30_000;
/** 隔离进程激活超时：jiti 冷编译一个 TS 入口最坏十几秒 */
export const L1_ACTIVATE_TIMEOUT_MS = 20_000;

interface WorkerMsg {
  type: string;
  callId?: number;
  [k: string]: unknown;
}

/**
 * 单插件隔离进程句柄：一行一条 JSON 的请求/响应配对。
 * 进程崩溃/退出 → 所有挂起请求带 stderr 尾巴拒绝；host 侧超时 → 调用方负责 kill。
 */
class L1Worker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextCallId = 1;
  private pending = new Map<number, { resolve: (m: WorkerMsg) => void; reject: (e: Error) => void }>();
  private stderrTail = "";

  constructor(
    private readonly entry: string,
    private readonly spawnImpl: typeof spawn,
  ) {}

  callId(): number {
    return this.nextCallId++;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    // Electron 主进程里 process.execPath 是 Electron 二进制；ELECTRON_RUN_AS_NODE=1 让它以纯 Node 跑 worker
    const child = this.spawnImpl(process.execPath, [this.entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    child.stdout.on("data", (chunk: Buffer) => {
      const { rest, lines } = drainUtf8Lines(this.buf, chunk);
      this.buf = rest;
      for (const line of lines) {
        let msg: WorkerMsg;
        try {
          msg = JSON.parse(line) as WorkerMsg;
        } catch {
          continue;
        }
        if (msg.type === "log") {
          console.log(...((msg.parts as unknown[]) ?? []));
          continue;
        }
        if (typeof msg.callId !== "number") continue;
        const p = this.pending.get(msg.callId);
        if (!p) continue;
        this.pending.delete(msg.callId);
        p.resolve(msg);
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      this.stderrTail = `${this.stderrTail}${c.toString()}`.slice(-4_000);
    });
    const rejectAll = (why: string) => {
      this.child = null;
      for (const [, p] of this.pending) p.reject(new Error(`${why}${this.stderrTail ? `：${this.stderrTail.trim()}` : ""}`));
      this.pending.clear();
    };
    child.once("exit", (code) => rejectAll(`L1 插件进程退出（code ${code ?? "?"}）`));
    child.once("error", (err) => rejectAll(`L1 插件进程启动失败：${err.message}`));
    this.child = child;
    return child;
  }

  alive(): boolean {
    return this.child !== null;
  }

  /** 发请求并等响应；超时回调（通常 = 杀进程）后以超时错误拒绝 */
  async request(msg: WorkerMsg, timeoutMs: number, onTimeout?: () => void): Promise<WorkerMsg> {
    const child = this.start();
    const callId = this.callId();
    return new Promise<WorkerMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        onTimeout?.();
        reject(new Error(`插件调用超时（${Math.round(timeoutMs / 1000)}s）——隔离进程已被强制终止`));
      }, timeoutMs);
      this.pending.set(callId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ ...msg, callId }) + "\n");
    });
  }

  /** 同步强杀（超时路径）：进程树一起带走，挂起请求由 exit 事件拒绝 */
  kill(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.pid) void killProcessTree(child.pid);
    for (const [, p] of this.pending) p.reject(new Error("L1 插件进程已被强制终止"));
    this.pending.clear();
  }

  /** 停用路径：尽力让 deactivate 钩子跑一下（最多等 300ms），然后杀进程树 */
  dispose(): void {
    const child = this.child;
    if (!child) return;
    try {
      const callId = this.callId();
      child.stdin.write(JSON.stringify({ type: "deactivate", callId }) + "\n");
    } catch {
      /* stdin 可能已断 */
    }
    setTimeout(() => this.kill(), 300);
  }
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
  /** 每插件串行链（审计 #21）：同一插件的工具调用排队执行，并发闸=1 */
  private chains = new Map<string, Promise<unknown>>();
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
      // 审计 #21：并发闸=1——同一插件排队执行，两个调用互相踩状态比等待更难排查。
      // 超时语义按加载路径分两种：隔离进程可强杀（杀进程树+卸载插件）；进程内只能放弃等待。
      const prev = this.chains.get(p.id) ?? Promise.resolve();
      const run = prev.then(async () => {
        if (p.worker) return this.executeInWorker(p, def, args);
        return this.executeInProcess(def, fullName, args);
      });
      this.chains.set(
        p.id,
        run.catch(() => undefined),
      );
      try {
        return await run;
      } catch (err) {
        return `插件工具执行失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // 执行层兜底：停用/卸载后残留的调用一律明确拒绝（不变式 1：无残留）
    return `工具 ${fullName} 未激活（可能已停用或卸载）。`;
  }

  /** 隔离进程路径（审计 #3）：超时 = 强杀进程树 + 卸载插件，如实告知 */
  private async executeInWorker(
    p: LoadedL1,
    def: L1ToolDef,
    args: Record<string, unknown>,
  ): Promise<string> {
    const timeoutMs = this.deps.workerCallTimeoutMs ?? L1_WORKER_CALL_TIMEOUT_MS;
    try {
      const res = await p.worker!.request({ type: "execute", short: def.name, args }, timeoutMs, () => p.worker?.kill());
      if (res.ok === false) return `插件工具执行失败：${String(res.error ?? "")}`;
      const value = res.value;
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/超时/.test(msg) || /已被强制终止|进程退出/.test(msg)) {
        // 进程死了就别留着尸体：卸载插件，模型/用户得到的指引是重新启用
        this.deactivate(p.id);
        return `插件工具执行失败：${msg}。插件已停用；需要再试请在设置里重新启用该插件。`;
      }
      return `插件工具执行失败：${msg}`;
    }
  }

  /** 进程内路径（测试/逃生口）：超时只能放弃等待——同进程无法强杀，文案如实说明 */
  private async executeInProcess(def: L1ToolDef, fullName: string, args: Record<string, unknown>): Promise<string> {
    const timeoutMs = this.deps.toolTimeoutMs ?? L1_TOOL_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`插件工具 ${fullName} 超时（${Math.round(timeoutMs / 1000)}s）——同进程无法强杀，若持续卡死请在设置里停用该插件`)),
        timeoutMs,
      );
      Promise.resolve(def.execute(args)).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
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

    // ---------- 隔离进程路径（审计 #3）：每个插件一个 worker 进程 ----------
    if (this.deps.workerEntry) {
      if (!fs.existsSync(this.deps.workerEntry)) {
        return { ok: false, detail: `L1 worker 入口不存在：${this.deps.workerEntry}` };
      }
      const worker = new L1Worker(this.deps.workerEntry, this.deps.spawnImpl ?? spawn);
      const res = await worker.request(
        {
          type: "activate",
          id,
          entryPath,
          declared: manifest.contributes?.tools ?? [],
          dataDir: path.join(dir, "state"),
        },
        L1_ACTIVATE_TIMEOUT_MS,
      );
      if (res.type === "activateError") {
        worker.kill();
        return { ok: false, detail: `activate 失败：${String(res.message ?? "")}` };
      }
      if (res.type !== "activated") {
        worker.kill();
        return { ok: false, detail: `worker 响应异常：${res.type}` };
      }
      const tools = new Map<string, L1ToolDef>();
      for (const d of (res.tools ?? []) as { name: string; description: string; parameters: Record<string, unknown> }[]) {
        const full = l1ToolFullName(id, d.name);
        if (this.has(full) || tools.has(full)) {
          worker.kill();
          throw new Error(`工具名冲突：${full} 已存在——冲突时插件加载失败，不静默覆盖（§4.2.2）`);
        }
        tools.set(full, {
          name: d.name,
          description: d.description,
          parameters: d.parameters,
          // 真正的执行走 p.worker（execute 按 loaded[id].worker 路由）；这个占位永不直接调用
          execute: () => {
            throw new Error("worker 模式的执行应经由隔离进程路由");
          },
        });
      }
      this.loaded.set(id, { id, dir, manifest, tools, worker });
      return { ok: true, detail: `已激活（隔离进程，${tools.size} 个工具：${[...tools.keys()].join("、") || "无"}）` };
    }

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
    if (p.worker) p.worker.dispose(); // 隔离进程：钩子在 worker 里尽力跑一下，然后杀进程树
    this.loaded.delete(id);
    this.chains.delete(id); // 排队链一并清掉：重载后的新实例不该等旧调用的尾巴
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
