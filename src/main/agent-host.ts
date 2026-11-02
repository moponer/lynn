import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { killProcessTree } from "./process-tree";
import { clearWorkerMarker, writeWorkerMarker } from "./agent-orphans";
import { drainUtf8Lines } from "./rpc-lines";

/**
 * Pi RPC 宿主（M0-03 / §4.1）：壳与内核分进程。
 *
 * 形状参考 tt-11-dd/tether-ai（MIT）src/main/agent-host.ts（AgentHost）：
 *  - JSONL over stdio；request/response 用 id 配对，事件单向推送
 *  - 超时分级：普通指令 45s，长任务（prompt/abort）30min
 *  - **busy 看门狗**：本地 busy 只由事件流驱动，漏一条 settled 会永久卡死；
 *    busy 期间每 10s 向子进程要权威 isStreaming，连续两次空闲才回落并补 settled
 *  - 子进程死亡 → 拒绝全部挂起请求、带上 stderr 报错；退出前杀进程树
 *
 * 与参考实现的差异：会话只有一条（风铃单会话），没有多 workspace 路由与 tempId。
 */

export interface RpcToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentStats {
  tokens: { input: number; output: number; total: number };
  contextTokens: number;
  contextWindow: number;
  sessionId?: string;
  sessionFile?: string;
}

export interface AgentHostOptions {
  /** 子进程入口（agent/pi-rpc-entry.mjs） */
  entryPath: string;
  /** 模型配置（经环境变量下发，不落盘、不经 argv 暴露） */
  model: { baseUrl: string; apiKey: string; model: string; provider?: string };
  tools: RpcToolSpec[];
  /** 人设/行为约束：由壳下发到子进程，注入 Pi 的 system prompt */
  systemPrompt?: string;
  /** 工具在主进程执行后回传（壳保留权限与审计） */
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  onEvent: (ev: { type: string; [k: string]: unknown }) => void;
  onError: (message: string) => void;
  /** 测试注入 */
  execPath?: string;
  spawnImpl?: typeof spawn;
  /** busy 看门狗周期（默认 10s；测试可调小） */
  watchdogMs?: number;
  /** 运行时标记目录：写 worker pid，退出时删；下次启动据此清理孤儿 */
  markerDir?: string;
  /** 续上一次会话（默认 true）；session.new 时传 false 开新档 */
  resume?: boolean;
  /** 本线程的 Pi 会话目录（M1-14：线程之间不串档） */
  sessionDir?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const LONG_RPC_TIMEOUT_MS = 30 * 60_000;
const BUSY_WATCHDOG_MS = 10_000;
const STDERR_CAP = 200_000;
const LONG_RUNNING = new Set(["prompt", "abort", "get_messages"]);

export class AgentHost {
  private child?: ChildProcessWithoutNullStreams;
  private lineBuffer: Buffer = Buffer.alloc(0);
  private stderr = "";
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private busy = false;
  private busyWatchdog?: NodeJS.Timeout;
  private idleProbeStreak = 0;
  private probing = false;

  constructor(private readonly options: AgentHostOptions) {}

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  isBusy(): boolean {
    return this.isRunning() && this.busy;
  }

  /** 启动 worker 并完成 init（下发工具清单） */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    const entry = path.resolve(this.options.entryPath);
    if (!fs.existsSync(entry)) throw new Error(`RPC 入口不存在：${entry}`);
    const execPath = this.options.execPath ?? process.execPath;
    const spawnImpl = this.options.spawnImpl ?? spawn;
    this.lineBuffer = Buffer.alloc(0);
    this.stderr = "";

