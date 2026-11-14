import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { killProcessTree } from "./process-tree";
import { clearWorkerMarker, writeWorkerMarker } from "./agent-orphans";
import { drainUtf8Lines } from "./rpc-lines";
import type { AgentStats, RpcToolSpec } from "./agent-host";

/**
 * Pi 官方 RPC 薄胶水层（架构红线：基座完整不变，新功能插件式接入）。
 *
 * 与旧的 AgentHost 不同，这里**不定义任何协议语义**：
 *  - 起的是 Pi 自带 `dist/bundle/rpc-entry.js`（内部已是 --mode rpc）；
 *  - 命令名/事件名全部沿用官方（prompt/steer/abort/get_state/get_messages/get_session_stats…）；
 *  - stdout 上除 response / extension_ui_request 外**全量转发生事件**，不做白名单裁剪；
 *  - 模型与凭据交给 Pi 的 models.json + 环境变量插值，不自己 registerProvider；
 *  - 风铃特有逻辑（工具桥、persona）在 agent/extensions/lynn-bridge.mjs 这个官方扩展里。
 *
 * 保留的只有 Electron 侧必需的传输胶水：NDJSON 帧、id 配对、双档超时、busy 看门狗、
 * 进程树回收、stderr 汇聚。形状参考 F:\tmp\ref-tether\src\main\agent-host.ts。
 */

export const PI_PROVIDER_ID = "lynn-user";
const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const LONG_RPC_TIMEOUT_MS = 30 * 60_000;
const BUSY_WATCHDOG_MS = 10_000;
const STDERR_CAP = 200_000;
const LONG_RUNNING = new Set(["prompt", "abort", "get_messages", "get_entries", "get_tree", "export_html"]);
export const TOOL_BRIDGE_TITLE = "lynn:tool";

export interface PiModelConfig {
  baseUrl: string;
  /** 明文 Key 只通过子进程 env 传递；models.json 里写的是 $LYNN_MODEL_API_KEY */
  apiKey: string;
  model: string;
  provider?: string;
  /**
   * 真实上下文窗口（2026-11-13 缓存审计）：Pi 按它决定压缩时机与上下文占比读数。
   * 缺省 128000——对百万窗口模型会提前压缩（一次压缩 = 前缀缓存全废 + 全价重读）。
   */
  contextWindow?: number;
}

export interface PiRpcHostOptions {
  /** Pi 官方 RPC 入口：node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js */
  entryPath: string;
  /** 风铃扩展（官方 --extension） */
  extensionPath: string;
  model: PiModelConfig;
  tools: RpcToolSpec[];
  /** Pi agent 目录（models.json / auth.json 所在） */
  agentDir: string;
  /** 本线程的 Pi 会话目录 */
  sessionDir?: string;
  /** 用户项目根：Pi 的 cwd */
  projectRoot?: string;
  /** persona 文本文件：扩展每轮重读，热更新不重启 */
  personaFile?: string;
  resume?: boolean;
  systemPrompt?: string;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  onEvent: (ev: { type: string; [k: string]: unknown }) => void;
  onError: (message: string) => void;
  execPath?: string;
  spawnImpl?: typeof spawn;
  watchdogMs?: number;
  markerDir?: string;
}

/** models.json 是 Pi 原生的 provider 声明；Key 用 $ENV 插值，不落明文 */
export function modelsJsonFor(cfg: PiModelConfig): string {
  return `${JSON.stringify({
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      [PI_PROVIDER_ID]: {
        name: cfg.provider || "风铃自定义端点",
        baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
        api: "openai-completions",
        apiKey: "$LYNN_MODEL_API_KEY",
        models: [
          {
            id: cfg.model,
            name: cfg.model,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: cfg.contextWindow ?? 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  }, null, 2)}\n`;
}

