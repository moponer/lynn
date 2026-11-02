import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BoardData,
  Decision,
  FeedCard,
  KernelEvent,
  PermissionMode,
  QueueItem,
  RpcContracts,
  RpcMethod,
  TaskPlan,
  TurnPhase,
  TurnState,
  UsageView,
} from "../shared/contract";
import { ManagementTools } from "./management-tools";
import { streamChat, probeEndpoint, type ChatMessage, type ToolSchema } from "./llm";
import { SettingsStore, loadApiKey, defaultDataRoot } from "./settings";
import { applyPiEnvironment } from "./pi-home";
import { reapOrphanWorkers } from "./agent-orphans";
import { McpRegistry, loadMcpConfig, loadMcpConfigAt, type McpServerConfig } from "./mcp";
import { CheckpointStore } from "./checkpoints";
import { TrustStore } from "./trust";
import { ThreadStore } from "./threads";
import { buildTurnAttachments, searchProjectFiles, type TurnAttachments } from "./attachments";
import { PersonaStore, composeSystemPrompt } from "./persona";
import { MemoryStore, type MemoryKind } from "./memory";
import { TeamStore } from "./team-store";
import { TaskStore } from "./task-store";
import { TaskCase } from "./task-case";
import { ContextStore } from "./context-store";
import { scanUiPlugins } from "./ui-plugins";
import { PluginHost } from "./plugin-host";
import { PluginSetStore } from "./plugin-set";
import { runMemberTask, MEMBER_EXEC_TOOLS, type MemberRunResult } from "./member-runner";
import { L1Host } from "./plugin-l1";
import { AgentHost, type RpcToolSpec } from "./agent-host";

/**
 * 内核：**Pi 为底座**（§1.3）。
 * - Agent 循环 / 模型协议：@earendil-works/pi-agent-core + pi-ai（ESM，动态加载）
 * - 我方产品层：管理工具 8 件套（execute 桥接 Pi 的 AgentTool）、权限、审计、指挥板
 * - 直连 OpenAI 兼容实现（llm.ts）保留为 Pi 不可用时的降级路径
 * 渲染层契约（contract.ts）不感知以上差别。
 */

/** system prompt 组装（M1-17）：固定头 + persona（可编辑）+ 安全尾段强制后置 */
// 原 SYSTEM_PROMPT 已拆入 persona.ts 的 PROMPT_HEAD / PROMPT_TAIL / DEFAULT_PERSONA

// ---------- 我方工具定义（与 RPC worker / 直连共用一份语义） ----------