    const child = spawnImpl(execPath, [entry], {
      cwd: path.dirname(entry),
      env: {
        ...process.env,
        // Electron 二进制以 Node 身份跑 worker（无窗口）；纯 node 环境下该变量无害
        ELECTRON_RUN_AS_NODE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        // 默认不续档：只有壳明确说"这次要续"才读旧会话，避免测试/新装翻出无关历史
        LYNN_RESUME: this.options.resume === true ? "1" : "0",
        ...(this.options.sessionDir ? { PI_CODING_AGENT_SESSION_DIR: this.options.sessionDir } : {}),
        LYNN_MODEL_BASE_URL: this.options.model.baseUrl,
        LYNN_MODEL_API_KEY: this.options.model.apiKey,
        LYNN_MODEL: this.options.model.model,
        ...(this.options.model.provider ? { LYNN_PROVIDER: this.options.model.provider } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    if (this.options.markerDir && child.pid !== undefined) {
      writeWorkerMarker(this.options.markerDir, {
        pid: child.pid,
        entry,
        startedAt: new Date().toISOString(),
      });
    }

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC worker 启动超时。${this.stderr.trim()}`)), 20_000);
      this.readyResolver = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyRejecter = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
    });

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
      this.handleExit(new Error(`Agent 子进程退出（code ${code ?? "unknown"}${signal ? `, ${signal}` : ""}）`));
    });

    await readyPromise;
    const initResult = await this.request<{ tools: string[] }>("init", {
      tools: this.options.tools,
      ...(this.options.systemPrompt ? { systemPrompt: this.options.systemPrompt } : {}),
    });
    void initResult;
  }

  private readyResolver?: () => void;
  private readyRejecter?: (err: Error) => void;

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

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("RPC worker 未运行");
    if (type === "prompt") {
      this.busy = true;
      this.armWatchdog();
    }
    // abort 不在这里改 busy：以 worker 的 agent_settled / 看门狗对账为准，避免"假装停了"
    const id = `desktop_${++this.requestId}`;
    const command = { ...data, type, id };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi 未响应 ${type}。${this.stderr.trim()}`.trim()));
      }, LONG_RUNNING.has(type) ? LONG_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timeout });
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 会话用量（token / 上下文占比）：失败返回 null，不编造数字 */
  async stats(): Promise<AgentStats | null> {
    if (!this.isRunning()) return null;
    try {
      const r = await this.request<AgentStats>("get_stats");
      if (!r || !r.tokens) return null;
      return r;
    } catch {
      return null;
    }
  }

  /** 工具执行结果回传（壳执行完） */
  respondTool(id: string, content: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: "tool_response", id, content })}\n`);
    } catch {
      // worker 已退：丢弃即可，per-request 超时会给前端如实报错
    }
  }

  getStderr(): string {
    return this.stderr;
  }

  // ---------- 内部 ----------

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
    if (type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(data.id);
      if (data.success === false) pending.reject(new Error(String(data.error ?? "RPC 指令失败")));
      else pending.resolve(data.data);
      return;
    }
    if (type === "ready") {
      this.readyResolver?.();
      this.readyResolver = undefined;
      return;
    }
    if (type === "tool_request" && typeof data.id === "string" && typeof data.name === "string") {
      const id = data.id;
      const args = (data.arguments ?? {}) as Record<string, unknown>;
      void this.options
        .onToolCall(data.name, args)
        .then((content) => this.respondTool(id, content))
        .catch((err) => this.respondTool(id, `工具执行失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (type === "agent_start") {
      this.busy = true;
      this.armWatchdog();
    }
    if (type === "agent_settled") {
      this.busy = false;
      this.disarmWatchdog();
    }
    if (type === "error") {
      this.options.onError(String(data.message ?? "未知错误"));
      return;
    }
    this.options.onEvent({ ...data, type });
  }

  /**
   * busy 看门狗：本地 busy 只由事件驱动；漏一条 settled 会永久锁死输入。
   * busy 期间每 10s 问一次权威 isStreaming；连续两次空闲才回落，避开「prompt 刚发、agent_start 未到」的窗口。
   */
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
  }

  private handleExit(error: Error): void {
    this.busy = false;
    this.disarmWatchdog();
    this.readyRejecter?.(error);
    this.readyResolver = undefined;
    this.readyRejecter = undefined;
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