export function writeModelsJson(agentDir: string, cfg: PiModelConfig): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), modelsJsonFor(cfg), "utf-8");
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class PiRpcHost {
  private child?: ChildProcessWithoutNullStreams;
  private lineBuffer: Buffer = Buffer.alloc(0);
  private stderr = "";
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private settledWaiters = new Set<() => void>();
  private busy = false;
  private busyWatchdog?: NodeJS.Timeout;
  private idleProbeStreak = 0;
  private probing = false;
  private lastSessionId?: string;

  constructor(private readonly options: PiRpcHostOptions) {}

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }
  isBusy(): boolean {
    return this.isRunning() && this.busy;
  }
  get sessionId(): string | undefined {
    return this.lastSessionId;
  }
  getStderr(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    const entry = path.resolve(this.options.entryPath);
    const extension = path.resolve(this.options.extensionPath);
    if (!fs.existsSync(entry)) throw new Error(`Pi 官方 RPC 入口不存在：${entry}`);
    if (!fs.existsSync(extension)) throw new Error(`风铃扩展不存在：${extension}`);
    writeModelsJson(this.options.agentDir, this.options.model);
    if (this.options.personaFile && this.options.systemPrompt !== undefined) {
      fs.mkdirSync(path.dirname(this.options.personaFile), { recursive: true });
      fs.writeFileSync(this.options.personaFile, this.options.systemPrompt, "utf-8");
    }

    const names = this.options.tools.map((t) => t.name);
    const args = [
      entry,
      "--provider", PI_PROVIDER_ID,
      "--model", this.options.model.model,
      "--extension", extension,
      "--no-builtin-tools", "--no-mcp", "--no-context-files",
      ...(names.length ? ["--tools", names.join(",")] : []),
      ...(this.options.sessionDir ? ["--session-dir", this.options.sessionDir] : []),
      ...(this.options.resume ? ["--continue"] : ["--session-id", `lynn-${Date.now().toString(36)}`]),
    ];
    const child = (this.options.spawnImpl ?? spawn)(this.options.execPath ?? process.execPath, args, {
      cwd: this.options.projectRoot ?? path.dirname(entry),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PI_CODING_AGENT_DIR: this.options.agentDir,
        ...(this.options.sessionDir ? { PI_CODING_AGENT_SESSION_DIR: this.options.sessionDir } : {}),
        LYNN_MODEL_API_KEY: this.options.model.apiKey,
        LYNN_MODEL_BASE_URL: this.options.model.baseUrl,
        LYNN_MODEL: this.options.model.model,
        LYNN_PROVIDER: this.options.model.provider ?? "",
        LYNN_TOOL_SPECS: JSON.stringify(this.options.tools),
        ...(this.options.personaFile ? { LYNN_PERSONA_FILE: this.options.personaFile } : {}),
        ...(this.options.projectRoot ? { LYNN_PROJECT_ROOT: this.options.projectRoot } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.lineBuffer = Buffer.alloc(0);
    this.stderr = "";
    if (this.options.markerDir && child.pid !== undefined) {
      writeWorkerMarker(this.options.markerDir, { pid: child.pid, entry, startedAt: new Date().toISOString() });
    }

    child.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_CAP);
    });
    child.stdin.on("error", (error) => {
      if (this.child !== child) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (!/EPIPE|ECONNRESET|broken pipe/i.test(detail)) this.options.onError(detail);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (child.pid !== undefined) void killProcessTree(child.pid, "SIGTERM");
      this.handleExit(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (child.pid !== undefined) void killProcessTree(child.pid, "SIGTERM");
      if (this.options.markerDir && child.pid !== undefined) clearWorkerMarker(this.options.markerDir, child.pid);
      this.handleExit(new Error(`Pi RPC 子进程退出（code ${code ?? "unknown"}${signal ? `, ${signal}` : ""}）`));
    });

    // 官方 RPC 没有 ready 帧：用官方 get_state 握手，等得到响应即就绪
    const state = await this.request<{ sessionId?: string }>("get_state", {}, 20_000);
    if (typeof state?.sessionId === "string") this.lastSessionId = state.sessionId;
  }

  /** 官方命令：一律 {type, id, ...data}；响应 {type:"response", id, success, data|error} */
  request<T>(type: string, data: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error("Pi RPC worker 未运行"));
    const id = `lynn_${++this.requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi 未响应 ${type}。${this.stderr.trim()}`.trim()));
      }, timeoutMs ?? (LONG_RUNNING.has(type) ? LONG_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS));
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timeout });
      try {
        child.stdin.write(`${JSON.stringify({ ...data, type, id })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 官方 prompt 的响应只代表「被接受」，不代表跑完（docs/rpc-commands.md:9,42）。
   * 这里等官方 agent_settled 事件，等价于 RpcClient.promptAndWait() 的语义。
   */
  async prompt(text: string): Promise<{ disposition?: string }> {
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
      this.settledWaiters.add(resolve);
    });
    try {
      const result = await this.request<{ disposition?: string }>("prompt", { message: text });
      if (result?.disposition !== "handled") await settled;
      return result ?? {};
    } finally {
      this.settledWaiters.delete(done);
    }
  }

  steer(text: string): Promise<unknown> {
    return this.request("steer", { message: text });
  }

  abort(): Promise<unknown> {
    return this.request("abort");
  }

  /** persona 热更新：扩展每轮重读文件，不需要给 worker 发自定义指令 */
  updateSystemPrompt(text: string): void {
    if (!this.options.personaFile) throw new Error("未配置 persona 文件");
    fs.mkdirSync(path.dirname(this.options.personaFile), { recursive: true });
    fs.writeFileSync(this.options.personaFile, text, "utf-8");
  }

  async stats(): Promise<AgentStats | null> {
    if (!this.isRunning()) return null;
    try {
      const r = await this.request<{
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
        cost?: number;
        contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
        sessionId?: string;
        sessionFile?: string;
      }>("get_session_stats");
      if (!r?.tokens) return null;
      const input = r.tokens.input ?? 0;
      const output = r.tokens.output ?? 0;
      const cacheRead = r.tokens.cacheRead ?? 0;
      const cacheWrite = r.tokens.cacheWrite ?? 0;
      return {
        tokens: {
          input,
          output,
          cacheRead,
          cacheWrite,
          total: r.tokens.total ?? input + output + cacheRead + cacheWrite,
        },
        cost: r.cost ?? 0,
        contextTokens: r.contextUsage?.tokens ?? 0,
        contextWindow: r.contextUsage?.contextWindow ?? 128_000,
        contextPercent: r.contextUsage?.percent ?? undefined,
        sessionId: r.sessionId,
        sessionFile: r.sessionFile,
      };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    this.disarmWatchdog();
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("会话已关闭"));
    }
    this.pending.clear();
    this.releaseSettled();
    if (this.options.markerDir && child.pid !== undefined) clearWorkerMarker(this.options.markerDir, child.pid);
    if (child.exitCode !== null || child.pid === undefined) return;
    await killProcessTree(child.pid, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) void killProcessTree(child.pid, "SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---------- 内部：只做帧层，不裁剪事件面 ----------

  private handleChunk(chunk: Buffer): void {
    const drained = drainUtf8Lines(this.lineBuffer, chunk);
    this.lineBuffer = drained.rest;
    for (const line of drained.lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof data.type === "string" ? data.type : "";
    if (typeof data.sessionId === "string") this.lastSessionId = data.sessionId;

    if (type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(data.id);
      if (data.success === false) pending.reject(new Error(String(data.error ?? "RPC 指令失败")));
      else pending.resolve(data.data);
      return;
    }

    if (type === "extension_ui_request" && typeof data.id === "string") {
      void this.handleToolBridge(data);
      // 仍是官方事件，照常全量透传（壳可以显示/记录）
    }

    if (type === "agent_start") {
      this.busy = true;
      this.armWatchdog();
    }
    if (type === "agent_settled") {
      this.busy = false;
      this.disarmWatchdog();
      this.releaseSettled();
    }
    this.options.onEvent({ ...data, type });
  }

  /** 官方 extension UI 子协议：input dialog 承载「工具回壳执行」的请求/响应 */
  private async handleToolBridge(data: Record<string, unknown>): Promise<void> {
    if (data.method !== "input" || data.title !== TOOL_BRIDGE_TITLE) return;
    let name = "";
    let args: Record<string, unknown> = {};
    try {
      const payload = JSON.parse(String(data.placeholder ?? ""));
      name = String(payload.name ?? "");
      args = (payload.args ?? {}) as Record<string, unknown>;
    } catch {
      /* 下面回一个结构化错误 */
    }
    let value: string;
    try {
      if (!name) throw new Error("工具桥请求缺少工具名");
      value = JSON.stringify({ ok: true, content: await this.options.onToolCall(name, args) });
    } catch (err) {
      value = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: data.id, value })}\n`);
    } catch {
      /* 进程已退：工具超时会在 Pi 侧兜住 */
    }
  }

  private releaseSettled(): void {
    for (const resolve of this.settledWaiters) resolve();
    this.settledWaiters.clear();
  }

  private armWatchdog(): void {
    if (this.busyWatchdog) return;
    this.busyWatchdog = setInterval(() => void this.probeIdle(), this.options.watchdogMs ?? BUSY_WATCHDOG_MS);
    this.busyWatchdog.unref?.();
  }

  private disarmWatchdog(): void {
    if (this.busyWatchdog) clearInterval(this.busyWatchdog);
    this.busyWatchdog = undefined;
    this.idleProbeStreak = 0;
  }

  private async probeIdle(): Promise<void> {
    if (this.probing) return;
    if (!this.busy || !this.isRunning()) {
      this.disarmWatchdog();
      return;
    }
    this.probing = true;
    try {
      const state = await this.request<{ isStreaming?: boolean }>("get_state");
      if (state?.isStreaming === false) {
        this.idleProbeStreak += 1;
        if (this.idleProbeStreak >= 2) this.settleIfStale();
      } else {
        this.idleProbeStreak = 0;
      }
    } catch {
      this.idleProbeStreak = 0;
    } finally {
      this.probing = false;
    }
  }

  private settleIfStale(): void {
    this.idleProbeStreak = 0;
    this.disarmWatchdog();
    if (!this.busy) return;
    this.busy = false;
    this.options.onEvent({ type: "agent_settled", reconciled: true });
    this.releaseSettled();
  }

  private handleExit(error: Error): void {
    this.busy = false;
    this.disarmWatchdog();
    this.releaseSettled();
    const detail = this.stderr.trim();
    const message = detail ? `${error.message}\n${detail}` : error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.options.onError(message);
  }
}