const TOOL_JSON: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "create_member",
      description:
        "招募团队成员（书面岗位）：名字、岗位、单一目标、边界（不许做什么）、工具白名单、产出契约与验收标准。超过 6 人编制需要 justification。",
      parameters: {
        type: "object",
        required: ["teamId", "name", "role", "goal", "tools"],
        properties: {
          teamId: { type: "string" },
          name: { type: "string" },
          role: { type: "string" },
          goal: { type: "string", description: "单一目标，行为收敛的关键" },
          boundaries: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" }, description: "执行类工具白名单，如 read/write/edit/bash/glob/grep/browser/office" },
          deliverable: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          justification: { type: "string", description: "超过 6 人编制时必填" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_task",
      description: "向成员派单。成员只拿到简报包（任务+完成标准+时限），看不到你们的对话。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId", "member", "brief", "deadline"],
        properties: {
          teamId: { type: "string" },
          taskId: { type: "string" },
          member: { type: "string" },
          brief: { type: "string" },
          deadline: { type: "string" },
          tools: { type: "array", items: { type: "string" }, description: "本次分配工具集，必须 ⊆ 岗位白名单" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（写进任务契约，用户点开始后生效）" },
          template: {
            type: "string",
            description: "复用哪套编制模板（省略则按任务标题自动匹配；没有模板会如实报错，不会凭空造团队）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_progress",
      description: "查看某任务进度（派单数/回报数/打回数/最新回报摘要）。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId"],
        properties: { teamId: { type: "string" }, taskId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_roster",
      description:
        "查看班底花名册与战绩（M2-14）：各成员岗位、工具白名单与历次验收结论（做过的单/过验/被打回/升级次数）。派单前先看战绩，把活给对的人。",
      parameters: {
        type: "object",
        properties: { teamId: { type: "string", description: "不传则列出全部团队" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_result",
      description: "登记成员节点回报。必须附证据；无证据会被拒绝登记。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId", "member", "text", "evidence"],
        properties: {
          teamId: { type: "string" },
          taskId: { type: "string" },
          member: { type: "string" },
          text: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_or_reject",
      description: "验收或打回。打回必须写 what/expect/deadline；连续 3 轮打回将强制升级问用户。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId", "member", "verdict"],
        properties: {
          teamId: { type: "string" },
          taskId: { type: "string" },
          member: { type: "string" },
          verdict: { type: "string", enum: ["accept", "reject"] },
          what: { type: "string" },
          expect: { type: "string" },
          deadline: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_to_user",
      description: "向用户汇报。四件套：结论/证据/未完成项/需要用户拍板的事。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId", "conclusion"],
        properties: {
          teamId: { type: "string" },
          taskId: { type: "string" },
          conclusion: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          unfinished: { type: "array", items: { type: "string" } },
          decisionsNeeded: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "向用户提问（口径、超预算、连续打回升级）。成员没有问用户的通道，问题由你归集转呈。",
      parameters: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string" }, context: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dissolve_team",
      description: "解散团队或保留编制复用。",
      parameters: {
        type: "object",
        required: ["teamId", "keep"],
        properties: { teamId: { type: "string" }, keep: { type: "boolean" } },
      },
    },
  },
];

/**
 * 风铃实际挂给模型的工具名（§3.1 硬约束）。
 * 测试据此断言：她只有管理型工具，没有任何执行类工具。
 */
export const AGENT_TOOL_NAMES: readonly string[] = TOOL_JSON.map((t) => t.function.name);

type DecisionEntry = Decision;

/** 待确认的任务契约（只存一次派单所需的最小上下文） */
interface PendingPlan {
  decisionId?: string;
  teamId: string;
  taskId: string;
  member: string;
  brief: string;
  deadline: string;
  tools?: string[];
}

/** 排队中的输入 */
interface QueuedInput extends QueueItem {
  mode: "queue" | "steer";
  attachments?: TurnAttachments;
}

/** 计划档位下也允许的只读工具 */
const READ_ONLY_TOOLS = new Set(["check_progress", "check_roster"]);

export class Kernel {
  readonly dataRoot: string;
  private settings: SettingsStore;
  private teamStore: TeamStore;
  private taskStore: TaskStore;
  private taskCase: TaskCase;
  private contextStore: ContextStore;
  private pluginHost: PluginHost;
  private pluginSet: PluginSetStore;
  private tools: ManagementTools;
  private permission: PermissionMode = "auto";
  private feed: FeedCard[] = [];
  private history: ChatMessage[] = [];
  private decisions: DecisionEntry[] = [];
  private tokensUsed = 0;
  private cardSeq = 0;
  private busy = false;
  /** L1 进程内扩展运行时（§4.2.1；构造时接 PluginHost） */
  readonly l1: L1Host;
  /** 进行中的成员执行（taskId → 完成时自动回报审查台；M0-09） */
  private memberRuns = new Map<string, Promise<MemberRunResult>>();
  /** 成员进度（姓名 → 0–100）：只在内存里，用来画实时进度 */
  private memberProgress = new Map<string, number>();
  private listeners = new Set<(ev: KernelEvent) => void>();

  /** Pi RPC worker 可用（M0-03：壳与运行时分进程） */
  private piReady = false;
  /** 子进程宿主；懒启动，配置/工具面变化时重建 */
  private host: AgentHost | null = null;
  private hostStamp = "";
  /** 流式中的她：runChat 里增量 patch */
  private liveCard: FeedCard | null = null;
  /** 上一次推 delta 事件的时间（节流到 ~80ms 一次） */
  private lastDeltaEmit = 0;

  /** 回合状态（唯一真相源，渲染层只读） */
  private turn: TurnState = { phase: "idle", busy: false, pending: 0 };
  /** 用量读数（RPC 路径由 Pi 的 getSessionStats 提供） */
  private usage: UsageView = {
    turnIn: 0,
    turnOut: 0,
    sessionIn: 0,
    sessionOut: 0,
    contextTokens: 0,
    contextWindow: 128_000,
  };
  /** 排队输入（生成中打字） */
  private queue: QueuedInput[] = [];
  private queueSeq = 0;
  /** 待确认的任务契约（decisionId → 派单上下文） */
  private pendingPlans = new Map<string, PendingPlan>();
  /** 等你批准的工具调用（decisionId → 决议器） */
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void }>();
  /** L2 MCP 工具（mcp__server__tool） */
  private mcp = new McpRegistry();
  /** 逐轮文件检查点（M1-12） */
  private checkpoints!: CheckpointStore;
  /** 项目信任（M1-13）：决定项目级 mcp.json 能不能注入工具 */
  private trust!: TrustStore;
  private projectRoot!: string;
  /** 多会话线程（M1-14）：列表/状态持久化 + 当前线程 id */
  private threads!: ThreadStore;
  private currentThreadId!: string;
  /** persona.md（M1-17）：语气人设可编辑 + 版本化 */
  private persona!: PersonaStore;
  /** 会话记忆两层（M2-05）：USER.md 永远保留；MEMORY.md 可 diff/回滚 */
  private memory!: MemoryStore;
  /** 下一次起 worker 时开新会话（session.new 置位；起过一次即清） */
  private createFreshSession = false;
  /** 用户点了停止：本轮结束时不追加"已完成"类文案 */
  private abortRequested = false;

  private decryptor: ((blob: Buffer) => string) | null = null;

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = dataRoot;
    // 测试环境（LYNN_HOME 隔离）无 safeStorage；main.ts 会用真实现覆盖
    this.settings = new SettingsStore(dataRoot, (plain) => Buffer.from(plain, "utf-8"), () => false);
    this.teamStore = new TeamStore(dataRoot);
    this.taskStore = new TaskStore(dataRoot);
    this.taskCase = new TaskCase(dataRoot);
    this.contextStore = new ContextStore(dataRoot);
    this.checkpoints = new CheckpointStore(path.join(dataRoot, "checkpoints"));
    this.trust = new TrustStore(dataRoot);
    this.projectRoot = process.env.LYNN_PROJECT_DIR
      ? path.resolve(process.env.LYNN_PROJECT_DIR)
      : path.join(dataRoot, "project");
    this.mcp = new McpRegistry();
    this.pluginHost = new PluginHost(dataRoot);
    this.pluginSet = new PluginSetStore(dataRoot);
    this.l1 = new L1Host({
      listEntries: () => this.pluginHost.listL1Entries(),
      manifestOf: (id) => this.pluginHost.manifestOf(id),
      kernelVersion: "0.0.1",
    });
    this.pluginHost.attachL1(this.l1);
    this.tools = new ManagementTools(this.teamStore, dataRoot);
    fs.mkdirSync(path.join(dataRoot, "session"), { recursive: true });
    // 早于 init() 里的 Pi 动态 import：把 Pi 的配置根与遥测开关钉在 ~/.lynn/kernel（§1.6 / §4.7）
    applyPiEnvironment(dataRoot);
    this.loadSession();
    // M1-14：线程状态优先于旧的 timeline/温层重建结果
    this.threads = new ThreadStore(dataRoot);
    this.persona = new PersonaStore(dataRoot);
    this.memory = new MemoryStore(dataRoot);
    const list = this.threads.list();
    const current = list[0] ?? this.threads.create("新会话");
    this.currentThreadId = current.id;
    const st = this.threads.loadState(current.id);
    if (st.feed.length || st.history.length) {
      this.feed = [];
      this.cardSeq = 0;
      for (const c of st.feed) {
        this.feed.push(c);
        const n = Number(/^c-(\d+)$/.exec(c.id)?.[1] ?? 0);
        if (n > this.cardSeq) this.cardSeq = n;
      }
      this.history = st.history;
    }
  }

  setEncryptors(
    encrypt: (plain: string) => Buffer,
    isAvailable: () => boolean,
    decrypt: (blob: Buffer) => string,
  ): void {
    this.settings = new SettingsStore(this.dataRoot, encrypt, isAvailable);
    this.decryptor = decrypt;
  }

  onEvent(cb: (ev: KernelEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 结构化日志：~/.lynn/logs/agent.log（JSONL，5MB 轮转一份）。定位问题不靠 console。 */
  private log(kind: string, data: Record<string, unknown> = {}): void {
    try {
      const dir = path.join(this.dataRoot, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "agent.log");
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
        fs.renameSync(file, path.join(dir, "agent.1.log"));
      }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n", "utf-8");
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  /**
   * 命令审计（M1-11）：拦截、出站、执行三类都落 `audit.jsonl`。
   * 这是"能回查"，不是"能拦住一切"——界面上不许把它说成沙箱。
   */
  private auditTool(
    teamId: string,
    taskId: string,
    member: string,
    ev: { kind: "cmd_blocked" | "cmd_net" | "cmd_run"; command: string; why?: string; cwd: string },
  ): void {
    const rec = { at: new Date().toISOString(), kind: ev.kind, teamId, taskId, member, command: ev.command.slice(0, 500), why: ev.why, cwd: ev.cwd };
    try {
      fs.appendFileSync(path.join(this.dataRoot, "audit.jsonl"), JSON.stringify(rec) + "\n", "utf-8");
    } catch {
      /* 审计写不进去也不能影响执行，但会缺一条记录 */
    }
    this.log("tool_audit", { kind: ev.kind, taskId, member, why: ev.why });
    if (ev.kind === "cmd_blocked") {
      this.emit({ type: "tool", badge: "已拦截", title: `${member} · ${taskId}`, body: `命令被纵深防御规则拦下：${ev.why}\n${ev.command}` });
    } else if (ev.kind === "cmd_net") {
      this.emit({ type: "tool", badge: "出站", title: `${member} · ${taskId}`, body: `出站命令已审计：${ev.command}` });
    }
  }

  private notify(ev: KernelEvent): void {
    for (const cb of this.listeners) cb(ev);
  }

  private emit(ev: KernelEvent): void {
    // 工具事件也落进 feed（界面按 feed 渲染，事件只是"有新东西"的信号）
    if (ev.type === "tool") {
      this.card({
        kind: "tool",
        badge: ev.badge,
        title: ev.title,
        meta: ev.meta,
        body: ev.body,
        members: ev.members,
        jobId: ev.jobId,
        report: ev.report,
      });
    }
    this.notify(ev);
  }

  private card(c: Omit<FeedCard, "id" | "createdAt">): FeedCard {
    const full: FeedCard = {
      ...c,
      id: `c-${++this.cardSeq}`,
      createdAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    this.feed.push(full);
    this.notify({ type: "card", card: full });
    this.persistThreadSoon();
    return full;
  }

  /** 更新一张已有卡片（流式文本 / 状态变化），并通知渲染层 upsert */
  private patchCard(card: FeedCard, patch: Partial<FeedCard>): void {
    Object.assign(card, patch);
    this.notify({ type: "card", card, replaced: true });
    this.persistThreadSoon();
  }

  /** 回合状态迁移：所有 UI 的"谁在干什么"都只读这一个字段 */
  private setTurn(patch: Partial<TurnState>): void {
    this.turn = { ...this.turn, ...patch, pending: this.queue.length };
    this.notify({ type: "turn", turn: this.turn });
  }

  // ---------- 线程落盘（M1-14） ----------

  private threadSaveTimer: NodeJS.Timeout | null = null;

  /** system prompt（M1-17/M2-05）：固定头 + persona + 记忆两层 + 安全尾段；每轮现取 */
  private systemPrompt(): string {
    return composeSystemPrompt(this.persona.load()) + this.memory.systemPromptSection();
  }

  /** 壳层读偏好（托盘/通知开关，M1-18）：壳不直接碰 SettingsStore */
  getPrefs(): { autoStart: boolean; trayOnClose: boolean; notify: boolean } {
    const p = this.settings.getPrefs();
    return { autoStart: p.autoStart, trayOnClose: p.trayOnClose, notify: p.notify };
  }

  private assertMemoryKind(kind: string): asserts kind is MemoryKind {
    if (kind !== "user" && kind !== "memory") throw new Error(`未知记忆层：${kind}（user | memory）`);
  }

  /** persona/记忆变更后热同步到 Pi worker；失败如实落卡（下一轮 prompt 前仍会用启动时的旧词） */
  private hotSyncSystemPrompt(): boolean {
    if (!this.host?.isRunning()) return false;
    void this.host
      .updateSystemPrompt(this.systemPrompt())
      .catch((err) => {
        this.card({
          kind: "system",
          text: `persona 已保存，但当前会话热更新失败：${err instanceof Error ? err.message : String(err)}。重启应用后生效。`,
        });
      });
    return true;
  }

  private persistThread(): void {
    if (!this.currentThreadId) return;
    try {
      this.threads.saveState(this.currentThreadId, {
        feed: this.feed.slice(-200),
        history: this.history
          .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
          .slice(-200),
      });
    } catch {
      /* 落盘失败不影响对话 */
    }
  }

  /** 卡片/流式都会调：600ms 合并一次，崩溃最多丢最后一小段 */
  private persistThreadSoon(): void {
    if (this.threadSaveTimer) return;
    this.threadSaveTimer = setTimeout(() => {
      this.threadSaveTimer = null;
      this.persistThread();
    }, 600);
  }

  /** 切线程：先存当前，再装载目标；Pi 会话目录按线程隔离 */
  private switchThread(id: string): void {
    if (id === this.currentThreadId) return;
    const meta = this.threads.get(id);
    if (!meta) throw new Error(`会话不存在：${id}`);
    this.persistThread();
    this.currentThreadId = id;
    const st = this.threads.loadState(id);
    this.feed = [];
    this.history = [];
    this.cardSeq = 0;
    for (const c of st.feed) {
      this.feed.push(c);
      const n = Number(/^c-(\d+)$/.exec(c.id)?.[1] ?? 0);
      if (n > this.cardSeq) this.cardSeq = n;
    }
    this.history = st.history;
    this.liveCard = null;
    this.createFreshSession = true;
    void this.resetAgentHost();
    this.checkpoints.discard();
    this.setTurn({ phase: "idle", busy: false, pending: 0, taskId: undefined, startedAt: undefined, canUndo: false, changedFiles: [] });
  }

  /** 本轮写过文件就把撤销入口亮出来（M1-12） */
  private settleCheckpoint(): void {
    const st = this.checkpoints.status();
    if (st) this.setTurn({ canUndo: true, changedFiles: st.files });
  }

  private setUsage(patch: Partial<UsageView>): void {
    this.usage = { ...this.usage, ...patch };
  }

  // ---------- Pi RPC 初始化（M0-03：独立进程；不可用则降级直连） ----------

  /** RPC worker 入口（agent/pi-rpc-entry.mjs）。打包时需作为 extraResources，见 §4.6 */
  private get rpcEntryPath(): string {
    return path.join(__dirname, "..", "..", "agent", "pi-rpc-entry.mjs");
  }

  async init(): Promise<void> {
    // 只做「能不能用」的静态判定；真正的子进程在首轮对话时懒启动（启动失败会自动降级直连）
    const entry = this.rpcEntryPath;
    const piPkg = path.join(__dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
    this.piReady = fs.existsSync(entry) && fs.existsSync(piPkg);
    if (!this.piReady) {
      console.warn(`[kernel] Pi RPC 不可用（entry=${fs.existsSync(entry)} / sdk=${fs.existsSync(piPkg)}），降级直连模式`);
    } else {
      // 上次异常退出可能留下还在跑的 worker：启动时按标记清掉（单实例锁保证没有别人在用）
      const reaped = reapOrphanWorkers(path.join(this.dataRoot, "runtime", "workers"), { entry });
      if (reaped.length) this.log("orphans_reaped", { pids: reaped });
    }
    // L1 插件启动加载（§4.2.1）：单个失败不影响其余，诊断留在 l1.lastErrors
    await this.l1.loadAll();
    for (const e of this.l1.lastErrors) console.warn("[kernel] L1 加载失败：", e);

    // L2 MCP（M0-07）：全局配置 + 已信任项目的项目级配置
    await this.reloadMcp();
  }

  /**
   * 重新连 MCP（M0-07 + M1-13）：全局 `mcp.json` 永远加载；项目级 `.lynn/mcp.json`
   * 只有在项目被信任时才加载——陌生仓库不能靠一个文件把工具塞进她的工具面。
   */
  private async reloadMcp(): Promise<void> {
    await this.mcp.stopAll();
    const merged = new Map<string, McpServerConfig>();
    const global = loadMcpConfig(this.dataRoot);
    if (global.error) {
      this.log("mcp_config_error", { error: global.error });
      this.card({ kind: "system", text: global.error });
    }
    for (const s of global.servers) merged.set(s.id, s);

    const projectFile = path.join(this.projectRoot, ".lynn", "mcp.json");
    if (fs.existsSync(projectFile)) {
      if (this.trust.isTrusted(this.projectRoot)) {
        const p = loadMcpConfigAt(projectFile);
        if (p.error) {
          this.log("mcp_project_config_error", { error: p.error });
          this.card({ kind: "system", text: `项目级 MCP 配置有问题：${p.error}` });
        }
        for (const s of p.servers) merged.set(s.id, s);
      } else {
        this.log("mcp_project_untrusted", { root: this.projectRoot });
        this.card({
          kind: "system",
          text: `发现项目级 MCP 配置（${projectFile}），这个项目还没被信任，暂不加载。到「设置 → 权限与安全」信任后再试。`,
        });
      }
    }

    const servers = [...merged.values()];
    if (!servers.length) return;
    await this.mcp.startAll(servers);
    for (const e of this.mcp.lastErrors()) {
      this.log("mcp_server_error", e);
      this.card({ kind: "system", text: `MCP 服务器「${e.id}」没连上：${e.message}` });
    }
    this.log("mcp_ready", { tools: this.mcp.size(), fingerprint: this.mcp.fingerprint(), projectTrusted: this.trust.isTrusted(this.projectRoot) });
  }

  // ---------- 工具执行（Pi execute 与直连 tool_calls 共用） ----------

  private teamColor(i: number): string {
    return ["#6396BC", "#E8B04B", "#5FBF77", "#C05687", "#8DA0AB", "#C44A35"][i % 6];
  }

  /**
   * 成员回报登记（风铃 review_result 与成员后台回报共用；§4.10.5 证据原则的执行点）。
   * 证据可点开验证：真实文件收进卷宗 artifacts/，验不了的只登记 verified:false，不冒充。
   */
  private registerReport(teamId: string, taskId: string, member: string, text: string, evidence: string[]): string {
    this.tools.reviewResult(teamId, taskId, { member, text, evidence });
    this.taskCase.append(taskId, { kind: "report", member, text, meta: { evidence } });
    this.taskCase.appendSummary(taskId, `${member} 回报：${text.slice(0, 60)}`);

    try {
      this.taskStore.ensureInProgress({ id: taskId, title: taskId, teamId, member });
    } catch {
      // 工单已存在或状态已就位
    }
    let verified = 0;
    for (const e of evidence) {
      let ref = e;
      let ok = this.taskCase.verifyRef(taskId, e);
      if (ok && !/^https?:\/\//i.test(e) && !e.startsWith("artifacts/")) {
        try {
          ref = this.taskCase.importArtifact(taskId, e).ref;
          ok = true;
        } catch {
          ok = this.taskCase.verifyRef(taskId, ref);
        }
      }
      if (ok) verified += 1;
      this.taskStore.addEvidence(taskId, {
        kind: ok ? "artifact" : "command",
        label: e.slice(0, 80),
        ref,
        verified: ok,
      });
    }

    let moved = false;
    try {
      this.taskStore.transition(taskId, "in_review", { member });
      moved = true;
      this.setTurn({ phase: "review", taskId });
      this.taskCase.append(taskId, { kind: "transition", member, text: "→ in_review" });
      this.taskCase.appendSummary(taskId, `进入待审查（已验证证据 ${verified} 项）`);
    } catch (err) {
      // 证据不足 → 停在执行中，如实告知；状态已就位 → 忽略
      if (!(err instanceof Error) || !/不允许的迁移/.test(err.message)) {
        this.emit({
          type: "tool",
          badge: "回报",
          title: `证据未通过验证 · ${member} · ${taskId}`,
          body: `已登记 ${evidence.length} 项，其中可验证 ${verified} 项。无已验证证据不能进审查（§4.10.5）。`,
        });
        return `回报已登记；但 ${verified} 项证据可验证（要求 ≥1）：文件不存在或无法复跑，工单停在执行中。`;
      }
    }

    this.emit({
      type: "tool",
      badge: "回报",
      title: `${member} · ${taskId}`,
      body: `${text}\n证据：${evidence.join("、")}\n可验证：${verified}/${evidence.length}`,
    });
    return moved
      ? `回报已登记，${verified} 项证据已验证并收入卷宗，工单进入待审查。`
      : "回报已登记（含证据索引）。";
  }

  /** 没在跑就立刻提交，在跑就进队列（用户确认计划/回答问题时用） */
  private submitTurnIfIdle(text: string): void {
    if (this.busy) {
      this.queue.push({ id: `q-${++this.queueSeq}`, text, at: new Date().toISOString(), mode: "queue" });
      this.setTurn({});
      return;
    }
    this.submitTurn(text);
  }

  /**
   * 权限门禁（唯一入口）：四档语义
   *  - plan：只读工具放行，其余拒绝（连组队都不行）
   *  - ask：写类工具挂起等你批准（最长 2 分钟，超时按拒绝处理）
   *  - auto：放行（默认）
   *  - full：放行（连审批都不弹）
   */
  private async gateTool(name: string, args: Record<string, unknown>): Promise<string | null> {
    if (this.permission === "auto" || this.permission === "full") return null;
    if (READ_ONLY_TOOLS.has(name)) return null;
    if (this.permission === "plan") {
      return `权限档位=计划：${name} 会改动团队或工单，已拒绝。要看进度可以用 check_progress；需要动手请让用户切到「询问」或「自动」。`;
    }
    // ask：挂起等用户批准
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    this.decisions.push({
      id,
      from: "审批",
      title: `允许「${name}」吗？`,
      detail: JSON.stringify(args).slice(0, 300),
      kind: "approval",
      at: new Date().toISOString(),
    });
    this.setTurn({ phase: "awaiting_plan" });
    this.card({ kind: "system", text: `等你批准：${name}（2 分钟内不答复按拒绝处理）`, code: "approval_required" });
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        this.decisions = this.decisions.filter((d) => d.id !== id);
        resolve(false);
      }, 120_000);
      this.pendingApprovals.set(id, {
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          this.pendingApprovals.delete(id);
          resolve(ok);
        },
      });
    });
    this.setTurn({ phase: "working" });
    return approved
      ? null
      : `用户拒绝了这次「${name}」调用。不要重试同一动作，改成向用户说明或换一条路（审批拒绝不算错误轮）。`;
  }

  /** 用户确认任务契约后真正开工：记录派单 + 工单进 in_progress + 起成员 */
  private startAssignment(p: PendingPlan): string {
    this.tools.assignTask(p.teamId, {
      taskId: p.taskId,
      member: p.member,
      brief: p.brief,
      deadline: p.deadline,
      tools: p.tools,
    });
    try {
      this.taskStore.ensureInProgress({
        id: p.taskId,
        title: p.brief.split("\n")[0].slice(0, 40) || p.taskId,
        teamId: p.teamId,
        member: p.member,
      });
    } catch {
      /* 工单状态已就位 */
    }
    this.taskCase.append(p.taskId, {
      kind: "assign",
      member: p.member,
      text: p.brief.slice(0, 200),
      meta: { deadline: p.deadline, tools: p.tools },
    });
    this.taskCase.appendSummary(p.taskId, `派给 ${p.member}（截止 ${p.deadline}）`);
    const kickoff = this.dispatchMember(p.teamId, p.taskId, p.member, p.brief, p.deadline, p.tools);
    this.setTurn({ phase: "working", taskId: p.taskId, busy: this.busy });
    return kickoff;
  }

  /**
   * 派单即开工（M0-09）：按岗位档案 + 简报包起真实成员运行时，后台执行不阻塞风铃的工具轮。
   * 工作区 = <dataRoot>/tasks/<taskId>/workspace/（成员文件活动的硬边界）。
   * 回报完成后走 registerReport 同一管线：登记 → 证据验证 → 进待审查 → 发「回报」卡。
   */
  private dispatchMember(
    teamId: string,
    taskId: string,
    member: string,
    brief: string,
    deadline: string,
    toolsArg?: string[],
  ): string {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) {
      return "模型未配置（或 Key 无法解密）：派单已记录，但成员无法开工。请先在设置里配置模型。";
    }
    let profile;
    try {
      profile = this.teamStore.readMember(teamId, member);
    } catch {
      return `读不到 ${member} 的岗位档案，无法开工（档案文件可能被移动或改名）。`;
    }
    if (this.memberRuns.has(taskId)) {
      return `${taskId} 已有成员在执行中，不重复开工。`;
    }
    // 执行工具 = 本次分配 ∩ 内置执行工具；submit_report 是回报通道，不占白名单
    const allowed = (toolsArg ?? profile.tools).filter((t) =>
      (MEMBER_EXEC_TOOLS as readonly string[]).includes(t),
    );
    const workdir = path.join(this.dataRoot, "tasks", taskId, "workspace");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "_brief.md"),
      `# 简报包（来自风铃）\n\n- 截止：${deadline}\n- 本次分配工具：${allowed.join("、") || "无"}\n\n${brief}\n`,
      "utf-8",
    );

    const run: Promise<MemberRunResult> = runMemberTask({
      profile,
      brief,
      deadline,
      tools: allowed,
      workdir,
      model: { baseUrl: cfg.baseUrl, apiKey, model: cfg.model },
      onAudit: (ev) => this.auditTool(teamId, taskId, member, ev),
      onBeforeWrite: (rel, full, existed) => this.checkpoints.beforeWrite(rel, full, existed),
      onEvent: (ev) => {
        if (ev.kind === "tool") {
          this.emit({
            type: "tool",
            badge: "工具",
            title: `${member} · ${taskId}`,
            meta: "成员工作区",
            body: ev.text,
          });
        }
        if (ev.kind === "turn") {
          const progress = ev.progress ?? 0;
          this.memberProgress.set(member, progress);
          // 只推回合状态（不刷卡片），编制表的进度条据此实时走
          this.setTurn({ phase: "working", taskId, member, progress });
        }
      },
    });
    void run
      .then((result) => {
        this.memberProgress.set(member, 100);
        this.registerReport(teamId, taskId, member, result.report, result.evidence);
        if (result.status !== "reported") {
          this.emit({
            type: "tool",
            badge: "回报",
            title: `${member} 未能完成 · ${taskId}`,
            body: result.error === "turn_limit" ? `轮次上限（${profile.limits?.maxTurns ?? 12}）内未回报。` : result.report,
          });
        }
      })
      .catch((err: unknown) => {
        this.emit({
          type: "tool",
          badge: "回报",
          title: `成员执行崩溃 · ${member} · ${taskId}`,
          body: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.memberRuns.delete(taskId);
      });
    this.memberRuns.set(taskId, run);
    this.emit({
      type: "tool",
      badge: "派单",
      title: `${member} 开工 · ${taskId}`,
      meta: `工具：${allowed.join("、") || "无"}`,
      body: `工作区 tasks/${taskId}/workspace/（成员文件活动限制在此，回报后自动进审查台）`,
    });
    return "成员已开工（后台执行），回报后会自动进待审查。";
  }

  runTool(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case "create_member": {
        this.tools.createMember(
          String(args.teamId),
          {
            name: String(args.name),
            role: String(args.role),
            goal: String(args.goal),
            boundaries: (args.boundaries as string[]) ?? [],
            tools: (args.tools as string[]) ?? [],
            model: "deepseek-chat",
            limits: { maxTurns: 40, budgetTokens: 300000, wallClockMin: 30 },
            outputContract: {
              deliverable: String(args.deliverable ?? "按验收标准交付"),
              evidence: ["改动文件清单/命令输出", "测试或核对结果"],
              acceptance: (args.acceptance as string[]) ?? ["完成标准全部满足"],
            },
            escalateWhen: String(args.escalateWhen ?? "需要新依赖/越权/卡住"),
            body: `岗位由风铃在任务中招募。目标：${args.goal}`,
          },
          args.justification as string | undefined,
        );
        this.emit({
          type: "tool",
          badge: "组队",
          title: `招募 ${args.name} · ${args.role}`,
          body: `目标：${args.goal}\n边界：${((args.boundaries as string[]) ?? []).join("；") || "（未写）"}`,
          members: [{ name: String(args.name), role: String(args.role), color: this.teamColor(0) }],
        });
        return `已招募 ${args.name}（岗位档案已落盘，用户可读可改）。`;
      }
      case "assign_task": {
        const teamId = String(args.teamId);
        const taskId = String(args.taskId);
        const member = String(args.member);
        const brief = String(args.brief);
        const deadline = String(args.deadline);
        const tools = (args.tools as string[] | undefined) ?? undefined;
        const title = brief.split("\n")[0].slice(0, 40) || taskId;
        const plan: TaskPlan = {
          taskId,
          title,
          goal: brief,
          acceptance: (args.acceptance as string[]) ?? ["完成标准全部满足"],
          member,
          tools,
          budgetTokens: 300_000,
          deadline,
        };
        const ctx: PendingPlan = { teamId, taskId, member, brief, deadline, tools };
        // M1-08：团队不在时按编制模板起一支（显式指定优先，否则按标题匹配）
        const reused = this.tools.ensureTeamFromTemplate(teamId, title, args.template as string | undefined);
        if (!this.storeTeamExists(teamId)) {
          return `团队 ${teamId} 不存在，也没有匹配「${title}」的编制模板。先 create_member 招募，或在上一单解散时选「保留编制」。`;
        }
        if (reused) {
          this.card({ kind: "system", text: `复用编制「${reused.name}」（${reused.members} 人），没有重新招人。` });
        }
        // 还没开工：工单只落 todo，不能谎报"执行中"（七态见 §4.10.4）
        if (!this.taskStore.get(taskId)) {
          this.taskStore.create({ id: taskId, title, teamId, member });
          this.taskStore.transition(taskId, "todo");
        }
        if (this.settings.getPrefs().autoStart) {
          return `已按任务契约开工（设置里开启了自动开始）。${this.startAssignment(ctx)}`;
        }
        const decisionId = `plan-${taskId}-${Date.now().toString(36)}`;
        this.pendingPlans.set(decisionId, { ...ctx, decisionId });
        this.decisions.push({
          id: decisionId,
          from: "计划",
          title: `任务契约 · ${title}`,
          detail: brief,
          kind: "plan",
          jobId: taskId,
          at: new Date().toISOString(),
          plan,
          checks: plan.acceptance.map((a) => ({ ok: true, text: a })),
        });
        this.setTurn({ phase: "awaiting_plan", taskId });
        this.emit({
          type: "tool",
          badge: "需要你拍板",
          title: `待你确认 · ${taskId}`,
          meta: `${member} · 截止 ${deadline}`,
          body: `${brief}\n\n验收：${plan.acceptance.join("；")}`,
        });
        return "任务契约已呈给用户，等你确认后才开工。不要重复派单，也不要自己模拟成员执行。";
      }
      case "check_progress": {
        const taskId = String(args.taskId);
        const p = {
          ...this.tools.checkProgress(String(args.teamId), taskId),
          running: this.memberRuns.has(taskId),
        };
        return JSON.stringify(p, null, 2);
      }
      case "check_roster": {
        return JSON.stringify(this.tools.roster(args.teamId ? String(args.teamId) : undefined), null, 2);
      }
      case "review_result": {
        return this.registerReport(
          String(args.teamId),
          String(args.taskId),
          String(args.member),
          String(args.text),
          (args.evidence as string[]) ?? [],
        );
      }
      case "accept_or_reject": {
        const r = this.tools.acceptOrReject(String(args.teamId), String(args.taskId), args.verdict as "accept" | "reject", {
          member: String(args.member),
          rejectReason:
            args.verdict === "reject"
              ? { what: String(args.what ?? ""), expect: String(args.expect ?? ""), deadline: String(args.deadline ?? "") }
              : undefined,
          evidence: args.evidence as string[] | undefined,
        });
        // 打回同步进权威工单：轮次 +1，满 3 轮转 blocked
        if (args.verdict === "reject") {
          try {
            this.taskStore.reject(String(args.taskId), {
              what: String(args.what ?? ""),
              expect: String(args.expect ?? ""),
              deadline: String(args.deadline ?? ""),
              member: String(args.member),
            });
          } catch {
            // 工单不在 in_review（例如旧记录）：只记派单卷宗
          }
        }
        this.emit({
          type: "tool",
          badge: "审查",
          title: `${args.verdict === "accept" ? "验收通过" : "打回"} · ${args.member}`,
          body:
            args.verdict === "accept"
              ? undefined
              : `不合格：${args.what}\n期望：${args.expect}\n时限：${args.deadline}`,
        });
        return r.escalated
          ? "打回轮数已达上限，已自动升级问用户，等待其决定。"
          : args.verdict === "accept"
            ? "验收结论已记录。归档需要用户在印章区点「验收归档」——用户显式拍板才算完成（§4.10.5）。"
            : "已打回，并写清了改什么、期望什么、时限。";
      }
      case "report_to_user": {
        this.tools.reportToUser(String(args.teamId), {
          taskId: String(args.taskId),
          conclusion: String(args.conclusion),
          evidence: (args.evidence as string[]) ?? [],
          unfinished: (args.unfinished as string[]) ?? [],
          decisionsNeeded: (args.decisionsNeeded as string[]) ?? [],
        });
        this.emit({
          type: "tool",
          badge: "汇报",
          title: `${args.taskId} · 汇报`,
          jobId: String(args.taskId),
          report: {
            conclusion: String(args.conclusion),
            evidence: ((args.evidence as string[]) ?? []).join("、"),
            unfinished: ((args.unfinished as string[]) ?? []).join("；"),
            decision: ((args.decisionsNeeded as string[]) ?? []).join("；"),
          },
          body: [
            `结论：${args.conclusion}`,
            ((args.evidence as string[]) ?? []).length ? `证据：${(args.evidence as string[]).join("、")}` : null,
            ((args.unfinished as string[]) ?? []).length ? `未完成：${(args.unfinished as string[]).join("；")}` : null,
            ((args.decisionsNeeded as string[]) ?? []).length
              ? `待你拍板：${(args.decisionsNeeded as string[]).join("；")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        });
        return "汇报已呈给用户。";
      }
      case "ask_user": {
        const q = this.tools.askUser(String(args.question), String(args.context ?? ""));
        this.decisions.push({
          id: q.id,
          from: "升级",
          title: String(args.question).slice(0, 60),
          detail: String(args.context ?? ""),
          kind: "question",
          at: new Date().toISOString(),
        });
        this.emit({
          type: "tool",
          badge: "需要你拍板",
          title: String(args.question).slice(0, 60),
          body: String(args.context ?? ""),
        });
        return `问题已转呈用户（id: ${q.id}），等待回答。在用户回答前不要重复提问。`;
      }
      case "dissolve_team": {
        const r = this.tools.dissolveTeam(String(args.teamId), Boolean(args.keep));
        this.emit({
          type: "tool",
          badge: "工具",
          title: r === "kept" ? `保留编制 · ${args.teamId}` : `已解散 · ${args.teamId}`,
        });
        return r === "kept" ? "编制已保留，下次同类任务可直接调用。" : "团队已解散（档案保留供复盘）。";
      }
      default:
        return `未知工具: ${name}`;
    }
  }

  // ---------- Pi RPC 会话（M0-03：模型循环在子进程，工具与权限留在壳） ----------

  /** 起/复用 RPC worker；模型或工具面变化时重建（子进程崩溃不影响壳） */
  private async ensureHost(): Promise<AgentHost> {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) throw new Error("no-model-config");
    const stamp = `${cfg.baseUrl}@${cfg.model}@${cfg.updatedAt}@${this.l1.fingerprint()}@${this.mcp.fingerprint()}`;
    if (this.host && this.hostStamp === stamp) return this.host;
    await this.resetAgentHost();
    const tools: RpcToolSpec[] = this.allTools().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    const host = new AgentHost({
      entryPath: this.rpcEntryPath,
      model: { baseUrl: cfg.baseUrl, apiKey, model: cfg.model, provider: cfg.provider },
      tools,
      systemPrompt: this.systemPrompt(),
      onToolCall: async (name, args) => {
        try {
          // 三类来源同一道门禁（§4.7）：先过权限，再执行
          const denial = await this.gateTool(name, args);
          if (denial) return denial;
          // 工具面真值在壳：L1 先查，再落到管理型 8 件套（停用残留由执行层拒绝）
          return this.l1.has(name) ? await this.l1.execute(name, args) : this.runTool(name, args);
        } catch (err) {
          return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
      markerDir: path.join(this.dataRoot, "runtime", "workers"),
      // 只有「这次壳里已经有对话记录」才续上次会话：全新安装/新对话不翻出旧档，
      // 也避免测试环境里续到别的用例留下的会话。
      resume:
        !this.createFreshSession &&
        (fs.existsSync(this.timelineFile) || this.threads.loadState(this.currentThreadId).history.length > 0),
      sessionDir: this.threads.piDir(this.currentThreadId),
      onEvent: (ev) => this.onAgentEvent(ev),
      onError: (message) => {
        // 运行时错误必须进对话流：只发事件的话界面会一片空白（用户只看到自己那半句）
        this.card({ kind: "system", text: `运行时错误：${message}` });
        this.emit({ type: "error", message });
      },
    });
    await host.start();
    this.createFreshSession = false;
    this.host = host;
    this.hostStamp = stamp;
    return host;
  }

  /** 退出收尾：停 worker、停 MCP，别把子进程留在后台 */
  async dispose(): Promise<void> {
    if (this.threadSaveTimer) {
      clearTimeout(this.threadSaveTimer);
      this.threadSaveTimer = null;
    }
    this.persistThread();
    await this.resetAgentHost().catch(() => undefined);
    await this.mcp.stopAll().catch(() => undefined);
    this.log("dispose");
  }

  private async resetAgentHost(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.hostStamp = "";
    if (host) await host.stop().catch(() => undefined);
  }

  private onAgentEvent(ev: { type: string; [k: string]: unknown }): void {
    if (ev.type === "text_delta" && typeof ev.text === "string" && this.liveCard) {
      this.liveCard.text = (this.liveCard.text ?? "") + ev.text;
      // 节流到 ~80ms：渲染层按 cardId 就地更新，不拉全量快照
      const now = Date.now();
      if (now - this.lastDeltaEmit >= 80) {
        this.lastDeltaEmit = now;
        this.notify({ type: "delta", text: this.liveCard.text, cardId: this.liveCard.id });
      }
    }
    // 压缩：Pi 内置自动压缩，界面必须给交代（否则"上下文突然变短"像丢数据）
    if (ev.type === "compaction_start") {
      this.card({ kind: "system", text: "上下文接近上限，正在压缩更早的对话…" });
    }
    if (ev.type === "compaction_end") {
      const before = typeof ev.tokensBefore === "number" ? ev.tokensBefore : null;
      const after = typeof ev.tokensAfter === "number" ? ev.tokensAfter : null;
      this.card({
        kind: "system",
        text:
          before !== null && after !== null
            ? `已压缩：${before} → ${after} tokens。原文仍在卷宗，可随时回看。`
            : "上下文已压缩。原文仍在卷宗，可随时回看。",
      });
      this.log("compacted", { before, after });
    }
    // 工具卡由 emit("tool") 统一落 feed，这里不重复
  }

  // ---------- 对话主路径 ----------

  /**
   * 工具执行唯一入口（RPC 回壳与直连降级共用）：
   * 权限门禁 → L1 → 管理型 8 件套；失败转成可读文本，不把异常抛回模型循环。
   */
  /** 完整工具面：管理型 8 件 + L1 插件 + L2 MCP（同一道门禁，只是来源不同） */
  private allTools(): ToolSchema[] {
    return [...TOOL_JSON, ...this.l1.toolSchemas(), ...this.mcp.schemas()];
  }

  /** 工具面里实际有哪些名字（诊断/测试用） */
  toolNames(): string[] {
    return this.allTools().map((t) => t.function.name);
  }

  private storeTeamExists(teamId: string): boolean {
    return this.teamStore.teamExists(teamId);
  }

  private async executeToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const denial = await this.gateTool(name, args);
      if (denial) return denial;
      if (this.mcp.has(name)) return await this.mcp.execute(name, args);
      return this.l1.has(name) ? await this.l1.execute(name, args) : this.runTool(name, args);
    } catch (err) {
      const text = `工具执行失败：${err instanceof Error ? err.message : String(err)}。请调整后重试或如实告知用户。`;
      this.emit({ type: "tool", badge: "工具", title: `${name} 失败`, body: text });
      return text;
    }
  }

  /** 落一轮助手回复（两条路径共用，顺序固定：history → 落盘 → 卡片收尾） */
  private settleAssistant(live: FeedCard, text: string): void {
    if (text.trim()) {
      live.text = text;
      this.history.push({ role: "assistant", content: text });
      this.persist("assistant", text);
    }
    this.patchCard(live, { streaming: false });
  }

  private async runChatRpc(userText: string): Promise<void> {
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    this.liveCard = live;
    const beforeIn = this.usage.sessionIn;
    const beforeOut = this.usage.sessionOut;
    try {
      const host = await this.ensureHost();
      this.setTurn({ phase: "accepted", busy: true });
      const promptResult = await host.request<{ disposition?: string }>("prompt", { text: userText });
      this.log("prompt_ok", { disposition: promptResult?.disposition ?? "started" });
      if (this.abortRequested) {
        this.card({ kind: "system", text: "已停止（已产出的内容保留）。" });
      }
      this.settleAssistant(live, live.text ?? "");
      // 用量以 Pi 的 session stats 为准（含缓存与上下文占比），不自估
      const stats = await host.stats();
      if (stats) {
        this.setUsage({
          sessionIn: stats.tokens.input,
          sessionOut: stats.tokens.output,
          turnIn: Math.max(0, stats.tokens.input - beforeIn),
          turnOut: Math.max(0, stats.tokens.output - beforeOut),
          contextTokens: stats.contextTokens,
          contextWindow: stats.contextWindow,
        });
        // 工单追溯：这一段是哪个 Pi session 跑的
        const taskId = this.turn.taskId;
        if (taskId && stats.sessionId) {
          try {
            this.taskStore.setSessionId(taskId, stats.sessionId);
            this.taskCase.append(taskId, { kind: "session", text: stats.sessionId, meta: { sessionFile: stats.sessionFile } });
          } catch {
            /* 工单还没建立（纯问答） */
          }
        }
      }
      this.settleCheckpoint();
      this.emit({ type: "done", tokens: this.usage.turnOut });
    } finally {
      this.liveCard = null;
      if (live.streaming) this.patchCard(live, { streaming: false });
    }
  }

  /** 直连降级路径：Pi 不可用时仍可用（原实现保留） */
  private async runChatDirect(cfg: NonNullable<ReturnType<SettingsStore["getModel"]>>, apiKey: string): Promise<void> {
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    const patchLive = (text: string, streaming: boolean) => {
      live.text = text;
      live.streaming = streaming;
      const now = Date.now();
      if (streaming && now - this.lastDeltaEmit >= 80) {
        this.lastDeltaEmit = now;
        this.emit({ type: "delta", text });
      }
    };
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt() }, ...this.history];
    try {
      for (let round = 0; round < 8; round++) {
        let roundText = "";
        const result = await streamChat({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages,
          tools: [...TOOL_JSON, ...this.l1.toolSchemas(), ...this.mcp.schemas()],
          onDelta: (t) => {
            roundText += t;
            patchLive(roundText, true);
          },
        });
        this.tokensUsed += result.promptTokens + result.completionTokens;
        this.setUsage({
          turnIn: result.promptTokens,
          turnOut: result.completionTokens,
          sessionIn: this.usage.sessionIn + result.promptTokens,
          sessionOut: this.usage.sessionOut + result.completionTokens,
          contextTokens: this.usage.contextTokens + result.promptTokens + result.completionTokens,
        });
        if (result.toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: result.content || null,
            tool_calls: result.toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          });
          if (result.content) patchLive(result.content, false);
          for (const tc of result.toolCalls) {
            const args = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
            const outcome = await this.executeToolCall(tc.name, args);
            messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
          }
          patchLive(result.content || "", false);
          continue;
        }
        this.settleAssistant(live, result.content);
        this.settleCheckpoint();
        this.emit({ type: "done", tokens: result.promptTokens + result.completionTokens });
        return;
      }
      patchLive((live.text || "") + "\n\n（工具轮次达到上限，先停在这里。）", false);
      this.emit({ type: "done", tokens: 0 });
    } catch (err) {
      const fail = this.classifyError(err);
      if (!live.text) live.text = fail.message;
      this.patchCard(live, { streaming: false, code: fail.code });
      this.failTurn(fail.code, fail.message, fail.action);
    }
  }

  /** 提交一轮：卡片 + 落史 + 回合状态 + 结束后排水（排队输入） */
  private submitTurn(text: string, att?: TurnAttachments): void {
    // 本轮随附（M1-16）：文件注入 + 图片落盘；带不上的如实出卡，不静默丢
    let fullText = text;
    if (att && (att.files?.length || att.images?.length)) {
      const built = buildTurnAttachments(this.projectRoot, this.dataRoot, text, att);
      if (built.errors.length) {
        this.card({ kind: "system", text: `这些随附没带上：${built.errors.join("；")}。` });
      }
      fullText = built.fullText;
      this.card({
        kind: "user",
        text,
        meta: built.pieces.length ? `随附 ${built.pieces.map((p) => p.label).join("、")}` : undefined,
      });
    } else {
      this.card({ kind: "user", text });
    }
    this.history.push({ role: "user", content: fullText });
    this.persist("user", fullText);
    this.busy = true;
    this.l1.setBusy(true);
    this.abortRequested = false;
    this.log("turn_start", { chars: text.length, model: this.settings.getModel()?.model ?? "", threadId: this.currentThreadId });
    this.threads.autoTitle(this.currentThreadId, text);
    this.checkpoints.begin(`turn-${Date.now()}`);
    this.setTurn({ phase: "accepted", busy: true, startedAt: new Date().toISOString(), canUndo: false, changedFiles: [] });
    void this.runChat(fullText).finally(() => {
      this.busy = false;
      this.l1.setBusy(false);
      const phase: TurnPhase = this.turn.phase === "failed" ? "failed" : "idle";
      this.setTurn({ phase, busy: false, startedAt: undefined });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) {
      this.setTurn({ pending: 0 });
      return;
    }
    this.setTurn({ pending: this.queue.length, phase: "accepted" });
    this.submitTurn(next.text, next.attachments);
  }

  /** 插话：只对当前回合生效，不另起回合 */
  private async steerTurn(text: string): Promise<void> {
    if (!this.host?.isRunning()) {
      this.card({ kind: "system", text: "插话没送出去：运行时未在跑，已改为排队。", action: "retry" });
      this.queue.push({ id: `q-${++this.queueSeq}`, text, at: new Date().toISOString(), mode: "queue" });
      this.setTurn({});
      return;
    }
    try {
      await this.host.request("prompt", { text, streamingBehavior: "steer" });
      this.setTurn({ phase: "working" });
    } catch (err) {
      this.card({
        kind: "system",
        text: `这句插话只能在运行时进行中发出：${err instanceof Error ? err.message : String(err)}`,
        code: "steer_failed",
        action: "retry",
      });
    }
  }

  /** 错误分类：前端按 code 给动作，不拼后端英文原文 */
  private classifyError(err: unknown): { code: string; message: string; action: FeedCard["action"] } {
    const raw = err instanceof Error ? err.message : String(err);
    if (/401|unauthorized|invalid.*(api.?key|token)|incorrect api key/i.test(raw))
      return { code: "auth_401", message: "API Key 被端点拒绝（401）。", action: "settings" };
    if (/429|rate.?limit|too many requests|quota|insufficient/i.test(raw))
      return { code: "rate_429", message: "端点限流或额度不足（429）。", action: "retry" };
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket hang up|EAI_AGAIN/i.test(raw))
      return { code: "network", message: "连不上你配置的模型端点。", action: "retry" };
    if (/未响应|timed? ?out|超时/i.test(raw))
      return { code: "timeout", message: "运行时超时未响应（已保留已产出内容）。", action: "retry" };
    if (/\b5\d\d\b/.test(raw)) return { code: "endpoint_5xx", message: "端点返回服务端错误（5xx）。", action: "retry" };
    if (/子进程|worker|RPC worker/i.test(raw))
      return { code: "worker_crashed", message: "运行时进程异常退出。", action: "reload" };
    return { code: "unknown", message: raw || "未知错误", action: "logs" };
  }

  private failTurn(code: string, message: string, action: FeedCard["action"]): void {
    this.log("turn_failed", { code, message });
    this.setTurn({ phase: "failed" });
    this.card({ kind: "system", text: message, code, action });
    if (this.liveCard) {
      this.liveCard.streaming = false;
      this.liveCard = null;
    }
    this.emit({ type: "error", code, message, action });
  }

  private async runChat(userText: string): Promise<void> {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) {
      this.failTurn(
        "no_model",
        "还没有可用的模型配置。点「我的风铃 → 模型」填 Base URL / 模型 / API Key。",
        "settings",
      );
      return;
    }
    try {
      if (this.piReady) {
        try {
          await this.runChatRpc(userText);
        } catch (err) {
          if (this.abortRequested) return; // 用户点了停止：不要再降级重跑
          // 运行时不可用：明确告知已降级（不静默），本轮仍能答完
          const fail = this.classifyError(err);
          this.card({
            kind: "system",
            text: `${fail.message}本轮已切到直连模式（会少一些工具能力）。`,
            code: fail.code,
            action: "reload",
          });
          await this.runChatDirect(cfg, apiKey);
        }
      } else {
        await this.runChatDirect(cfg, apiKey);
      }
    } catch (err) {
      const fail = this.classifyError(err);
      this.failTurn(fail.code, fail.message, fail.action);
    }
  }

  // ---------- 会话持久化（§4.8 冷层） ----------

  private get timelineFile(): string {
    return path.join(this.dataRoot, "session", "timeline.jsonl");
  }

  private loadSession(): void {
    // 温层优先：摘要 + 最近 N 轮（避免重开线程把陈年对话灌进窗口）
    const warm = this.contextStore.read();
    if (warm.recent.length > 0 || warm.summary) {
      for (const m of this.contextStore.asMessages(10)) {
        this.history.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
        if (m.role === "user" && !m.content.startsWith("（更早的对话已压缩成摘要")) {
          this.card({ kind: "user", text: m.content });
        } else if (m.role === "assistant") {
          this.card({ kind: "lynn", text: m.content });
        }
      }
      return;
    }
    // 冷层兜底：旧会话只有 timeline.jsonl
    const f = this.timelineFile;
    if (!fs.existsSync(f)) return;
    const lines = fs.readFileSync(f, "utf-8").split("\n").filter((x) => x.trim());
    for (const line of lines.slice(-200)) {
      try {
        const rec = JSON.parse(line) as { role: string; content: string };
        if (rec.role === "user") {
          this.history.push({ role: "user", content: rec.content });
          this.card({ kind: "user", text: rec.content });
        } else if (rec.role === "assistant" && rec.content) {
          this.history.push({ role: "assistant", content: rec.content });
          this.card({ kind: "lynn", text: rec.content });
        }
      } catch {
        // 坏行跳过
      }
    }
  }

  private persist(role: "user" | "assistant", content: string): void {
    // 冷层：原文只追加、永不改写
    fs.appendFileSync(this.timelineFile, JSON.stringify({ role, content, at: new Date().toISOString() }) + "\n", "utf-8");
    // 温层：最近 N 轮 + 摘要；超阈值压缩，冷层原文不动
    this.contextStore.append(role, content);
    const c = this.contextStore.maybeCompact();
    if (c.compacted) {
      this.card({ kind: "system", text: `更早的对话已压缩成摘要（保留最近 ${c.total} 轮）；原文仍在卷宗里。` });
    }
  }

  // ---------- 指挥板（真实存储推导） ----------

  private listTeams(): BoardData["teams"] {
    const dir = path.join(this.dataRoot, "team");
    if (!fs.existsSync(dir)) return [];
    const teams: BoardData["teams"] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const tf = path.join(dir, entry.name, "team.json");
      if (!fs.existsSync(tf)) continue;
      const rec = JSON.parse(fs.readFileSync(tf, "utf-8")) as { id: string; name: string; status: string };
      const members = this.teamStore
        .listMembers(entry.name)
        .map((p, i) => ({
          name: p.name,
          role: p.role,
          goal: p.goal,
          status: "idle" as const,
          statusNote: p.goal,
          progress: this.memberProgress.get(p.name) ?? 0,
          budgetUsed: 0,
          budgetTotal: Math.round(p.limits.budgetTokens / 1000),
          rejections: 0,
          rejectionLimit: 3,
          toolWhitelist: p.tools,
          color: this.teamColor(i),
          model: p.model,
          turnLimit: p.limits.maxTurns,
        }));
      teams.push({
        id: rec.id,
        name: rec.name,
        status: rec.status as "active" | "paused" | "dissolved",
        members,
      });
    }
    return teams;
  }

  private buildTrack(): BoardData["track"] {
    const dir = path.join(this.dataRoot, "team");
    const track: BoardData["track"] = [];
    if (!fs.existsSync(dir)) return track;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const adir = path.join(dir, entry.name, "assignments");
      if (!fs.existsSync(adir)) continue;
      for (const f of fs.readdirSync(adir)) {
        if (!f.endsWith(".jsonl")) continue;
        const taskId = f.replace(/\.jsonl$/, "");
        const recs = this.teamStore.readAssignments(entry.name, taskId);
        if (!recs.length) continue;
        const last = recs[recs.length - 1];
        const task = this.taskStore.get(taskId);
        if (task) {
          // 有权威工单记录就以它为准（status / version / parent / evidence）
          const lastReject = [...task.approvals].reverse().find((a) => a.action === "reject");
          let rejectDraft: BoardData["track"][number]["rejectDraft"];
          if (lastReject?.note) {
            try {
              const r = JSON.parse(lastReject.note) as { what?: string; expect?: string; deadline?: string };
              rejectDraft = { what: r.what ?? "", expect: r.expect ?? "", deadline: r.deadline ?? "" };
            } catch {
              rejectDraft = undefined;
            }
          }
          track.push({
            id: task.id,
            teamId: task.teamId,
            title: task.title,
            status: task.status,
            statusNote: `${task.status} · ${task.member ?? "风铃"} · 证据 ${task.evidence.length}`,
            member: task.member ?? last.member,
            at: task.updatedAt,
            evidenceCount: task.evidence.length,
            version: task.version,
            parentId: task.parentId ?? undefined,
            rejectRounds: task.rejectRounds,
            evidence: task.evidence.map((e) => ({ label: e.label, ref: e.ref ?? "", verified: e.verified, at: e.at })),
            rejectDraft,
          });
          continue;
        }
        // 旧记录（无权威工单）：按最后一条记录派生，等任务卷宗迁移后消失
        const status =
          last.kind === "accept"
            ? "done"
            : last.kind === "escalate"
              ? "blocked"
              : last.kind === "report"
                ? "in_review"
                : "in_progress";
        const evidenceCount = recs.reduce((n, r) => n + (r.evidence?.length ?? 0), 0);
        const firstAssign = recs.find((r) => r.kind === "assign");
        track.push({
          id: taskId,
          teamId: entry.name,
          title: this.taskTitle(taskId, firstAssign?.text),
          status,
          statusNote: `${last.kind} · ${last.member ?? "风铃"} · ${last.text.slice(0, 30)}`,
          member: last.member,
          at: last.at,
          evidenceCount,
        });
      }
    }
    return track.reverse();
  }

  /** 工单标题：优先用派单简报首行，退化到工单号（不编造） */
  private taskTitle(taskId: string, briefJson?: string): string {
    if (!briefJson) return taskId;
    try {
      const parsed = JSON.parse(briefJson) as { brief?: string };
      const first = (parsed.brief ?? "").split("\n")[0]?.trim();
      return first ? first.slice(0, 40) : taskId;
    } catch {
      return taskId;
    }
  }

  private buildBoard(): BoardData {
    return {
      teams: this.listTeams(),
      track: this.buildTrack(),
      decisions: this.decisions.map((d) => ({ ...d })),
      tokensUsed: this.tokensUsed,
    };
  }

  snapshotBoard(): BoardData {
    return this.buildBoard();
  }

  // ---------- RPC 入口 ----------

  /** 供壳层调用：隔离试装（异步，不进同步 RPC switch） */
  probePlugin(id: string): Promise<{ ok: boolean; detail: string }> {
    return this.pluginHost.probe(id);
  }

  /** 启动时记一次并判安全模式（10 分钟内 3 次启动 → 只跑官方核心） */
  noteKernelStart(): { safeMode: boolean; starts: number; fingerprint: string } {
    const r = this.pluginSet.noteStart();
    return { ...r, fingerprint: this.pluginSet.fingerprint().fingerprint };
  }

  handle<M extends RpcMethod>(method: M, params: unknown): RpcContracts[M]["result"] {
    switch (method) {
      case "session.snapshot": {
        const cfg = this.settings.getModel();
        const snap: RpcContracts["session.snapshot"]["result"] = {
          workspace: { project: path.basename(this.projectRoot), subdir: "指挥台" },
          thread: {
            id: this.currentThreadId,
            title: this.threads.get(this.currentThreadId)?.title ?? "新会话",
          },
          threads: this.threads.list().map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })),
          project: {
            root: this.projectRoot,
            trusted: this.trust.isTrusted(this.projectRoot),
            hasMcp: fs.existsSync(path.join(this.projectRoot, ".lynn", "mcp.json")),
          },
          permission: this.permission,
          model: {
            configured: !!cfg,
            provider: cfg?.provider ?? "",
            baseUrl: cfg?.baseUrl ?? "",
            model: cfg?.model ?? "",
            apiKeySet: !!cfg?.apiKey?.data,
          },
          feed: [...this.feed],
          board: this.buildBoard(),
          turn: { ...this.turn, pending: this.queue.length },
          usage: { ...this.usage },
          queue: this.queue.map((q) => ({ id: q.id, text: q.text, at: q.at })),
          prefs: this.settings.getPrefs(),
        };
        return snap as RpcContracts[M]["result"];
      }

      case "permission.set": {
        const { mode } = params as { mode: PermissionMode };
        this.permission = mode;
        // 切到 auto/full：把已经挂起的审批全部放行；切回 plan/ask：按拒绝处理
        const allow = mode === "auto" || mode === "full";
        for (const [id, pending] of this.pendingApprovals) {
          this.decisions = this.decisions.filter((d) => d.id !== id);
          pending.resolve(allow);
        }
        return { ok: true, mode } as RpcContracts[M]["result"];
      }

      case "feed.send": {
        const { text, mode = "queue", attachments } = params as {
          text: string;
          mode?: "steer" | "queue";
          attachments?: TurnAttachments;
        };
        const trimmed = text.trim();
        if (!trimmed) return { ok: true, queued: false } as RpcContracts[M]["result"];
        const hasAtt = Boolean(attachments && (attachments.files?.length || attachments.images?.length));
        if (this.busy) {
          if (mode === "steer") {
            let steerText = trimmed;
            let meta = "插话";
            if (hasAtt) {
              const built = buildTurnAttachments(this.projectRoot, this.dataRoot, trimmed, attachments!);
              if (built.errors.length) {
                this.card({ kind: "system", text: `这些随附没带上：${built.errors.join("；")}。` });
              }
              steerText = built.fullText;
              if (built.pieces.length) meta = `插话 · 随附 ${built.pieces.map((p) => p.label).join("、")}`;
            }
            this.card({ kind: "user", text: trimmed, meta });
            this.history.push({ role: "user", content: steerText });
            this.persist("user", steerText);
            void this.steerTurn(steerText);
            return { ok: true, queued: false } as RpcContracts[M]["result"];
          }
          const item: QueuedInput = {
            id: `q-${++this.queueSeq}`,
            text: trimmed,
            at: new Date().toISOString(),
            mode: "queue",
            ...(hasAtt ? { attachments } : {}),
          };
          this.queue.push(item);
          this.setTurn({});
          return { ok: true, queued: true, queueId: item.id } as RpcContracts[M]["result"];
        }
        this.submitTurn(trimmed, attachments);
        return { ok: true, queued: false } as RpcContracts[M]["result"];
      }

      case "files.search": {
        const { q = "", limit = 20 } = params as { q?: string; limit?: number };
        return { files: searchProjectFiles(this.projectRoot, q, limit) } as RpcContracts[M]["result"];
      }

      case "persona.get": {
        return { text: this.persona.load() } as RpcContracts[M]["result"];
      }

      case "persona.save": {
        const { text } = params as { text: string };
        const versionId = this.persona.save(text);
        // 立即生效：直连路径每轮现取；Pi worker 热更新（handle 是同步的，fire-and-forget，失败落卡）
        const hot = this.hotSyncSystemPrompt();
        this.log("persona_save", { chars: text.length, versionId, hot });
        return { ok: true, versionId, hot } as RpcContracts[M]["result"];
      }

      case "persona.versions": {
        return { versions: this.persona.versions() } as RpcContracts[M]["result"];
      }

      case "persona.rollback": {
        const { id } = params as { id: string };
        const text = this.persona.rollback(id);
        const hot = this.hotSyncSystemPrompt();
        return { ok: true, text, hot } as RpcContracts[M]["result"];
      }

      case "memory.get": {
        const { kind } = params as { kind: MemoryKind };
        this.assertMemoryKind(kind);
        return { text: this.memory.load(kind) } as RpcContracts[M]["result"];
      }

      case "memory.save": {
        const { kind, text } = params as { kind: MemoryKind; text: string };
        this.assertMemoryKind(kind);
        const versionId = this.memory.save(kind, text);
        const hot = this.hotSyncSystemPrompt();
        this.log("memory_save", { kind, chars: text.length, versionId, hot });
        return { ok: true, versionId, hot } as RpcContracts[M]["result"];
      }

      case "memory.versions": {
        const { kind } = params as { kind: MemoryKind };
        this.assertMemoryKind(kind);
        return { versions: this.memory.versions(kind) } as RpcContracts[M]["result"];
      }

      case "memory.diff": {
        const { kind, versionId } = params as { kind: MemoryKind; versionId?: string };
        this.assertMemoryKind(kind);
        const { changes } = this.memory.diff(kind, versionId);
        return { changes } as RpcContracts[M]["result"];
      }

      case "memory.rollback": {
        const { kind, versionId } = params as { kind: MemoryKind; versionId: string };
        this.assertMemoryKind(kind);
        const text = this.memory.rollback(kind, versionId);
        const hot = this.hotSyncSystemPrompt();
        return { ok: true, text, hot } as RpcContracts[M]["result"];
      }

      case "session.abort": {
        this.abortRequested = true;
        this.queue = [];
        this.setTurn({ pending: 0 });
        const aborted = Boolean(this.host?.isRunning());
        if (aborted) {
          // 不等 RPC 回执：停止要立刻可见；失败由看门狗对账兜住
          void this.host!.request("abort").catch(() => undefined);
        }
        if (this.liveCard) {
          this.liveCard.streaming = false;
          this.patchCard(this.liveCard, { streaming: false });
          this.liveCard = null;
        }
        this.card({ kind: "system", text: aborted ? "已停止本轮（已产出的内容保留）。" : "已清空排队；当前没有可停的运行。" });
        this.emit({ type: "done", tokens: this.usage.turnOut });
        return { ok: true, aborted } as RpcContracts[M]["result"];
      }

      case "session.reload": {
        void this.resetAgentHost();
        this.card({ kind: "system", text: "运行时已重建。下一条消息会重新起进程（会话从磁盘恢复）。" });
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "session.queue": {
        const p = params as { action: "list" | "clear" | "remove"; id?: string };
        if (p.action === "clear") this.queue = [];
        if (p.action === "remove" && p.id) this.queue = this.queue.filter((q) => q.id !== p.id);
        this.setTurn({});
        return {
          items: this.queue.map((q) => ({ id: q.id, text: q.text, at: q.at })),
        } as RpcContracts[M]["result"];
      }

      case "decision.resolve": {
        const { id, action, text } = params as {
          id: string;
          action: "answer" | "start" | "revise" | "reject";
          text?: string;
        };
        const d = this.decisions.find((x) => x.id === id);
        if (!d) return { ok: false, error: "这个问题已经处理过了" } as RpcContracts[M]["result"];
        this.decisions = this.decisions.filter((x) => x.id !== id);

        if (d.kind === "approval") {
          const pending = this.pendingApprovals.get(id);
          if (!pending) return { ok: false, error: "这次审批已超时或已处理" } as RpcContracts[M]["result"];
          this.pendingApprovals.delete(id);
          pending.resolve(action === "start");
          this.setTurn({ phase: "working" });
          this.card({ kind: "system", text: action === "start" ? "已批准。" : "已拒绝。" });
          return { ok: true } as RpcContracts[M]["result"];
        }

        if (d.kind === "plan") {
          const plan = this.pendingPlans.get(id);
          this.pendingPlans.delete(id);
          if (action === "start" && plan) {
            const r = this.startAssignment(plan);
            this.card({ kind: "system", text: `计划已确认。${r}` });
            return { ok: true } as RpcContracts[M]["result"];
          }
          if (action === "reject" && plan) {
            try {
              this.taskStore.transition(plan.taskId, "canceled");
            } catch {
              /* 状态已不在可取消区间 */
            }
            this.card({ kind: "system", text: "这件活先不做了，工单已取消。" });
            this.setTurn({ phase: "idle" });
            return { ok: true } as RpcContracts[M]["result"];
          }
          // revise：把用户的修改意见当作新一回合的输入
          const revise = (text ?? "").trim() || "按你的判断改一版";
          this.submitTurnIfIdle(`计划的修改意见：${revise}。请给出新的任务契约，不要直接开工。`);
          return { ok: true } as RpcContracts[M]["result"];
        }

        if (action === "reject") {
          this.card({ kind: "system", text: "已略过这个问题。" });
          return { ok: true } as RpcContracts[M]["result"];
        }
        const answer = (text ?? "").trim();
        if (!answer) return { ok: false, error: "回答不能为空" } as RpcContracts[M]["result"];
        // 关键：回答要回到模型，而不是只写一句"我继续推进"
        this.submitTurnIfIdle(`用户对你刚才的问题「${d.title}」的回答：${answer}`);
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "task.decide": {
        const p = params as {
          taskId: string;
          action: "approve" | "reject";
          reason?: { what: string; expect: string; deadline: string };
        };
        try {
          if (p.action === "approve") {
            this.taskStore.approve(p.taskId, "user", "印章区验收");
            const rec = this.taskStore.transition(p.taskId, "done");
            this.taskCase.append(p.taskId, { kind: "approve", member: "user", text: "验收归档" });
            this.taskCase.appendSummary(p.taskId, "用户拍板：验收归档");
            this.setTurn({ phase: "done", taskId: p.taskId });
            this.card({
              kind: "system",
              text: `已归档 · ${p.taskId}。卷宗：~/.lynn/tasks/${p.taskId}/（timeline.jsonl / artifacts / summary.md）`,
            });
            return { ok: true, status: rec.status } as RpcContracts[M]["result"];
          }
          if (!p.reason) {
            return { ok: false, error: "打回必须写清：哪里不合格 / 期望是什么 / 多久内重交" } as RpcContracts[M]["result"];
          }
          const r = this.taskStore.reject(p.taskId, p.reason);
          this.taskCase.append(p.taskId, {
            kind: "reject",
            member: "user",
            text: `${p.reason.what} → 期望 ${p.reason.expect} / ${p.reason.deadline}`,
          });
          this.taskCase.appendSummary(
            p.taskId,
            `用户打回（第 ${r.record.rejectRounds} 轮）：${p.reason.what}`,
          );
          this.setTurn({ phase: r.escalated ? "review" : "working", taskId: p.taskId });
          if (r.escalated) {
            // 满 3 轮：转 blocked 并升级问用户（决策必须能回答，见 decision.resolve）
            const id = `esc-${p.taskId}-${Date.now().toString(36)}`;
            this.decisions.push({
              id,
              from: "升级",
              title: `${p.taskId} 已打回 ${r.record.rejectRounds} 轮，怎么办？`,
              detail: "继续加一轮、换个人做、还是你自己接手？",
              kind: "question",
              jobId: p.taskId,
              at: new Date().toISOString(),
            });
          }
          return { ok: true, status: r.record.status, escalated: r.escalated } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "plugins.list": {
        const r = this.pluginHost.scan();
        return { plugins: r.plugins, errors: r.errors } as RpcContracts[M]["result"];
      }

      case "plugins.toggle": {
        const p = params as { id: string; enabled: boolean };
        // 变更前先快照，崩了能一键回到上一套插件集
        this.pluginSet.snapshot("toggle");
        this.pluginHost.setEnabled(p.id, p.enabled);
        // L1 两级语义（§4.2.3）：停用=反注册（即时、无残留）；启用=/reload（运行中排队到 settled）
        const mf = this.pluginHost.manifestOf(p.id);
        if (mf?.manifest.tier === "L1") {
          if (!p.enabled) {
            this.l1.deactivate(p.id);
          } else if (!this.pluginSet.isSafeMode()) {
            void this.l1
              .requestReload(p.id)
              .then((msg) =>
                this.emit({ type: "tool", badge: "工具", title: `L1 插件 · ${p.id}`, body: msg }),
              );
            void this.resetAgentHost(); // 下一轮对话重建 worker，带上新工具面
          }
        }
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "plugins.status": {
        const fp = this.pluginSet.fingerprint();
        const info = this.pluginSet.safeModeInfo();
        return {
          fingerprint: fp.fingerprint,
          count: fp.entries.length,
          safeMode: this.pluginSet.isSafeMode(),
          safeModeReason: info?.reason,
          snapshots: this.pluginSet.listSnapshots().slice(0, 5),
        } as RpcContracts[M]["result"];
      }

      case "plugins.rollback": {
        const p = params as { file?: string };
        return this.pluginSet.rollback(p.file) as RpcContracts[M]["result"];
      }

      case "ui.plugins": {
        const r = scanUiPlugins(this.dataRoot);
        return {
          plugins: r.plugins.map((p) => ({ ...p.manifest, html: p.html })),
          errors: r.errors,
        } as RpcContracts[M]["result"];
      }

      case "config.get": {
        const cfg = this.settings.getModel();
        return {
          configured: !!cfg,
          provider: cfg?.provider ?? "",
          baseUrl: cfg?.baseUrl ?? "",
          model: cfg?.model ?? "",
          apiKeySet: !!cfg?.apiKey?.data,
        } as RpcContracts[M]["result"];
      }

      case "config.save": {
        const p = params as { provider: string; baseUrl: string; model: string; apiKey?: string };
        this.settings.saveModel({
          provider: p.provider,
          baseUrl: p.baseUrl,
          model: p.model,
          apiKey: p.apiKey,
          previous: this.settings.getModel(),
        });
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "config.test": {
        const p = params as { baseUrl: string; apiKey: string; model: string };
        // 输入框留空 = 用已保存的 Key 测（渲染层拿不到明文，由主进程解密）
        let apiKey = p.apiKey?.trim() ?? "";
        if (!apiKey) {
          const stored = this.settings.getModel();
          if (!stored) {
            return { ok: false, error: "还没有保存过 Key，先填一个再测。" } as RpcContracts[M]["result"];
          }
          apiKey =
            loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8"))) ?? "";
        }
        if (!apiKey) return { ok: false, error: "Key 无法解密，请重新填一次。" } as RpcContracts[M]["result"];
        return probeEndpoint({ ...p, apiKey }) as unknown as RpcContracts[M]["result"];
      }

      case "config.prefs": {
        const p = params as { autoStart: boolean; trayOnClose?: boolean; notify?: boolean };
        const saved = this.settings.savePrefs({
          autoStart: Boolean(p.autoStart),
          ...(p.trayOnClose !== undefined ? { trayOnClose: Boolean(p.trayOnClose) } : {}),
          ...(p.notify !== undefined ? { notify: Boolean(p.notify) } : {}),
        });
        return {
          ok: true,
          autoStart: saved.autoStart,
          trayOnClose: saved.trayOnClose,
          notify: saved.notify,
        } as RpcContracts[M]["result"];
      }

      case "config.clearKey": {
        return { ok: this.settings.clearApiKey() } as RpcContracts[M]["result"];
      }

      case "trust.set": {
        const { trusted } = params as { trusted: boolean };
        this.trust.setTrusted(this.projectRoot, Boolean(trusted));
        // 重新连 MCP 是异步的：先回执，再在后台完成并落一张卡
        void this.reloadMcp().then(() =>
          this.card({
            kind: "system",
            text: trusted ? "已信任当前项目，项目级 MCP 已按配置加载。" : "已取消信任，项目级 MCP 不再加载。",
          }),
        );
        this.log("trust_set", { root: this.projectRoot, trusted: Boolean(trusted) });
        return { ok: true, trusted: Boolean(trusted), root: this.projectRoot, reloading: true } as RpcContracts[M]["result"];
      }

      case "session.undo": {
        const r = this.checkpoints.undo();
        if (!r.restored.length && !r.removed.length) {
          return { ok: false, error: "没有可撤销的文件改动" } as RpcContracts[M]["result"];
        }
        this.setTurn({ canUndo: false, changedFiles: [] });
        this.card({
          kind: "system",
          text: `已撤销上一轮文件改动：还原 ${r.restored.length} 个、删除新建 ${r.removed.length} 个。`,
        });
        this.log("undo", { restored: r.restored.length, removed: r.removed.length });
        return { ok: true, restored: r.restored.length, removed: r.removed.length } as RpcContracts[M]["result"];
      }

      case "thread.list": {
        return (this.threads.list().map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })) ??
          []) as RpcContracts[M]["result"];
      }

      case "thread.new": {
        const p = params as { title?: string };
        this.persistThread();
        const meta = this.threads.create(p?.title);
        this.switchThread(meta.id);
        return { ok: true, thread: { id: meta.id, title: meta.title } } as RpcContracts[M]["result"];
      }

      case "thread.switch": {
        const p = params as { id: string };
        this.switchThread(p.id);
        return { ok: true, thread: { id: p.id, title: this.threads.get(p.id)?.title ?? "" } } as RpcContracts[M]["result"];
      }

      case "thread.rename": {
        const p = params as { id: string; title: string };
        const t = this.threads.rename(p.id, p.title);
        return { ok: true, title: t.title } as RpcContracts[M]["result"];
      }

      case "thread.remove": {
        const p = params as { id: string };
        if (p.id === this.currentThreadId) {
          const meta = this.threads.create("新会话");
          this.switchThread(meta.id);
        }
        this.threads.remove(p.id);
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "thread.search": {
        const p = params as { q: string };
        return { results: this.threads.search(p.q) } as RpcContracts[M]["result"];
      }

      case "session.new": {
        // 新对话 = 新线程：旧会话留在磁盘上可切回，不再清空历史
        this.persistThread();
        const meta = this.threads.create("新会话");
        this.switchThread(meta.id);
        this.tokensUsed = 0;
        this.usage = { turnIn: 0, turnOut: 0, sessionIn: 0, sessionOut: 0, contextTokens: 0, contextWindow: this.usage.contextWindow };
        try {
          fs.rmSync(this.timelineFile, { force: true });
          this.contextStore.clear();
        } catch {
          // 忽略
        }
        this.card({ kind: "system", text: "新会话已开始。上一段对话留在「会话」列表里，随时能切回。" });
        return { ok: true, threadId: meta.id } as RpcContracts[M]["result"];
      }

      default:
        throw new Error(`unknown rpc method: ${method as string}`);
    }
  }
}
