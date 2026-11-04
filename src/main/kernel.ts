import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BoardData,
  Decision,
  FeedCard,
  KernelEvent,
  MemberStatus,
  PermissionMode,
  QueueItem,
  RpcContracts,
  RpcMethod,
  TaskPlan,
  TaskStatus,
  TurnPhase,
  TurnState,
  UsageView,
} from "../shared/contract";
import { ManagementTools, MANAGEMENT_ONLY_TOOLS } from "./management-tools";
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
import { PRESETS, loadProviders, saveProviders, type ProviderEntry } from "./providers";
import { CalendarStore, dueReminders, parseNaturalDate } from "./calendar";
import { SchedulerStore, recover as recoverScheduler, type DueItem } from "./scheduler";
import { KnowledgeStore, watchKnowledge } from "./knowledge";
import { appendUsage, evaluateBudget, pickModel } from "./budget";
import { groupOf } from "../shared/task-groups";
import {
  buildInjection,
  discoverSkills,
  matchSkills,
  isToolAllowed,
  type SkillEntry,
} from "./skills";
import { probeSoffice, readTable, writeTable, type EngineHealth } from "./office";
import { BrowserController, sensitiveUrl } from "./browser";
import { COMPLIANCE_NOTE, loadMessaging, type ChannelConfig } from "./messaging";
import { TeamStore, effectiveToolsOf, generateTeamId } from "./team-store";
import {
  createDraft,
  listDrafts,
  reviewDraft,
  promoteDraft,
  discardDraft,
  draftsDir,
  type WorkshopKind,
} from "./workshop";
import { isLang, mergeStrings } from "../shared/i18n";
import { BUILTIN_STRINGS } from "../shared/i18n-strings";
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

const TEAM_HINT = "团队 ID。**省略即可**：系统会绑定当前团队，没有就自动新建一个（ID 由系统生成，不要问用户要）";

/** 流式 delta 的发送去抖：一帧一次。渲染层再按 rAF 合帧，两处都不许降到"肉眼看得出卡"的档位 */
const DELTA_FRAME_MS = 16;

/**
 * 默认同时最多几个成员在跑：三个任务并行是常态（ABC 各一个团队），
 * 2 会把第三张单直接拒掉。可用 settings.prefs.maxParallelMembers 覆盖（上限 8）。
 */
const DEFAULT_MAX_PARALLEL_MEMBERS = 4;
/** 成员多久没有任何动作就标"可能卡住"（蓝本 tether-ai 是 120s） */
const MEMBER_STALL_MS = 120_000;

const TOOL_JSON: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "create_team",
      description:
        "建一个团队（不需要先有团队）。只需给一个人类可读的名字，团队 ID 由系统生成并返回给你——绝不要向用户索要 ID。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "团队名（人类可读，例如「超星学霸」）；省略则用系统默认名" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_member",
      description:
        "招募团队成员（书面岗位）：名字、岗位、单一目标、边界（不许做什么）、工具白名单、产出契约与验收标准。**团队最小 1 人**：一张单一个人做得完就只招 1 人，不要为凑角色多招（每个人都在烧预算/时限）。**一条任务线一支团队**：不要把人招进上一条任务的团队；沿用旧班底要显式传 teamId。超过 6 人编制需要 justification。团队不存在会自动新建。",
      parameters: {
        type: "object",
        required: ["name", "role", "goal", "tools"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          teamName: { type: "string", description: "需要自动建队时用的团队名（可选）" },
          name: { type: "string" },
          role: { type: "string" },
          goal: { type: "string", description: "单一目标，行为收敛的关键" },
          boundaries: { type: "array", items: { type: "string" } },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "执行类工具白名单，只能填这些真实工具名：read_file / write_file / list_dir / run_command / browser_navigate / browser_snapshot / browser_click / browser_fill / browser_extract / browser_close / office_read_table / office_write_table / kb_add",
          },
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
      description:
        "向成员派单。成员只拿到简报包（任务+完成标准+时限），看不到你们的对话。**一条任务线一支团队**：不传 teamId 时，新会话会新建团队（不会塞进上一条任务的班底）；要沿用旧班底必须显式传 teamId 并说明理由。多个任务并行时一任务一团队可以，但要先把任务清单（各派给谁、多久）告诉用户。",
      parameters: {
        type: "object",
        required: ["taskId", "member", "brief", "deadline"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          teamName: { type: "string", description: "需要自动建队时用的团队名（可选）" },
          taskId: { type: "string" },
          member: { type: "string" },
          brief: { type: "string" },
          deadline: { type: "string" },
          tools: { type: "array", items: { type: "string" }, description: "本次分配工具集，必须 ⊆ 岗位白名单" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（写进任务契约，用户点开始后生效）" },
          template: {
            type: "string",
            description: "复用哪套编制模板（省略则按任务标题自动匹配；没有再自动新建一支空队，不会失败）",
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
        required: ["taskId"],
        properties: { teamId: { type: "string", description: TEAM_HINT }, taskId: { type: "string" } },
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
        required: ["taskId", "member", "text", "evidence"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
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
        required: ["taskId", "member", "verdict"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
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
        required: ["taskId", "conclusion"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
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
  {
    type: "function",
    function: {
      name: "ship_plugin",
      description:
        "把通过准入审查的工坊草稿启用（M3-07 插件工坊）。只允许 L0 技能插件自启用——每次启用记审计并在汇报里告知用户；L1/L2 一律拒绝：必须由用户在插件面板点启用（她不得给自己的产物提权，Q6 定稿 C）。",
      parameters: {
        type: "object",
        required: ["draftId"],
        properties: { draftId: { type: "string", description: "工坊草稿 id（workshop.list 可查）" } },
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
  /** M3-07：插件工坊草稿 id——成员工作区即草稿区（产物只能写进草稿） */
  draftId?: string;
}

/** 排队中的输入 */
interface QueuedInput extends QueueItem {
  mode: "queue" | "steer";
  attachments?: TurnAttachments;
}

/** 计划档位下也允许的只读工具 */
const READ_ONLY_TOOLS = new Set(["check_progress", "check_roster"]);

/**
 * C4：新会话提示（纯函数，便于单测）。
 * 没有在跑的单就只说"留在会话列表里"；有就必须点名 + 给"全部停掉"的动作，
 * 否则用户以为"从头开始"，后台还在烧预算、还会弹审批。
 */
export function newSessionNotice(running: string[]): { text: string; action?: "stopRunning" } {
  if (running.length === 0) {
    return { text: "新会话已开始。上一段对话留在「会话」列表里，随时能切回。" };
  }
  return {
    text: `新会话已开始。上一段对话留在「会话」列表里，随时能切回。注意：还有 ${running.length} 张单在后台跑（${running.join("、")}），不停会继续消耗预算并可能弹审批。`,
    action: "stopRunning",
  };
}

/** C3：会话 → 工单归属计数（纯函数）。老单没记 threadId 就不归到任何会话，不猜。 */
export function countTasksByThread(tasks: { threadId?: string; status: TaskStatus }[]): Map<string, { active: number; archived: number }> {
  const out = new Map<string, { active: number; archived: number }>();
  for (const task of tasks) {
    if (!task.threadId) continue;
    const c = out.get(task.threadId) ?? { active: 0, archived: 0 };
    if (groupOf(task.status) === "archived") c.archived += 1;
    else c.active += 1;
    out.set(task.threadId, c);
  }
  return out;
}

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
  /**
   * 成员运行时的聊天函数（默认真 streamChat）。
   * 只为整链路回归留的注入点：派单 → 后台执行 → 跨会话回报，真的跑一遍不该靠 mock 网络层。
   */
  memberChatFn?: typeof streamChat;
  /** 成员进度（姓名 → 0–100）：只在内存里，用来画实时进度 */
  private memberProgress = new Map<string, number>();
  /** 成员本轮累计 token（`teamId::成员` → tokens）：编制表的预算读数不再是硬编码 0 */
  private memberUsage = new Map<string, number>();
  /** 每张单的中止器（用户点「停」）：没有它就只能解散全队来止损 */
  private memberAborts = new Map<string, AbortController>();
  /** 成员占用：`teamId::成员` → 正在跑的 taskId（同一成员不许并发跟两张单） */
  private memberActive = new Map<string, string>();
  private listeners = new Set<(ev: KernelEvent) => void>();

  /** Pi RPC worker 可用（M0-03：壳与运行时分进程） */
  private piReady = false;
  /** 子进程宿主；懒启动，配置/工具面变化时重建 */
  private host: AgentHost | null = null;
  private hostStamp = "";
  /** 流式中的她：runChat 里增量 patch */
  private liveCard: FeedCard | null = null;
  /**
   * 上一次推 delta 事件的时间。按帧节流（~16ms）而不是按"人能看清"的 80ms：
   * 合并交给渲染层 rAF（蓝本 tether-ai 的做法），主进程只做去抖，不做降帧。
   */
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
  /** 最近一次「任务契约已呈给用户」的时间：用来挡"派完单又问一遍是否开工" */
  private lastPlanAt = 0;
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
  /** 本地日历（M2-01）：node:sqlite，降级 JSON 时 backend 如实标注 */
  private calendar!: CalendarStore;
  private reminderTimer: NodeJS.Timeout | null = null;
  /** 定时任务（M2-02）：调度器在核心里；单飞 + 陈旧清理 + 休眠补跑 */
  private scheduler!: SchedulerStore;
  private scheduleTimer: NodeJS.Timeout | null = null;
  /** 系统通知通道（M2-03）：壳层注入；不依赖云推送。通知失败不影响应用内卡片（双通道） */
  private notifier: ((title: string, body: string) => void) | null = null;
  /** 本地知识库（M2-04）：权威是 markdown 文件，FTS5 trigram 只做检索 */
  private knowledge!: KnowledgeStore;
  /** office 引擎健康（M2-06）：init 时探测一次，工具调用时如实降级 */
  private officeHealth!: EngineHealth;
  /** 浏览器单例（M2-07）：headed 可接管；登录/支付/验证码由 controller 内拦截 */
  private readonly browserCtl = new BrowserController({ headed: true });
  /** 知识库目录 watch（M2-09）：变更去抖后增量索引 */
  private kbWatch: { close: () => void } | null = null;
  /** 软上限已提醒标记（M2-11）：每会话一次，不刷屏 */
  private budgetWarned = false;
  /** 技能（M2-10）：三级路径发现；命中后 allowed-tools 强制到工具门禁 */
  private skillEntries: SkillEntry[] = [];
  private activeSkills: SkillEntry[] = [];
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
    this.calendar = new CalendarStore(dataRoot);
    this.scheduler = new SchedulerStore(dataRoot);
    this.knowledge = new KnowledgeStore(dataRoot);
    this.knowledge.reindex();
    this.officeHealth = { found: false, kind: "none", detail: "尚未探测" };
    this.reloadSkills();
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
    /** 出发会话：后台成员的审计卡要写回它，否则别的会话会被拦截记录刷屏（C2） */
    threadId: string = this.currentThreadId,
  ): void {
    const rec = { at: new Date().toISOString(), kind: ev.kind, teamId, taskId, member, command: ev.command.slice(0, 500), why: ev.why, cwd: ev.cwd };
    try {
      fs.appendFileSync(path.join(this.dataRoot, "audit.jsonl"), JSON.stringify(rec) + "\n", "utf-8");
    } catch {
      /* 审计写不进去也不能影响执行，但会缺一条记录 */
    }
    this.log("tool_audit", { kind: ev.kind, taskId, member, why: ev.why });
    if (ev.kind === "cmd_blocked") {
      this.cardTo(threadId, { kind: "tool", badge: "已拦截", title: `${member} · ${taskId}`, body: `命令被纵深防御规则拦下：${ev.why}\n${ev.command}` });
    } else if (ev.kind === "cmd_net") {
      this.cardTo(threadId, { kind: "tool", badge: "出站", title: `${member} · ${taskId}`, body: `出站命令已审计：${ev.command}` });
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

  /**
   * 后台任务（成员执行）的卡片写回它出发的会话。
   * 用户已经切到别的会话时，只落盘 + 发一个"该会话有动静"的事件，
   * 绝不 push 进当前 feed——否则新会话会被旧任务的回报刷屏、旧会话反而缺卡。
   */
  private cardTo(threadId: string, c: Omit<FeedCard, "id" | "createdAt">): void {
    if (!threadId || threadId === this.currentThreadId) {
      this.card(c);
      return;
    }
    const st = this.threads.loadState(threadId);
    const seq =
      st.feed.reduce((n, x) => Math.max(n, Number(/^c-(\d+)$/.exec(x.id)?.[1] ?? 0)), 0) + 1;
    const full: FeedCard = {
      ...c,
      id: `c-${seq}`,
      createdAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    st.feed.push(full);
    this.threads.saveState(threadId, { feed: st.feed.slice(-200), history: st.history });
    this.notify({ type: "thread", threadId });
  }

  /** 同一张卡在别的会话里的状态更新（成员开工卡 → 回报/未完成） */
  private patchCardTo(threadId: string, card: FeedCard, patch: Partial<FeedCard>): void {
    if (!threadId || threadId === this.currentThreadId) {
      this.patchCard(card, patch);
      return;
    }
    const st = this.threads.loadState(threadId);
    const hit = st.feed.find((x) => x.id === card.id);
    if (!hit) {
      // 出发会话里没这张卡（极端情况）：当作新卡补一条，别把结果丢掉
      this.cardTo(threadId, { ...card, ...patch });
      return;
    }
    Object.assign(hit, patch);
    this.threads.saveState(threadId, { feed: st.feed.slice(-200), history: st.history });
    this.notify({ type: "thread", threadId });
  }

  /** 回合状态迁移：所有 UI 的"谁在干什么"都只读这一个字段 */
  private setTurn(patch: Partial<TurnState>): void {
    this.turn = { ...this.turn, ...patch, pending: this.queue.length };
    this.notify({ type: "turn", turn: this.turn });
  }

  // ---------- 线程落盘（M1-14） ----------

  private threadSaveTimer: NodeJS.Timeout | null = null;

  /** system prompt（M1-17/M2-05/M2-10）：固定头 + persona + 记忆两层 + 技能注入 + 安全尾段；每轮现取 */
  private systemPrompt(): string {
    return composeSystemPrompt(this.persona.load()) + this.memory.systemPromptSection() + this.skillSection();
  }

  /** 激活技能的注入文本（submitTurn 时已算好；预算降级如实标注） */
  private skillSection(): string {
    if (!this.activeSkills.length) return "";
    const inj = buildInjection(this.activeSkills);
    return `\n${inj.text}\n`;
  }

  /** 壳层读偏好（托盘/通知开关，M1-18）：壳不直接碰 SettingsStore */
  getPrefs(): { autoStart: boolean; trayOnClose: boolean; notify: boolean } {
    const p = this.settings.getPrefs();
    return { autoStart: p.autoStart, trayOnClose: p.trayOnClose, notify: p.notify };
  }

  private assertMemoryKind(kind: string): asserts kind is MemoryKind {
    if (kind !== "user" && kind !== "memory") throw new Error(`未知记忆层：${kind}（user | memory）`);
  }

  /** 定时任务 tick（M2-02）：单飞——一次至多派一个；错过 >10 分钟如实标 missed 补跑 */
  private tickSchedules(): void {
    const due = this.scheduler.due(new Date());
    if (!due.length) return;
    const first: DueItem = due[0];
    if (!this.scheduler.acquire(first.task.id, new Date())) return;
    const { task, missed } = first;
    this.notifyUser(
      `定时任务 · ${task.name}`,
      `${missed ? "补跑（错过原定时刻）" : "准点"} · ${task.kind}`,
    );
    // 交给风铃：作为一条消息进对话流，全程留痕
    try {
      this.submitTurn(`【定时任务·${task.name}${missed ? "·补跑" : ""}】${task.prompt}`);
      this.scheduler.release(task.id, missed ? "missed" : "ok");
    } catch (err) {
      this.scheduler.release(task.id, "error");
      this.card({ kind: "system", badge: "工具", title: `定时任务失败 · ${task.name}`, body: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 系统通知注入点（M2-03）：壳层把托盘通知接进来；提醒/定时任务双通道触达 */
  setNotifier(fn: (title: string, body: string) => void): void {
    this.notifier = fn;
  }

  /** 提醒必达：应用内卡片（必落）+ 系统通知（尽力）；通知失败只记日志不炸 */
  private notifyUser(title: string, body: string): void {
    this.card({ kind: "system", badge: "提醒", title, meta: body || undefined });
    if (!this.notifier) return;
    try {
      this.notifier(title, body);
      this.log("notified", { title });
    } catch (err) {
      this.log("notify_failed", { title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 发现技能（M2-10）：用户级 ~/.lynn/skills + 项目级 .lynn/skills（需信任）+ 插件携带；就近优先 */
  private reloadSkills(): void {
    const trusted = this.trust?.isTrusted(this.projectRoot) ?? false;
    const allRoots: { dir: string; level: SkillEntry["level"] }[] = [
      { dir: path.join(this.dataRoot, "skills"), level: "user" },
      { dir: path.join(this.projectRoot, ".lynn", "skills"), level: "project" },
      { dir: path.join(this.dataRoot, "plugins"), level: "plugin" },
    ];
    const roots = allRoots.filter((r) => r.level !== "project" || trusted);
    const { entries, errors } = discoverSkills(roots);
    this.skillEntries = entries;
    for (const e of errors.slice(0, 5)) this.log("skill_error", { error: e });
    for (const e of entries) {
      for (const w of e.warnings.slice(0, 3)) this.log("skill_warning", { skill: e.name, warning: w });
    }
    this.log("skills_ready", { count: entries.length, projectTrusted: trusted });
  }

  /** 命中技能 → 本轮生效：注入预算内内容 + allowed-tools 强制子集 */
  private activateSkillsFor(text: string): void {
    this.activeSkills = matchSkills(text, this.skillEntries);
    if (this.activeSkills.length) {
      const inj = buildInjection(this.activeSkills);
      this.card({
        kind: "system",
        badge: "工具",
        title: `技能激活 · ${this.activeSkills.map((s) => s.name).join("、")}`,
        body: inj.degraded ? "技能内容超预算，已降级为仅名称注入。" : undefined,
      });
      this.log("skills_activated", { skills: this.activeSkills.map((s) => s.name), degraded: inj.degraded });
    }
  }

  /** 软上限检查（M2-11）：达限落一张提示卡（每次会话只提醒一次，不刷屏）；不静默停机 */
  private checkBudget(): void {
    const { mode, ratio } = evaluateBudget(this.usage.sessionIn + this.usage.sessionOut, this.settings.getPrefs().softBudgetTokens);
    if (mode !== "soft" || this.budgetWarned) return;
    this.budgetWarned = true;
    this.notifyUser(
      "预算提示",
      `本轮 token 用量已达软上限（${Math.round(ratio * 100)}%）。未配置备用模型时继续用当前模型；不会自动停机。`,
    );
  }

  /** 手动触发提醒扫描（测试与 UI 刷新用） */
  private scanReminders(): void {
    try {
      const due = dueReminders(this.calendar.listEvents({ includePast: false }));
      for (const e of due) {
        this.calendar.markNotified(e.id);
        this.notifyUser(e.title, `日程 · ${new Date(e.at).toLocaleString("zh-CN")}`);
        this.log("reminder_fired", { id: e.id, title: e.title });
      }
    } catch (err) {
      this.log("reminder_scan_error", { error: err instanceof Error ? err.message : String(err) });
    }
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
        // C4：会话累计用量按线程落盘，切回来读数还对得上
        usage: { sessionIn: this.usage.sessionIn, sessionOut: this.usage.sessionOut, tokensUsed: this.tokensUsed },
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
    // C4：会话累计用量跟线程走（旧线程文件没有 usage 就如实从 0 起，不借别的会话的数）
    this.tokensUsed = st.usage?.tokensUsed ?? 0;
    this.usage = {
      ...this.usage,
      turnIn: 0,
      turnOut: 0,
      sessionIn: st.usage?.sessionIn ?? 0,
      sessionOut: st.usage?.sessionOut ?? 0,
      contextTokens: 0,
    };
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

  /**
   * 启动对账：上次进程被杀/退出时留在 in_progress 的单，成员已经不在跑了。
   * 不收拾的话台账上永远挂着"进行中"，点「停」还会回"没有在跑的"。
   */
  private reconcileOrphanTasks(): void {
    let n = 0;
    for (const t of this.taskStore.list()) {
      if (t.status !== "in_progress" || this.memberRuns.has(t.id)) continue;
      try {
        this.taskStore.transition(t.id, "blocked");
        n += 1;
      } catch {
        /* 迁移规则不允许就不强改 */
      }
    }
    if (n > 0) {
      this.card({
        kind: "system",
        text: `${n} 张单在上次运行时中断、没有收尾（成员已不在跑），已标成「卡住」。要重做就重新派单。`,
      });
    }
  }

  async init(): Promise<void> {
    // 上次没收尾的单先对账（放在最前：界面一打开就该是真实状态）
    this.reconcileOrphanTasks();
    // office 引擎健康（M2-06）：探测一次；失败不影响 CSV
    this.officeHealth = await probeSoffice().catch(
      (): EngineHealth => ({ found: false, kind: "none", detail: "引擎探测失败（不影响 CSV）" }),
    );
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
    // 本地日历提醒扫描（M2-01）：分钟级
    this.reminderTimer = setInterval(() => this.scanReminders(), 60_000);
    this.reminderTimer.unref?.();
    // 定时任务（M2-02）：30s tick；启动恢复（陈旧在途清理）先行，错过的任务由首个 tick 补跑
    const rec = this.scheduler.get();
    const { released } = recoverScheduler(rec, new Date());
    if (released.length) this.log("scheduler_recovered", { released });
    this.scheduleTimer = setInterval(() => this.tickSchedules(), 30_000);
    this.scheduleTimer.unref?.();
    // 知识库增量索引（M2-09）：文件变更去抖 800ms 后增量重索引
    this.kbWatch = watchKnowledge(this.knowledge.dir, () => this.knowledge.reindex(), {
      onChange: (r) => {
        if (r.indexed || r.removed) this.log("kb_indexed", r);
      },
    });

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
  private registerReport(
    teamId: string,
    taskId: string,
    member: string,
    text: string,
    evidence: string[],
    sessionId?: string,
    threadId: string = this.currentThreadId,
    /** 证据在界面上的显示名（成员交的是相对工作区的路径，ref 会被解析成绝对路径） */
    displayNames?: string[],
  ): string {
    this.tools.reviewResult(teamId, taskId, { member, text, evidence, sessionId: sessionId ?? this.host?.sessionId });
    this.taskCase.append(taskId, { kind: "report", member, text, meta: { evidence } });
    this.taskCase.appendSummary(taskId, `${member} 回报：${text.slice(0, 60)}`);

    try {
      this.taskStore.ensureInProgress({ id: taskId, title: taskId, teamId, member, threadId });
    } catch {
      // 工单已存在或状态已就位
    }
    let verified = 0;
    for (const [i, e] of evidence.entries()) {
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
        label: (displayNames?.[i] ?? e).slice(0, 80),
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
        // 后台回报也要归出发会话（C2）：否则在别的会话里会凭空多出一张"证据未通过"卡
        this.cardTo(threadId, {
          kind: "tool",
          badge: "回报",
          title: `证据未通过验证 · ${member} · ${taskId}`,
          body: `已登记 ${evidence.length} 项，其中可验证 ${verified} 项。无已验证证据不能进审查（§4.10.5）。`,
        });
        return `回报已登记；但 ${verified} 项证据可验证（要求 ≥1）：文件不存在或无法复跑，工单停在执行中。`;
      }
    }

    this.cardTo(threadId, {
      kind: "tool",
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
    // 敏感页强制 ask（M2-07）：登录/支付/验证码，任何档位都不放行到免审批
    if (name === "browser_navigate") {
      const s = sensitiveUrl(String(args.url ?? ""));
      if (s.sensitive && (this.permission === "auto" || this.permission === "full")) {
        this.log("browser_sensitive_blocked", { url: String(args.url) });
        return `导航目标命中敏感特征（${s.why}）。请让用户手动处理登录/支付/验证码，或把该操作改为需要确认的方式。`;
      }
    }
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

  /**
   * 用户确认任务契约后真正开工：记录派单 → 起成员 → **起得来才**进 in_progress。
   * 原来先把工单推到 in_progress 再试，模型没配 / 并发满 / 成员忙时会留下一张
   * 永远"进行中"却没人跑的单——用户实报的"卡住删不掉"就包括这一类。
   */
  private startAssignment(p: PendingPlan): string {
    this.tools.assignTask(p.teamId, {
      taskId: p.taskId,
      member: p.member,
      brief: p.brief,
      deadline: p.deadline,
      tools: p.tools,
      sessionId: this.host?.sessionId, // M0-13：派单记录可回溯到当轮 Pi session
    });
    // 先只到 todo（确认过了但还没真开工）
    try {
      const existing = this.taskStore.get(p.taskId);
      if (!existing) {
        this.taskStore.create({
          id: p.taskId,
          title: (p.brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 40) || p.taskId,
          teamId: p.teamId,
          member: p.member,
          // 记下"这单从哪个会话派出"：换会话后旧工单的往来还能读回来
          threadId: this.currentThreadId,
        });
        this.taskStore.transition(p.taskId, "todo");
      } else if (existing.status === "backlog" || existing.status === "blocked") {
        this.taskStore.transition(p.taskId, "todo", { threadId: this.currentThreadId });
      }
      // 其余状态（todo / in_progress / canceled / done）不动；缺失的 threadId 由成员回报时补记
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
    const kickoff = this.dispatchMember(p.teamId, p.taskId, p.member, p.brief, p.deadline, p.tools, p.draftId);
    if (kickoff.ok) {
      try {
        this.taskStore.transition(p.taskId, "in_progress", { member: p.member, threadId: this.currentThreadId });
      } catch {
        /* 已是 in_progress */
      }
    } else {
      // 停在 todo：没有假"进行中"；原因写进会话与卷宗，用户知道下一步该做什么
      this.taskCase.append(p.taskId, { kind: "note", text: `未开工：${kickoff.message}` });
      this.card({ kind: "system", text: `${p.taskId} 没开工（停在待办）：${kickoff.message}` });
    }
    this.setTurn({ phase: "working", taskId: p.taskId, busy: this.busy });
    return kickoff.message;
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
    draftId?: string,
  ): { ok: boolean; message: string } {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) {
      return { ok: false, message: "模型未配置（或 Key 无法解密）：派单已记录，但成员无法开工。请先在设置里配置模型。" };
    }
    let profile;
    try {
      profile = this.teamStore.readMember(teamId, member);
    } catch {
      return { ok: false, message: `读不到 ${member} 的岗位档案，无法开工（档案文件可能被移动或改名）。` };
    }
    if (this.memberRuns.has(taskId)) {
      return { ok: false, message: `${taskId} 已有成员在执行中，不重复开工。` };
    }
    const cap = this.maxParallelMembers();
    if (this.memberRuns.size >= cap) {
      return {
        ok: false,
        message: `同时最多 ${cap} 个成员在跑，现在已经有 ${this.memberRuns.size} 个（${[...this.memberRuns.keys()].join("、")}）。等其中一个回报或点「停」之后再派；确实要更多可以调 settings.prefs.maxParallelMembers。`,
      };
    }
    // 后台执行可能跨会话：出发时的线程记下来，回报要写回那一个，不能落到用户当前看的会话里
    const runThreadId = this.currentThreadId;
    // 同一个成员同时跟两张单 = 工具层互相堵死（真实事故：13:24 与 13:26 各派一张，然后两边都不动了）
    const memberKey = `${teamId}::${member}`;
    const busyTask = this.memberActive.get(memberKey);
    if (busyTask && busyTask !== taskId) {
      return { ok: false, message: `成员「${member}」正在跑 ${busyTask}，同一成员同时只能跟一张单。等它回报后再派，或换一个成员。` };
    }
    // 执行工具 = 本次分配 ∩ 内置执行工具；submit_report 是回报通道，不占白名单
    const allowed = (toolsArg ?? profile.tools).filter((t) =>
      (MEMBER_EXEC_TOOLS as readonly string[]).includes(t),
    );
    // M3-07：带 draftId 的派单（插件工程师），工作区即草稿区——产物只能写进草稿，
    // 不可能落进生效目录（plugin-host 扫描跳过 `_` 前缀目录，草稿永不自动生效）
    const workdir = draftId ? path.join(draftsDir(this.dataRoot), draftId) : path.join(this.dataRoot, "tasks", taskId, "workspace");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "_brief.md"),
      `# 简报包（来自风铃）\n\n- 截止：${deadline}\n- 本次分配工具：${allowed.join("、") || "无"}\n\n${brief}\n`,
      "utf-8",
    );

    // 进度卡：一张单一张卡，跑的过程中就地更新——不再一次工具调用刷一张卡
    const controller = new AbortController();
    const steps: string[] = [];
    const startedAt = Date.now();
    const live = this.card({ kind: "tool", badge: "进度", title: `${member} 在干 · ${taskId}`, meta: "刚开工", body: "（等他第一步）" });
    let lastStepAt = Date.now();
    const pushStep = (text: string) => {
      steps.push(text);
      lastStepAt = Date.now();
      const tail = steps.slice(-6).join("\n");
      this.patchCard(live, {
        meta: `${steps.length} 步 · ${Math.round((Date.now() - startedAt) / 1000)}s`,
        body: tail.length > 1500 ? `…\n${tail.slice(-1500)}` : tail,
      });
    };
    // 卡死可见：长时间没有任何动作就在卡上标出来（不自动杀，让人决定）
    const stallTimer = setInterval(() => {
      const quiet = Date.now() - lastStepAt;
      if (quiet < MEMBER_STALL_MS) return;
      this.patchCard(live, {
        meta: `${steps.length} 步 · 已 ${Math.round((Date.now() - startedAt) / 1000)}s · 可能卡住`,
        body: `已经 ${Math.round(quiet / 1000)}s 没有任何动作。可以点台账上的「停」止损。\n\n最后动作：\n${steps.slice(-3).join("\n") || "（一步都没做）"}`,
      });
    }, 15_000);
    stallTimer.unref?.();

    const run: Promise<MemberRunResult> = runMemberTask({
      profile,
      brief,
      deadline,
      tools: allowed,
      signal: controller.signal,
      workdir,
      model: { baseUrl: cfg.baseUrl, apiKey, model: cfg.model },
      chatFn: this.memberChatFn,
      onAudit: (ev) => this.auditTool(teamId, taskId, member, ev, runThreadId),
      onBeforeWrite: (rel, full, existed) => this.checkpoints.beforeWrite(rel, full, existed),
      office: {
        read: (file) => readTable(file, this.officeHealth),
        write: (file, table) => writeTable(file, table),
      },
      browser: {
        navigate: (url) => this.browserCtl.navigate(url),
        snapshot: () => this.browserCtl.snapshot(),
        click: (target) => this.browserCtl.click(target),
        fill: (target, value) => this.browserCtl.fill(target, value),
        extract: (kind, selector) => this.browserCtl.extract(kind, selector),
        close: () => this.browserCtl.close(),
      },
      kb: {
        add: (name, markdown) => this.knowledge.addDoc(name, markdown),
      },
      onEvent: (ev) => {
        if (ev.kind === "tool") pushStep(ev.text);
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
        // 预算读数：按真实 token 累计（此前编制表恒显示 0）
        this.memberUsage.set(memberKey, (this.memberUsage.get(memberKey) ?? 0) + result.promptTokens + result.completionTokens);
        const used = Math.round((Date.now() - startedAt) / 1000);
        if (result.status === "reported" && result.evidence.length > 0) {
          // 成员交的证据是相对**工作区**的（"report.md"），卷宗校验只认卷宗目录 / cwd / dataRoot；
          // 不先解析到工作区，真文件也会被判成"验不了"，工单停在执行中（C1 实机验暴露的真 bug）。
          const evidence = result.evidence.map((e) => {
            if (/^https?:\/\//i.test(e) || path.isAbsolute(e)) return e;
            const abs = path.resolve(workdir, e);
            const rel = path.relative(workdir, abs);
            if (rel.startsWith("..") || path.isAbsolute(rel)) return e; // 越界不替换，交给校验如实判否
            return fs.existsSync(abs) ? abs : e;
          });
          // 只有真交了证据才登记；空回报进登记通道会抛错，原来那条路直接变成"崩溃"卡
          this.registerReport(teamId, taskId, member, result.report, evidence, undefined, runThreadId, result.evidence);
          this.patchCardTo(runThreadId, live, {
            badge: "回报",
            title: `${member} 回报 · ${taskId}`,
            meta: `${result.turns} 轮 · ${used}s`,
            body: result.report.slice(0, 1500),
          });
          return;
        }
        if (result.status === "aborted") {
          this.patchCardTo(runThreadId, live, {
            badge: "已停止",
            title: `${member} 已停止 · ${taskId}`,
            meta: `${used}s`,
            body: "用户中止。已写出的文件留在工作区。",
          });
          return;
        }
        // 没回报：如实说清、把单子标成"卡住"让它在待你区里显形，别静默消失
        this.patchCardTo(runThreadId, live, {
          badge: "未完成",
          title: `${member} 没交出回报 · ${taskId}`,
          meta: `${result.turns} 轮 · ${used}s`,
          body: `${result.report}\n\n最后 ${Math.min(steps.length, 3)} 步：\n${steps.slice(-3).join("\n") || "（一步都没做）"}`,
        });
        try {
          this.taskStore.transition(taskId, "blocked");
        } catch {
          /* 状态已经不在可迁移范围内就不强改 */
        }
      })
      .catch((err: unknown) => {
        this.patchCardTo(runThreadId, live, {
          badge: "崩溃",
          title: `${member} 执行崩溃 · ${taskId}`,
          meta: `${steps.length} 步`,
          body: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        clearInterval(stallTimer);
        this.memberRuns.delete(taskId);
        this.memberAborts.delete(taskId);
        if (this.memberActive.get(memberKey) === taskId) this.memberActive.delete(memberKey);
      });
    this.memberRuns.set(taskId, run);
    this.memberAborts.set(taskId, controller);
    this.memberActive.set(memberKey, taskId);
    this.emit({
      type: "tool",
      badge: "派单",
      title: `${member} 开工 · ${taskId}`,
      meta: `工具：${allowed.join("、") || "无"}`,
      body: `工作区 tasks/${taskId}/workspace/（成员文件活动限制在此，回报后自动进审查台）`,
    });
    return { ok: true, message: "成员已开工（后台执行），回报后会自动进待审查。" };
  }

  /**
   * 停掉一张正在跑的成员单（§4.10.4 缺的那一半）。
   * 之前想止损只有"解散整队"一条路，会连带停掉同队其他成员。
   */
  cancelMemberTask(taskId: string): { ok: boolean; error?: string } {
    const controller = this.memberAborts.get(taskId);
    if (!controller) return { ok: false, error: `没有在跑的 ${taskId}（可能已经结束或从未开工）` };
    controller.abort();
    // 停了就必须有可见变化：原来只 abort，工单永远停在 in_progress，台账上看着"还在跑"
    let moved = false;
    try {
      const rec = this.taskStore.get(taskId);
      if (rec && rec.status === "in_progress") {
        this.taskStore.transition(taskId, "blocked", { member: rec.member });
        this.taskCase.append(taskId, { kind: "transition", text: "→ blocked（用户手动停机）" });
        moved = true;
      }
    } catch {
      /* 状态已不在可迁移范围就不强改 */
    }
    const text = moved
      ? `已停 ${taskId}：成员收手，工单转入「卡住」——可以右键取消或重新派单，不再一直挂在「进行中」。`
      : `已停 ${taskId}：成员在本轮模型调用结束后收手，已写出的文件留在工作区。`;
    // C2 原则：工单相关卡片归出发会话——在别的会话点「停」不该把过程噪音写进当前会话
    const owner = this.taskStore.get(taskId)?.threadId;
    if (owner) this.cardTo(owner, { kind: "system", text });
    else this.card({ kind: "system", text });
    return { ok: true };
  }

  /** 并行上限（settings.prefs.maxParallelMembers，1–8；非法值回退默认 4） */
  private maxParallelMembers(): number {
    const raw = Number(this.settings.getPrefs().maxParallelMembers);
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PARALLEL_MEMBERS;
    return Math.min(Math.floor(raw), 8);
  }

  /** 取消一张单（→ canceled，进归档带）：在跑的会先停下成员 */
  dismissTask(taskId: string): { ok: boolean; error?: string } {
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    if (rec.status === "canceled") return { ok: true };
    if (rec.status === "done") return { ok: false, error: `${taskId} 已经验收归档，不能取消` };
    if (this.memberRuns.has(taskId)) this.cancelMemberTask(taskId);
    try {
      this.taskStore.transition(taskId, "canceled", { member: rec.member });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.taskCase.append(taskId, { kind: "note", text: "用户取消这张单" });
    const text = `已取消 ${taskId}：从台账移到归档带（目录与卷宗保留，可搜可查）。`;
    if (rec.threadId) this.cardTo(rec.threadId, { kind: "system", text });
    else this.card({ kind: "system", text });
    if (this.decisions.some((d) => d.jobId === taskId)) {
      this.decisions = this.decisions.filter((d) => d.jobId !== taskId);
      this.setTurn({});
    }
    return { ok: true };
  }

  /** 彻底删除一张单（tasks/<id>/ 整目录）：不可恢复，界面必须二次确认 */
  removeTask(taskId: string): { ok: boolean; error?: string } {
    if (this.memberRuns.has(taskId)) return { ok: false, error: `${taskId} 还在跑：先停成员再删` };
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    try {
      this.taskStore.remove(taskId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // 派单账本也是台账的兜底来源：不删它，删完工单还会从 assignments 里"复活"一条
    try {
      fs.rmSync(path.join(this.dataRoot, "team", rec.teamId, "assignments", `${taskId}.jsonl`), { force: true });
    } catch {
      /* 没有账本文件是常态 */
    }
    this.memberProgress.delete(rec.member ?? "");
    // 指向这张单的挂起裁决/契约一并撤掉，避免点开已删的工单
    if (this.decisions.some((d) => d.jobId === taskId)) {
      this.decisions = this.decisions.filter((d) => d.jobId !== taskId);
      this.setTurn({});
    }
    const text = `已删除 ${taskId}：工单、卷宗与工作区一并移除（不可恢复）。`;
    if (rec.threadId) this.cardTo(rec.threadId, { kind: "system", text });
    else this.card({ kind: "system", text });
    return { ok: true };
  }

  /** 在跑的成员单（taskId 列表）：界面据此显示「停」按钮，而不是让用户去猜 */
  runningTaskIds(): string[] {
    return [...this.memberRuns.keys()];
  }

  runTool(name: string, args: Record<string, unknown>): string {
    switch (name) {
      // 0. create_team（§4.10.3 修正）：ID 由系统生成，模型只需给名字
      case "create_team": {
        const team = this.autoCreateTeam({
          teamName: args.name ? String(args.name) : undefined,
          title: args.name ? String(args.name) : undefined,
        });
        this.card({
          kind: "system",
          text: team.reused
            ? `已建团队「${team.name}」（复用编制「${team.reused.name}」，${team.reused.members} 人）——ID ${team.id} 由系统生成。`
            : `已建团队「${team.name}」——ID ${team.id} 由系统生成，接下来直接 create_member 招募即可。`,
        });
        return JSON.stringify({ teamId: team.id, teamName: team.name, members: team.reused?.members ?? 0 });
      }
      case "create_member": {
        // 没有团队就自动建一支：不再让模型回头向用户要 teamId
        let teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) {
          const team = this.autoCreateTeam({
            teamId: args.teamId ? String(args.teamId) : undefined,
            teamName: args.teamName ? String(args.teamName) : undefined,
          });
          teamId = team.id;
          this.card({ kind: "system", text: `还没有可用团队，已自建「${team.name}」（ID ${team.id}）。` });
        }
        this.tools.createMember(
          teamId,
          {
            name: String(args.name),
            role: String(args.role),
            goal: String(args.goal),
            boundaries: (args.boundaries as string[]) ?? [],
            tools: (args.tools as string[]) ?? [],
            model: "deepseek-chat",
            // 15 轮封顶：一轮一次模型调用，40 轮能烧很久且大多数时候后 20 轮都在原地打转
            limits: { maxTurns: 15, budgetTokens: 300000, wallClockMin: 30 },
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
        return `已招募 ${args.name}（岗位档案已落盘，用户可读可改）。团队 ID：${teamId}（**同一条任务线**的后续派单可省略 teamId；换新任务请显式给新团队，不要复用这条任务线的班底）。`;
      }
      case "assign_task": {
        const taskId = String(args.taskId);
        const member = String(args.member);
        const brief = String(args.brief);
        const deadline = String(args.deadline);
        const tools = (args.tools as string[] | undefined) ?? undefined;
        // M3-07：插件工坊派单——工作区即草稿区（成员产物只能写进草稿，永不自动生效）
        const draftId = args.draftId ? String(args.draftId) : undefined;
        if (draftId && !listDrafts(this.dataRoot).some((d) => d.draftId === draftId)) {
          return `草稿 ${draftId} 不存在。先用 workshop.create 开草稿，再派单给插件工程师。`;
        }
        // 标题取简报第一个非空行（首行为空时别把裸 taskId 当标题摆到台账上）
        const titleLine = brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
        const title = (titleLine || taskId).slice(0, 40);
        // M1-08 + §4.10.3 修正：显式 → 当前唯一在职队 → 模板复用 → 自动新建空队。
        // 绝不因为"团队不存在"把活退回去让用户给 ID（这正是此前卡死的根因）。
        let teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) {
          const team = this.autoCreateTeam(
            {
              teamId: args.teamId ? String(args.teamId) : undefined,
              teamName: args.teamName ? String(args.teamName) : undefined,
              title,
            },
            args.template as string | undefined,
          );
          teamId = team.id;
          this.card({
            kind: "system",
            text: team.reused
              ? `已建「${team.name}」并复用编制「${team.reused.name}」（${team.reused.members} 人），ID ${team.id}。`
              : `新任务线：已为它新建独立班底「${team.name}」（ID ${team.id}）。接着 create_member 招募即可——一条任务线一支团队，不和别的任务混在一起。`,
          });
        }
        // 成员档案不存在时如实说明该先招人——这是真缺人，不是缺团队
        if (!this.teamStore.teamExists(teamId)) {
          return `团队 ${teamId} 仍不可用（建队失败），请如实告知用户并附上错误。`;
        }
        if (!this.teamStore.listMembers(teamId).some((p) => p.name === member)) {
          const here = this.teamStore.listMembers(teamId).map((p) => p.name).join("、") || "（空）";
          // 成员在别的团队里：说清两条路（沿用旧班底要显式给 teamId，新任务就在本队招人）
          const elsewhere = this.teamStore
            .activeTeams()
            .filter((t) => t.id !== teamId)
            .map((t) => ({ id: t.id, name: t.name, names: this.teamStore.listMembers(t.id).map((p) => p.name) }))
            .filter((x) => x.names.includes(member));
          if (elsewhere.length > 0) {
            return `团队 ${teamId} 里没有「${member}」，但它在 ${elsewhere
              .map((x) => `${x.name}（${x.id}）`)
              .join("、")} 里。如果是**同一条任务线**的后续单，请显式传 teamId=${elsewhere[0].id}；如果是**新任务**，就在当前团队重新 create_member（别把旧任务的人带过来）。`;
          }
          return `团队 ${teamId} 里还没有成员「${member}」（现有：${here}），先 create_member 招募（团队已经在了，不用再建队，也不用问用户要 ID）。`;
        }
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
        const ctx: PendingPlan = { teamId, taskId, member, brief, deadline, tools, draftId };
        // 还没开工：工单只落 todo，不能谎报"执行中"（七态见 §4.10.4）
        if (!this.taskStore.get(taskId)) {
          // 建单时就钉住会话：任务线判定（团队不复用）与 C3 的往来归属都靠它
          this.taskStore.create({ id: taskId, title, teamId, member, threadId: this.currentThreadId });
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
        this.lastPlanAt = Date.now();
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
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) return "本机还没有任何团队：先 create_team（ID 由系统生成），再招募派单。";
        const p = {
          ...this.tools.checkProgress(teamId, taskId),
          running: this.memberRuns.has(taskId),
        };
        return JSON.stringify(p, null, 2);
      }
      case "check_roster": {
        return JSON.stringify(this.tools.roster(args.teamId ? String(args.teamId) : undefined), null, 2);
      }
      case "ship_plugin": {
        // M3-07（Q6 定稿 C）：只有 L0 技能插件允许她自启用，每次启用记审计并落卡告知用户
        const draftId = String(args.draftId);
        const review = reviewDraft(this.dataRoot, draftId, {
          pluginIds: this.pluginHost.scan().plugins.map((p) => p.id),
          skillNames: this.skillEntries.map((s) => s.name),
        });
        if (!review.ok) {
          return JSON.stringify({ ok: false, verdict: review.verdict, findings: review.findings }, null, 2);
        }
        if (review.tier !== "L0") {
          return `${review.tier} 档插件不能由你启用（她不得给自己的产物提权，Q6 定稿 C）。审查已通过，请如实告知用户：在插件面板点「启用」即可生效。`;
        }
        let enabled;
        try {
          enabled = promoteDraft(this.dataRoot, draftId, false);
        } catch (err) {
          return `启用失败：${err instanceof Error ? err.message : String(err)}`;
        }
        this.reloadSkills();
        try {
          fs.appendFileSync(
            path.join(this.dataRoot, "audit.jsonl"),
            JSON.stringify({ at: new Date().toISOString(), tool: "ship_plugin", draftId, id: enabled.id, tier: enabled.tier, by: "风铃自启用（L0）" }) + "\n",
            "utf-8",
          );
        } catch {
          /* 审计写失败不阻断，但失败即异常路径——插件面板仍有记录 */
        }
        this.card({ kind: "system", text: `L0 技能插件「${enabled.id}」已由风铃自启用（Q6 定稿 C），此动作已记审计。技能即刻可被检索激活。` });
        return `已启用 L0 技能插件 ${enabled.id}。记得在汇报里告知用户（自启用须告知）。`;
      }
      case "review_result": {
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) return "本机还没有任何团队，无从登记回报。先 create_team（ID 由系统生成）。";
        return this.registerReport(
          teamId,
          String(args.taskId),
          String(args.member),
          String(args.text),
          (args.evidence as string[]) ?? [],
        );
      }
      case "accept_or_reject": {
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) return "本机还没有任何团队，无从验收。先 create_team（ID 由系统生成）。";
        const r = this.tools.acceptOrReject(teamId, String(args.taskId), args.verdict as "accept" | "reject", {
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
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        // 没有团队就不落账（没队可落），但汇报本身必须照常呈给用户
        if (teamId) {
          this.tools.reportToUser(teamId, {
            taskId: String(args.taskId),
            conclusion: String(args.conclusion),
            evidence: (args.evidence as string[]) ?? [],
            unfinished: (args.unfinished as string[]) ?? [],
            decisionsNeeded: (args.decisionsNeeded as string[]) ?? [],
          });
        }
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
        // 刚呈上任务契约又问"是否确认开工"= 重复确认：契约卡自己带「开始/修改/驳回」，
        // 再来一问只会把用户的回答变成一轮新对话（真实事故：一次派单问了两遍）
        if (this.pendingPlans.size > 0 && Date.now() - this.lastPlanAt < 120_000) {
          return "任务契约已经在等用户确认（卡片上有「开始 / 修改 / 驳回」三个按钮），不要再用 ask_user 重复问是否开工。把需要补充的说明写进下一次回复即可。";
        }
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
          // allowed-tools 强制（M2-10）：命中技能后只许声明子集；元工具（管理 8 件 + 定时任务等）始终放行
          if (this.activeSkills.length && !isToolAllowed(name, this.activeSkills, MANAGEMENT_ONLY_TOOLS)) {
            this.log("skill_tool_denied", { tool: name, allowed: this.activeSkills.flatMap((s) => s.allowedTools) });
            return `工具 ${name} 不在当前激活技能的 allowed-tools 声明里（本次允许：${this.activeSkills.flatMap((s) => s.allowedTools).join("、") || "无"}）。按技能边界收窄行动，或在回复里说明为什么需要越界（用户可放宽技能声明）。`;
          }
          // 工具面真值在壳：MCP → L1 → 管理工具，与直连 executeToolCall 同一顺序（M1-10 三来源同管线）
          return await this.dispatchShellTool(name, args);
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
      // 把用户的项目根交给 worker 当 Pi 的 cwd（此前是 worker 脚本所在目录，
      // 导致 Pi 顺祖先目录捡到 F:\spiker\AGENTS.md 那个别的项目的开发指南）
      projectRoot: this.projectRoot,
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
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.kbWatch?.close();
    this.kbWatch = null;
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

  /**
   * 团队主键解析（§4.10.3 修正：主键由系统管，不是用户输入项）。
   * 显式给了且存在 → 用它；否则只有一支在职队 → 隐式绑它；都没有 → undefined（交给自动建队）。
   */
  private resolveTeamId(explicit?: string): string | undefined {
    const wanted = (explicit ?? "").trim();
    if (wanted && this.teamStore.teamExists(wanted)) return wanted;
    const active = this.teamStore.activeTeams();
    if (active.length !== 1) return undefined;
    const team = active[0];
    // 唯一在职队也**不能跨任务线复用**：只有"它还没做过任务"或"最近一张单就来自当前会话"
    // 才算同一条任务线。否则给新任务派单会把活塞进上一条任务的班底
    //（用户实报：审查 hermix 项目，却进了「超星学习攻坚组」）。
    const tasks = this.taskStore.list().filter((t) => t.teamId === team.id);
    if (tasks.length === 0) return team.id;
    return tasks[0].threadId && tasks[0].threadId === this.currentThreadId ? team.id : undefined;
  }

  /**
   * 缺团队就地建（对齐蓝本 tether-ai 的兜底姿态：不问用户要主键）。
   * 先看编制模板能不能复用，没有就起一支空队；ID 由系统生成，名字用人类可读的 hint。
   */
  private autoCreateTeam(
    hint: { teamId?: string; teamName?: string; title?: string },
    template?: string,
  ): { id: string; name: string; reused: { name: string; members: number } | null } {
    const requested = (hint.teamId ?? "").trim();
    // 团队名取人给的 name，没有就用任务标题（截断：右栏组头一行要放得下）
    const prettyName = ((hint.teamName ?? "").trim() || requested || (hint.title ?? "").trim() || "默认团队").slice(0, 24);
    // 机器可读的 ID（纯 ASCII）可以沿用；中文一类当名字，ID 重新生成
    const machine = requested && /^[A-Za-z0-9._-]+$/.test(requested) ? requested : undefined;
    const id = machine ?? generateTeamId(prettyName, (c) => this.teamStore.teamExists(c));
    const reused = this.tools.ensureTeamFromTemplate(id, hint.title ?? prettyName, template);
    if (reused) return { id, name: reused.name, reused };
    const created = this.tools.createTeam(prettyName, id, !machine);
    return { id: created.id, name: created.name, reused: null };
  }

  /**
   * 壳内工具分发（M1-10 三来源同管线）：MCP → L1 → 管理工具。
   * Pi onToolCall 与直连 executeToolCall 都走这里——顺序一致，新增来源改一处。
   */
  private async dispatchShellTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.mcp.has(name)) return await this.mcp.execute(name, args);
    return this.l1.has(name) ? await this.l1.execute(name, args) : this.runTool(name, args);
  }

  private async executeToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    // 状态行（对齐蓝本 liveStatus）：工具执行期间界面必须显示"正在做什么 + 已用时"，
    // 否则串行工具轮看起来就是卡死
    this.setTurn({ activity: "tool", activityName: name, activityAt: Date.now() });
    try {
      const denial = await this.gateTool(name, args);
      if (denial) return denial;
      // allowed-tools 强制（M2-10）：两条路径（Pi onToolCall / 直连 executeToolCall）同一道闸
      if (this.activeSkills.length && !isToolAllowed(name, this.activeSkills, MANAGEMENT_ONLY_TOOLS)) {
        this.log("skill_tool_denied", { tool: name, allowed: this.activeSkills.flatMap((s) => s.allowedTools) });
        return `工具 ${name} 不在当前激活技能的 allowed-tools 声明里（本次允许：${this.activeSkills.flatMap((s) => s.allowedTools).join("、") || "无"}）。按技能边界收窄行动，或在回复里说明为什么需要越界（用户可放宽技能声明）。`;
      }
      return await this.dispatchShellTool(name, args);
    } catch (err) {
      const text = `工具执行失败：${err instanceof Error ? err.message : String(err)}。请调整后重试或如实告知用户。`;
      this.emit({ type: "tool", badge: "工具", title: `${name} 失败`, body: text });
      return text;
    } finally {
      // 工具交回后模型接着生成：状态行切回"生成中"，不清空（否则中途一片空白）
      this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
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
    // 从收到指令那一刻就开始计时：避免冷启动/首 token 期间界面完全静默
    this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
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
      // 本轮结束：状态行必须收掉，不能留一个永远在走的计时器
      this.setTurn({ activity: undefined, activityName: undefined, activityAt: undefined });
    }
  }

  /** 直连降级路径：Pi 不可用时仍可用（原实现保留） */
  private async runChatDirect(cfg: NonNullable<ReturnType<SettingsStore["getModel"]>>, apiKey: string): Promise<void> {
    // 软上限降级（M2-11）：达软限且有备用模型就换；没有就如实提示继续用（不静默停机）
    const budget = evaluateBudget(this.usage.sessionIn + this.usage.sessionOut, this.settings.getPrefs().softBudgetTokens);
    const picked = pickModel(cfg, this.settings.getPrefs().fallbackModel, budget.mode);
    if (picked.note) this.card({ kind: "system", badge: "工具", title: "预算提示", body: picked.note });
    const usedModel = picked.model;
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
    const patchLive = (text: string, streaming: boolean) => {
      live.text = text;
      live.streaming = streaming;
      const now = Date.now();
      if (streaming && now - this.lastDeltaEmit >= DELTA_FRAME_MS) {
        this.lastDeltaEmit = now;
        // cardId 必须带：渲染层只认带 cardId 的 delta，否则降级路径等于没有流式
        this.notify({ type: "delta", text, cardId: live.id });
      }
    };
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt() }, ...this.history];
    try {
      for (let round = 0; round < 8; round++) {
        let roundText = "";
        const result = await streamChat({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: usedModel,
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
        // 按次记账（M2-11）+ 软上限检查（达限提示/可切备用模型；不静默停机）
        appendUsage(this.dataRoot, { at: new Date().toISOString(), kind: "turn", in: result.promptTokens, out: result.completionTokens, model: usedModel });
        this.checkBudget();
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
    } finally {
      this.setTurn({ activity: undefined, activityName: undefined, activityAt: undefined });
    }
  }

  /** 提交一轮：卡片 + 落史 + 回合状态 + 结束后排水（排队输入） */
  private submitTurn(text: string, att?: TurnAttachments): void {
    // 技能激活（M2-10）：每轮按输入重算，命中后 allowed-tools 强制到工具门禁
    this.activateSkillsFor(text);
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
      // 成员卡必须是"现场"而不是"档案"：状态/预算/打回都从真实指派推导，
      // 原先这里写死 status:"idle"、budgetUsed:0、rejections:0，右栏永远显示空闲
      const allTasks = this.taskStore.list();
      const members = this.teamStore
        .listMembers(entry.name)
        .map((p, i) => {
          const key = `${entry.name}::${p.name}`;
          const runningTask = this.memberActive.get(key);
          const mine = allTasks
            .filter((t) => t.teamId === entry.name && t.member === p.name)
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
          const activeTask = mine.find((t) => t.status !== "done" && t.status !== "canceled") ?? mine[0];
          const status: MemberStatus = runningTask
            ? "running"
            : activeTask?.status === "in_review"
              ? "delivered"
              : activeTask?.status === "blocked" || activeTask?.status === "in_progress"
                ? "stuck"
                : "idle";
          // 本单实际授权（B3）：从最近一条派单记录读回 min(模板, 分配)；没有派单记录就用岗位模板
          let effectiveTools: string[] | undefined;
          if (activeTask) {
            const assigns = this.teamStore.readAssignments(entry.name, activeTask.id);
            for (let i = assigns.length - 1; i >= 0; i--) {
              const tools = effectiveToolsOf(assigns[i]);
              if (tools) {
                effectiveTools = tools;
                break;
              }
            }
          }
          return {
            name: p.name,
            role: p.role,
            goal: p.goal,
            status,
            statusNote: p.goal,
            // 只有真在跑才给进度；空闲时归零，别留着上次的 100%
            progress: runningTask ? this.memberProgress.get(p.name) ?? 0 : 0,
            budgetUsed: Math.round((this.memberUsage.get(key) ?? 0) / 1000),
            budgetTotal: Math.round(p.limits.budgetTokens / 1000),
            rejections: activeTask?.rejectRounds ?? 0,
            rejectionLimit: activeTask?.rejectLimit ?? 3,
            toolWhitelist: p.tools,
            effectiveTools,
            color: this.teamColor(i),
            model: p.model,
            turnLimit: p.limits.maxTurns,
          };
        });
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
            threadId: task.threadId,
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
      case "app.info": {
        // 内核构建时间：__filename 是编译产物 dist/main/kernel.js，mtime 就是这次构建的时刻
        let buildAt = "";
        try {
          buildAt = fs.statSync(__filename).mtime.toISOString();
        } catch {
          /* 打包进 asar / 只读介质时拿不到 mtime：返回空串，前端只判断"方法在不在" */
        }
        return { buildAt } as RpcContracts[M]["result"];
      }

      case "session.snapshot": {
        const cfg = this.settings.getModel();
        // C3：会话 → 工单归属计数（按 task.threadId 汇总；老单没记 threadId 就不归到任何会话，不猜）
        const threadCounts = countTasksByThread(this.taskStore.list());
        const snap: RpcContracts["session.snapshot"]["result"] = {
          workspace: { project: path.basename(this.projectRoot), subdir: "指挥台" },
          thread: {
            id: this.currentThreadId,
            title: this.threads.get(this.currentThreadId)?.title ?? "新会话",
          },
          threads: this.threads
            .list()
            .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, counts: threadCounts.get(t.id) })),
          // 真在跑的成员单：台账"进行中"不等于在跑（卡住/停机也会留在 in_progress 历史里）
          running: this.runningTaskIds(),
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

      case "providers.presets": {
        return { presets: PRESETS } as RpcContracts[M]["result"];
      }

      case "providers.list": {
        const { providers, error } = loadProviders(this.dataRoot);
        return {
          providers: providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models ?? [] })),
          ...(error ? { error } : {}),
        } as RpcContracts[M]["result"];
      }

      case "providers.save": {
        const { providers } = params as { providers: ProviderEntry[] };
        saveProviders(this.dataRoot, providers ?? []);
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "calendar.add": {
        const { text, remindLead } = params as { text: string; remindLead?: number };
        const parsed = parseNaturalDate(text);
        if (!parsed) {
          return {
            ok: false,
            error: `没识别出时间。支持的写法如：明天下午三点、下周三 14:00、3月5号上午九点、两小时后。`,
          } as RpcContracts[M]["result"];
        }
        const title = parsed.rest || text.trim();
        const ev = this.calendar.addEvent(title, parsed.at, Math.max(0, Number(remindLead ?? 0)));
        return {
          ok: true,
          event: { id: ev.id, title: ev.title, at: ev.at },
          matched: parsed.matched,
          defaultedTime: parsed.defaultedTime,
        } as RpcContracts[M]["result"];
      }

      case "calendar.list": {
        const { includePast } = params as { includePast?: boolean };
        const events = this.calendar.listEvents({ includePast }).map((e) => ({
          id: e.id,
          title: e.title,
          at: e.at,
          status: e.status,
        }));
        return { events, backend: this.calendar.backend } as RpcContracts[M]["result"];
      }

      case "calendar.finish": {
        const { id, status } = params as { id: number; status?: "done" | "canceled" };
        this.calendar.finishEvent(Number(id), status === "canceled" ? "canceled" : "done");
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "calendar.todo.add": {
        const { text } = params as { text: string };
        const t = this.calendar.addTodo(String(text).trim());
        return { ok: true, id: t.id } as RpcContracts[M]["result"];
      }

      case "calendar.todo.list": {
        const todos = this.calendar.listTodos().map((t) => ({ id: t.id, text: t.text, due: t.due }));
        return { todos } as RpcContracts[M]["result"];
      }

      case "calendar.todo.finish": {
        const { id } = params as { id: number };
        this.calendar.finishTodo(Number(id));
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "calendar.scan": {
        this.scanReminders();
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "schedule.tick": {
        this.tickSchedules();
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "schedule.add": {
        const p = params as { name: string; prompt: string; kind: "once" | "daily" | "interval"; at?: string; time?: string; intervalMin?: number };
        try {
          const task = this.scheduler.add({
            name: String(p.name).trim() || "未命名任务",
            prompt: String(p.prompt),
            kind: p.kind,
            at: p.at,
            time: p.time,
            intervalMin: p.intervalMin,
          });
          return { ok: true, task: { id: task.id, name: task.name, nextRun: task.nextRun } } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "schedule.list": {
        return {
          tasks: this.scheduler.list().map((t) => ({
            id: t.id,
            name: t.name,
            kind: t.kind,
            enabled: t.enabled,
            nextRun: t.nextRun,
            lastRun: t.lastRun,
            lastStatus: t.lastStatus,
          })),
        } as RpcContracts[M]["result"];
      }

      case "schedule.remove": {
        const { id } = params as { id: string };
        return { ok: this.scheduler.remove(String(id)) } as RpcContracts[M]["result"];
      }

      case "schedule.toggle": {
        const { id } = params as { id: string };
        const t = this.scheduler.toggle(String(id));
        if (!t) return { ok: false, error: `没有这个定时任务：${id}` } as RpcContracts[M]["result"];
        return { ok: true, enabled: t.enabled } as RpcContracts[M]["result"];
      }

      case "kb.search": {
        const { q, limit } = params as { q: string; limit?: number };
        const { hits, error } = this.knowledge.search(String(q ?? ""), Math.min(50, Math.max(1, Number(limit ?? 8))));
        return { hits, ...(error ? { error } : {}) } as RpcContracts[M]["result"];
      }

      case "kb.list": {
        return { docs: this.knowledge.list(), backend: this.knowledge.backend } as RpcContracts[M]["result"];
      }

      case "kb.read": {
        const { file } = params as { file: string };
        const doc = this.knowledge.read(String(file));
        if (!doc) return { ok: false, error: `文档不存在：${file}` } as RpcContracts[M]["result"];
        return { ok: true, title: doc.title, body: doc.body } as RpcContracts[M]["result"];
      }

      case "kb.reindex": {
        const { indexed, removed } = this.knowledge.reindex();
        const st = this.knowledge.stats();
        return { indexed, removed, docs: st.docs, dbBytes: st.dbBytes } as RpcContracts[M]["result"];
      }

      case "office.health": {
        return { ...this.officeHealth, csv: true, xlsx: this.officeHealth.found } as RpcContracts[M]["result"];
      }

      case "task.cancel": {
        const { taskId } = params as { taskId: string };
        return this.cancelMemberTask(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.cancelAll": {
        // C4：新会话提示卡上的一键止损；逐张停，失败的不假装成功（计数如实）
        const ids = [...this.memberRuns.keys()];
        let stopped = 0;
        for (const id of ids) {
          if (this.cancelMemberTask(id).ok) stopped += 1;
        }
        return { ok: true, stopped } as RpcContracts[M]["result"];
      }

      case "task.dismiss": {
        const { taskId } = params as { taskId: string };
        return this.dismissTask(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.remove": {
        const { taskId } = params as { taskId: string };
        return this.removeTask(String(taskId)) as RpcContracts[M]["result"];
      }

      // 建团队（§4.10.3 修正）：界面上给名字就够，ID 由系统生成
      case "team.create": {
        const { name } = params as { name?: string };
        try {
          const created = this.tools.createTeam(name ? String(name) : undefined);
          this.card({ kind: "system", text: `已建团队「${created.name}」（ID ${created.id}）。` });
          return { ok: true, id: created.id, name: created.name } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      // 模板导出/导入（M2-15）：第三方岗位说明白名单只收窄
      case "team.exportTemplate": {
        const { name, outFile } = params as { name: string; outFile: string };
        return this.teamStore.exportTemplate(String(name), String(outFile)) as RpcContracts[M]["result"];
      }

      case "team.importTemplate": {
        const { json } = params as { json: string };
        try {
          const { proposal, commit } = this.teamStore.importTemplate(String(json), MEMBER_EXEC_TOOLS);
          // 导入默认落库（commit）——提案与告警如实回显，用户在设置页可删
          const committed = commit();
          return { ok: true, name: committed.name, members: committed.members, proposal } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
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
            // 契约一确认就从右栏消失，目标/验收/截止不该跟着没：落一张带 jobId 的卡，
            // 图纸「往来」能回看，跨会话的 task.feed 也读得到
            this.card({
              kind: "tool",
              badge: "派单",
              title: `${plan.member} · ${plan.taskId} · 契约`,
              jobId: plan.taskId,
              body: [
                `目标：${d.plan?.goal ?? plan.brief.split("\n")[0] ?? ""}`,
                `验收：${(d.plan?.acceptance ?? []).join("；") || "（未写）"}`,
                `截止：${d.plan?.deadline ?? plan.deadline}`,
                `团队：${plan.teamId}`,
              ].join("\n"),
            });
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

      // ---------- M3-07 插件工坊（§4.11）：草稿 → 准入 → 启用 ----------
      case "workshop.create": {
        const p = params as { title: string; kind: WorkshopKind; spec: string; taskId?: string };
        try {
          return createDraft(this.dataRoot, p) as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }
      case "workshop.list": {
        return {
          drafts: listDrafts(this.dataRoot).map((d) => ({
            draftId: d.draftId,
            title: d.title,
            kind: d.kind,
            taskId: d.taskId,
            createdAt: d.createdAt,
            status: d.status,
          })),
        } as RpcContracts[M]["result"];
      }
      case "workshop.review": {
        const p = params as { draftId: string };
        try {
          return reviewDraft(this.dataRoot, p.draftId, {
            pluginIds: this.pluginHost.scan().plugins.map((x) => x.id),
            skillNames: this.skillEntries.map((s) => s.name),
          }) as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }
      case "workshop.promote": {
        const p = params as { draftId: string; byUser: boolean };
        try {
          const r = promoteDraft(this.dataRoot, p.draftId, p.byUser);
          if (r.tier === "L0") this.reloadSkills();
          this.card({
            kind: "system",
            text:
              r.tier === "L0"
                ? `L0 技能插件「${r.id}」已启用（${r.byUser ? "用户确认" : "风铃自启用，已记审计"}）。`
                : `「${r.id}」已入库（${r.tier}）。默认影子态：在插件面板点「启用」才进全局工具面。`,
          });
          return { ok: true, ...r } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }
      case "workshop.discard": {
        const p = params as { draftId: string };
        try {
          discardDraft(this.dataRoot, p.draftId);
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
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
        const p = params as { autoStart: boolean; trayOnClose?: boolean; notify?: boolean; softBudgetTokens?: number; fallbackModel?: string; lang?: "zh" | "en" };
        if (p.lang !== undefined && !isLang(p.lang)) {
          return { ok: false, error: `未知语言：${String(p.lang)}（只支持 zh / en）` } as unknown as RpcContracts[M]["result"];
        }
        const saved = this.settings.savePrefs({
          autoStart: Boolean(p.autoStart),
          ...(p.trayOnClose !== undefined ? { trayOnClose: Boolean(p.trayOnClose) } : {}),
          ...(p.notify !== undefined ? { notify: Boolean(p.notify) } : {}),
          ...(p.softBudgetTokens !== undefined ? { softBudgetTokens: Math.max(0, Number(p.softBudgetTokens) || 0) } : {}),
          ...(p.fallbackModel !== undefined ? { fallbackModel: String(p.fallbackModel).trim() } : {}),
          ...(p.lang !== undefined ? { lang: p.lang } : {}),
        });
        return {
          ok: true,
          autoStart: saved.autoStart,
          trayOnClose: saved.trayOnClose,
          notify: saved.notify,
          softBudgetTokens: saved.softBudgetTokens,
          fallbackModel: saved.fallbackModel,
          lang: saved.lang,
        } as RpcContracts[M]["result"];
      }

      // M3-08：界面语言字典——内置（zh 源语言 / en 渐进）⊕ 启用的语言包插件覆盖
      case "i18n.get": {
        const lang = this.settings.getPrefs().lang;
        let strings: Record<string, string> = { ...BUILTIN_STRINGS.zh };
        if (lang === "en") strings = mergeStrings(strings, BUILTIN_STRINGS.en);
        const sources: string[] = [];
        for (const p of this.pluginHost.scan().plugins) {
          if (!p.enabled || !p.langs) continue;
          for (const pack of p.langs) {
            if (pack.lang !== lang) continue;
            strings = mergeStrings(strings, pack.strings);
            if (!sources.includes(p.id)) sources.push(p.id);
          }
        }
        return { lang, strings, sources } as RpcContracts[M]["result"];
      }

      case "config.clearKey": {
        return { ok: this.settings.clearApiKey() } as RpcContracts[M]["result"];
      }

      // 视觉/OCR 模型（M2-13）：与对话模型解耦，独立配置/探测/清除
      case "config.vision.get": {
        const v = this.settings.getVisionModel();
        return {
          configured: Boolean(v),
          provider: v?.provider,
          baseUrl: v?.baseUrl,
          model: v?.model,
          updatedAt: v?.updatedAt,
        } as RpcContracts[M]["result"];
      }

      case "config.vision.save": {
        const p = params as { provider: string; baseUrl: string; model: string; apiKey?: string };
        try {
          this.settings.saveVisionModel({
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey: p.apiKey,
            previous: this.settings.getVisionModel(),
          });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "config.vision.clear": {
        return { ok: this.settings.clearVision() } as RpcContracts[M]["result"];
      }

      // 消息平台（M2-16）：合规口径与状态在 handle；configure/send 是异步网络操作，在壳层（main.ts）
      case "msg.status": {
        const cfg = loadMessaging(this.dataRoot);
        const view = (c?: ChannelConfig) =>
          c ? { appId: c.appId, enabled: c.enabled, updatedAt: c.updatedAt } : null;
        return {
          compliance: COMPLIANCE_NOTE,
          feishu: view(cfg.feishu),
          qq: view(cfg.qq),
          receiveSupported: false,
        } as RpcContracts[M]["result"];
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

      case "task.feed": {
        // 换会话后旧工单的往来：先按 threadId 回原会话读；老数据没记的，扫一遍线程兜底
        const p = params as { taskId: string };
        const owner = this.taskStore.get(p.taskId)?.threadId;
        if (owner) {
          return {
            cards: this.threads.loadState(owner).feed.filter((c) => c.jobId === p.taskId),
            threadId: owner,
            threadTitle: this.threads.get(owner)?.title,
          };
        }
        for (const meta of this.threads.list()) {
          const cards = this.threads.loadState(meta.id).feed.filter((c) => c.jobId === p.taskId);
          if (cards.length) return { cards, threadId: meta.id, threadTitle: meta.title };
        }
        return { cards: [] } as RpcContracts[M]["result"];
      }

      case "session.new": {
        // 新对话 = 新线程：旧会话留在磁盘上可切回，不再清空历史
        this.persistThread();
        const meta = this.threads.create("新会话");
        // C4：切走前把还在跑的单记下来——用户以为"从头开始"，后台其实还在烧预算、还可能弹审批
        const running = [...this.memberRuns.keys()];
        this.switchThread(meta.id);
        try {
          fs.rmSync(this.timelineFile, { force: true });
          this.contextStore.clear();
        } catch {
          // 忽略
        }
        const notice = newSessionNotice(running);
        this.card({ kind: "system", text: notice.text, ...(notice.action ? { action: notice.action } : {}) });
        return { ok: true, threadId: meta.id } as RpcContracts[M]["result"];
      }

      default:
        throw new Error(`unknown rpc method: ${method as string}`);
    }
  }
}
