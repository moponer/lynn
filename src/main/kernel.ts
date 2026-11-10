import * as fs from "node:fs";
import * as os from "node:os";
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
import { SettingsStore, loadApiKey, defaultDataRoot, type StoredModelConfig } from "./settings";
import { applyPiEnvironment } from "./pi-home";
import { reapOrphanWorkers } from "./agent-orphans";
import { McpRegistry, loadMcpConfig, loadMcpConfigAt, type McpServerConfig } from "./mcp";
import { CheckpointStore } from "./checkpoints";
import { measureUsage, runCleanup, type Retention } from "./cleanup";
import { buildZip, collectZipEntries, type ZipEntry } from "./zip";
import { TrustStore } from "./trust";
import { ThreadStore, type ThreadMeta } from "./threads";
import { buildTurnAttachments, searchProjectFiles, type TurnAttachments } from "./attachments";
import { isCaptureHotkey } from "./capture";
import { PersonaStore, composeSystemPrompt } from "./persona";
import { MemoryStore, type MemoryKind } from "./memory";
import { PRESETS, loadProviders, saveProviders, type ProviderEntry } from "./providers";
import { CalendarStore, dueReminders, parseNaturalDate } from "./calendar";
import { SchedulerStore, recover as recoverScheduler, type DueItem } from "./scheduler";
import { KnowledgeStore, watchKnowledge } from "./knowledge";
import { appendUsage, evaluateBudget, pickModel } from "./budget";
import { groupOf } from "../shared/task-groups";
import { avatarById, avatarFor, isAvatarId } from "../shared/avatars";
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
import { BUILTIN_SKILLS } from "./builtin-skills";
import {
  addRoot,
  emptyRoots,
  forbiddenRootReason,
  isDriveRoot,
  isInside,
  normalizeRoots,
  primaryOf,
  readableRoots,
  removeRoot,
  rootDirError,
  rootsFromLegacy,
  writableRoots,
  type RootSet,
} from "./roots";
import { BUILTIN_STRINGS } from "../shared/i18n-strings";
import { TaskStore } from "./task-store";
import type { DeliverableRef, TaskRecord, TaskWorkspaceRecord } from "./task-store";
import { TaskCase } from "./task-case";
import { ContextStore } from "./context-store";
import { scanUiPlugins } from "./ui-plugins";
import { PluginHost } from "./plugin-host";
import { PluginSetStore } from "./plugin-set";
import { runMemberTask, validateBrief, MEMBER_EXEC_TOOLS, type MemberRunResult } from "./member-runner";
import { collectHeartbeatFacts, heartbeatSignature, heartbeatIsEmpty, heartbeatPrompt, type HeartbeatFacts } from "./heartbeat";
import { L1Host } from "./plugin-l1";
import { AgentHost, type AgentStats, type RpcToolSpec } from "./agent-host";
import { PiRpcHost } from "./pi-rpc-host";

/** 两种运行时宿主都要满足的最小面：官方 RPC 为主，旧自建协议仅作一键回退 */
interface RuntimeHost {
  isRunning(): boolean;
  isBusy(): boolean;
  readonly sessionId: string | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(text: string): Promise<{ disposition?: string }>;
  steer(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  stats(): Promise<AgentStats | null>;
  updateSystemPrompt(text: string): void | Promise<void>;
  request<T>(type: string, data?: Record<string, unknown>): Promise<T>;
  getStderr(): string;
}

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
/** 这类卡片是"重复事件"（权限拦截 / 外呼审计）：同一张单反复出现就聚合计数，不逐条刷屏 */
const AGGREGATED_BADGES = new Set(["已拦截", "出站"]);

const TOOL_JSON: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "create_team",
      description:
        "建一个团队（不需要先有团队）。只需给一个人类可读的名字，团队 ID 由系统生成并返回给你——绝不要向用户索要 ID。团队名跟任务走：用任务主题命名（如「Q3订单数据核对」），不要起花哨代号。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "团队名（人类可读，以任务主题命名，例如「Q3订单数据核对」）；省略则用任务标题" },
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
          goal: { type: "string", description: "单一职责：这个岗位对什么产出负责（写「负责什么结果」，不写「会做什么」）" },
          boundaries: { type: "array", items: { type: "string" } },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "执行类工具白名单，只能填这些真实工具名：read_file / write_file / list_dir / run_command / browser_navigate / browser_snapshot / browser_click / browser_fill / browser_extract / browser_close / office_read_table / office_write_table / kb_add",
          },
          deliverable: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          avatarId: { type: "string", description: "头像库 id（a01…a12，可省略：系统按名字自动挑一张本队没用过的）" },
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
        "向成员派单。成员只拿到简报包，看不到你们的对话，所以简报必须自足：按四段写【目标】【完成标准】【材料与位置】【限制】，缺了会被代码层退回重写。委托目标或材料位置不明确时先用 ask_user 问清用户，不要猜着派单。**一条任务线一支团队**：不传 teamId 时，新会话会新建团队（不会塞进上一条任务的班底）；要沿用旧班底必须显式传 teamId 并说明理由。多个任务并行时一任务一团队可以，但要先把任务清单（各派给谁、多久）告诉用户。",
      parameters: {
        type: "object",
        required: ["taskId", "member", "brief", "deadline"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          teamName: { type: "string", description: "需要自动建队时用的团队名（可选；以任务主题命名，不要花哨代号）" },
          taskId: { type: "string" },
          member: { type: "string" },
          brief: {
            type: "string",
            description:
              "简报包（四段，缺会被退回）：【目标】产出什么；【完成标准】可验证的验收点；【材料与位置】输入材料的完整路径（关键内容能贴进简报就贴，别让成员去猜）；【限制】不许做什么、范围与口径",
          },
          deadline: { type: "string", description: "具体时间（如「2026-11-10 18:00」「2小时后」），不要写「尽快」" },
          tools: { type: "array", items: { type: "string" }, description: "本次分配工具集，必须 ⊆ 岗位白名单" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（可验证；写进任务契约，用户点开始后生效）" },
          workspace: {
            type: "string",
            description:
              "成员的读写工作目录（可选，须是已存在的目录）。缺省 = 当前会话的项目目录。用户会在契约卡上看到并批准",
          },
          readRoots: {
            type: "array",
            items: { type: "string" },
            description:
              "成员需要**只读**访问的目录清单（可选，须是已存在的目录）。材料在工作区外时填这个申请授权——用户在契约卡上批准后才生效，你不能自己扩权",
          },
          maxTurns: { type: "number", description: "轮次上限覆盖（可选，1–40；缺省用岗位档案上限）。任务量大就给足，别让成员中途被掐断" },
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
      name: "nudge_member",
      description:
        "给**正在跑**的成员补一句指示（下一轮生效，不用重派、不丢已写文件）。用于纠正方向、划清边界（例如「你只能访问任务工作区，别再去读 F:\\\\spiker」）、要求先交阶段性回报。",
      parameters: {
        type: "object",
        required: ["taskId", "note"],
        properties: {
          taskId: { type: "string" },
          note: { type: "string", description: "一句话说清：改什么 / 先交什么 / 别再做什么" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_task",
      description:
        "停掉一张在跑的单：成员收手，工单转「卡住」等你决定。用于明显卡死、反复越界、方向已错——不要让它一直烧预算。",
      parameters: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" },
          reason: { type: "string", description: "为什么停（会记进卷宗与卡）" },
        },
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
      name: "save_memory",
      description:
        "沉淀记忆（M2-05）：把一条事实/决定/坑/做事方法写进助理记忆（跨会话都在你的系统提示词里）。完成任务后的经验教训、用户偏好、项目的关键路径都该沉淀。scope=user 表示写「用户记忆」（偏好/背景，永远保留）。",
      parameters: {
        type: "object",
        required: ["entry"],
        properties: {
          entry: { type: "string", description: "一条具体的事实（一句话，含上下文；不要写流水账）" },
          scope: { type: "string", enum: ["memory", "user"], description: "缺省=助理记忆；user=用户记忆（偏好/背景）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plugin_draft",
      description:
        "开一张插件工坊草稿（M3-07）：当你发现某类任务会重复出现、值得沉淀成插件时，先用这个开草稿，再派插件工程师（workspace 填返回的草稿目录）把产物写进草稿区，最后 ship_plugin 走准入审查。档位选型：能用 L0（纯声明：主题/文案/静态卡槽）不写代码，能用 MCP 不进进程。开发与验收标准见 plugin-dev 技能。",
      parameters: {
        type: "object",
        required: ["title", "kind", "spec"],
        properties: {
          title: { type: "string", description: "插件名（人类可读，如「周报图表卡」）" },
          kind: { type: "string", enum: ["L0", "L1", "L2"], description: "档位：L0 纯声明零代码；L1 进程内 TS 扩展；L2 外挂 MCP server" },
          spec: {
            type: "string",
            description: "规格：解决什么、输入输出、边界（不许做什么）、最小权限集、验收用例。成员只能看到规格，要写全",
          },
        },
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
  /** 用户在契约卡上批准的成员读写工作区（缺省 = 会话项目目录） */
  workspace?: string;
  /** 派单时申请、用户点开始才生效的只读授权目录 */
  readRoots?: string[];
  /** 轮次上限覆盖（1–40） */
  maxTurns?: number;
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

/**
 * 指挥者巡检判定（纯函数，便于单测）：哪张单该让风铃主动跟进、为什么。
 * 触发：①成员 3 分钟没有任何动作；②被边界拦下 ≥3 次（在撞墙，做的是做不到的事）。
 * 每张单 10 分钟内最多跟进一次；命中就返回一条可直接注入的说明。
 */
export function supervisorCase(
  runs: { taskId: string; member: string; quietMs: number; blocked: number; lastStep?: string }[],
  now: number,
  noted: Map<string, number>,
  opts: { quietMs?: number; blockedLimit?: number; cooldownMs?: number } = {},
): { taskId: string; member: string; text: string } | null {
  const quietLimit = opts.quietMs ?? 180_000;
  const blockedLimit = opts.blockedLimit ?? 3;
  const cooldown = opts.cooldownMs ?? 10 * 60_000;
  const candidates = runs
    .filter((r) => now - (noted.get(r.taskId) ?? 0) >= cooldown)
    .sort((a, b) => b.quietMs - a.quietMs);
  for (const r of candidates) {
    if (r.blocked >= blockedLimit) {
      return {
        taskId: r.taskId,
        member: r.member,
        text: `${r.member} 跑 ${r.taskId} 时被边界拦下 ${r.blocked} 次（它只能动任务工作区），最后一步：${r.lastStep ?? "无"}。它大概率在做做不到的事。`,
      };
    }
    if (r.quietMs >= quietLimit) {
      return {
        taskId: r.taskId,
        member: r.member,
        text: `${r.member} 跑 ${r.taskId} 已经 ${Math.round(r.quietMs / 1000)}s 没有任何动作，最后一步：${r.lastStep ?? "无"}。`,
      };
    }
  }
  return null;
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
  /** 成员最近一步动作（`teamId::成员` → 文本）：右栏与任务总览要能回答"现在在干什么" */
  private memberLastStep = new Map<string, string>();
  /** 成员收件箱（taskId → 待发指示）：风铃中途催办，不必杀掉重跑 */
  private memberInbox = new Map<string, string[]>();
  /** 每张单最近一步的时间戳与"被边界拦下"的次数：巡检据此判"没动静"与"在撞墙" */
  private memberStepAt = new Map<string, number>();
  private memberBlocked = new Map<string, number>();
  /** 指挥者巡检：定时器与节流（不催也管） */
  private supervisorTimer: NodeJS.Timeout | null = null;
  private lastSupervisorAt = 0;
  private supervisorNoted = new Map<string, number>();
  /** 本轮技能注入文本（当轮消息尾部拼接；不进 system prompt —— 保前缀缓存稳定） */
  private pendingSkillText = "";
  /** 心跳巡检（M3-01）：定时器、节流与同批事实去重 */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt = Date.now(); // init 后先静默一个间隔，不抢启动窗口
  private heartbeatNoted = new Map<string, number>();
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
  private host: RuntimeHost | null = null;
  private hostStamp = "";
  /** 流式中的她：runChat 里增量 patch */
  private liveCard: FeedCard | null = null;
  /**
   * 上一次推 delta 事件的时间。按帧节流（~16ms）而不是按"人能看清"的 80ms：
   * 合并交给渲染层 rAF（蓝本 tether-ai 的做法），主进程只做去抖，不做降帧。
   */
  private lastDeltaEmit = 0;
  /** 本轮是否已就模型错误落过卡（Pi 重试时可能连发多条 message_end，别刷屏） */
  private turnErrorReported = false;

  /** 回合状态（唯一真相源，渲染层只读） */
  private turn: TurnState = { phase: "idle", busy: false, pending: 0 };
  /** 用量读数（RPC 路径由 Pi 的 getSessionStats 提供） */
  private usage: UsageView = {
    turnIn: 0,
    turnOut: 0,
    sessionIn: 0,
    sessionOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    contextWindow: 128_000,
    contextPercent: null,
  };
  /** 排队输入（生成中打字） */
  private queue: QueuedInput[] = [];
  private queueSeq = 0;
  /** 待确认的任务契约（decisionId → 派单上下文） */
  private pendingPlans = new Map<string, PendingPlan>();
  /** 最近一次「任务契约已呈给用户」的时间：用来挡"派完单又问一遍是否开工" */
  private lastPlanAt = 0;
  /**
   * 等你批准的请求（decisionId → 决议器）。
   * `kind: "delete"` 是成员删除文件：切权限档批量放行时**不能**顺带批准它（删除要单独点头）。
   */
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void; kind?: "tool" | "delete" }>();
  /** L2 MCP 工具（mcp__server__tool） */
  private mcp = new McpRegistry();
  /** 盯 mcp.json 的 watcher：保存即重连，不用重启应用 */
  private mcpWatchers: fs.FSWatcher[] = [];
  private mcpReloadTimer: NodeJS.Timeout | null = null;
  /** 串行化重载：两次 stopAll/startAll 交错会把客户端表搅乱 */
  private mcpReloadChain: Promise<void> = Promise.resolve();
  /** 逐轮文件检查点（M1-12） */
  private checkpoints!: CheckpointStore;
  /** 项目信任（M1-13）：决定项目级 mcp.json 能不能注入工具 */
  private trust!: TrustStore;
  /**
   * 当前会话的主根镜像（可写）。空串 = 这次会话没有主根（临时任务，产出落任务卷宗）。
   * 真正的真相是 `roots`；保留这个字段是为了少改调用点，新增代码请用 roots。
   */
  private projectRoot = "";
  /** 当前会话的根集合（2026-11-10）：主根 + 附加只读/可写根 */
  private roots: RootSet = emptyRoots();
  /** 默认工作区：设置 > LYNN_PROJECT_DIR > 平台默认（GUI 没有 cwd 可依） */
  private defaultWorkspace = "";
  /** 多会话线程（M1-14）：列表/状态持久化 + 当前线程 id */
  private threads!: ThreadStore;
  /** 当前会话 id；空串 = 一条会话都没有（用户把最后一条也删了），空场是合法状态 */
  private currentThreadId = "";
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
    this.defaultWorkspace = this.resolveDefaultWorkspace();
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
    this.migrateThreadRoots();
    const list = this.threads.list();
    // 全新安装（还没有会话索引）给一条默认会话；索引存在但为空 = 用户把会话删光了，
    // 必须保持空场，不能重启一次就偷偷补回一条同名的「新会话」。
    const indexFile = path.join(dataRoot, "threads", "index.json");
    const defaultRoots: RootSet = { primary: this.defaultWorkspace, extras: [] };
    const current = list[0] ?? (fs.existsSync(indexFile) ? null : this.threads.create("新会话", defaultRoots));
    this.currentThreadId = current?.id ?? "";
    this.ensureDefaultWorkspace();
    this.applyRoots(this.rootsForThread(current));
    this.reloadSkills();
    const st = this.currentThreadId ? this.threads.loadState(this.currentThreadId) : { feed: [], history: [] };
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
      // 撞墙计数：巡检据此判断"它在做做不到的事"（而不是单纯慢）
      this.memberBlocked.set(taskId, (this.memberBlocked.get(taskId) ?? 0) + 1);
      this.cardTo(threadId, {
        kind: "tool",
        badge: "已拦截",
        jobId: taskId,
        title: `${member} · ${taskId}`,
        // 越界被拦不是"成员出错"，是边界在生效：说清它能动哪儿，别让用户以为卡死了
        body: `命令被纵深防御规则拦下：${ev.why}\n${ev.command}\n\n成员只能在自己的工作区（派单时钉住的目录）里读写。要查别处，把材料复制进工作区，或右键这张单「授权只读访问某个目录」。`,
      });
    } else if (ev.kind === "cmd_net") {
      this.cardTo(threadId, { kind: "tool", badge: "出站", jobId: taskId, title: `${member} · ${taskId}`, body: `出站命令已审计：${ev.command}` });
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
    // 同一张单反复出同一种事件（权限拦截 / 外呼审计）：聚合成一张卡计数，不再一屏刷 N 条
    if (AGGREGATED_BADGES.has(c.badge ?? "") && this.feed.length > 0) {
      const last = this.feed[this.feed.length - 1];
      if (last.badge === c.badge && last.jobId === c.jobId) {
        return this.bumpBlocked(last, c);
      }
    }
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

  /** 拦截聚合：计数 +1，原因/命令换成最近一次（用户要看的是"现在为什么还被拦"） */
  private bumpBlocked(last: FeedCard, c: Omit<FeedCard, "id" | "createdAt">): FeedCard {
    this.patchCard(last, {
      count: (last.count ?? 1) + 1,
      body: c.body,
      createdAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    });
    return last;
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
  private cardTo(threadId: string, c: Omit<FeedCard, "id" | "createdAt">): FeedCard {
    // 会话已被删（删会话会级联清工单，后台成员回报可能随后才到）：
    // 再 saveState 会把 <threadId>.json 重新造出来，变成 index 里没有、界面永远看不见的孤儿文件。
    // 退回当前会话，至少这条信息不丢。
    if (!threadId || threadId === this.currentThreadId || !this.threadExists(threadId)) {
      return this.card(c);
    }
    const st = this.threads.loadState(threadId);
    // 跨会话同样聚合：别让某一栏被同一种事件刷成几十行
    if (AGGREGATED_BADGES.has(c.badge ?? "") && st.feed.length > 0) {
      const last = st.feed[st.feed.length - 1];
      if (last.badge === c.badge && last.jobId === c.jobId) {
        last.count = (last.count ?? 1) + 1;
        last.body = c.body;
        last.createdAt = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        this.threads.saveState(threadId, { feed: st.feed.slice(-200), history: st.history });
        this.notify({ type: "thread", threadId });
        return last;
      }
    }
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
    return full;
  }

  /** 会话索引里还有没有这个 id（写卡前的存活判定，防止给已删会话重建文件） */
  private threadExists(id: string): boolean {
    return this.threads.list().some((t) => t.id === id);
  }

  /** 同一张卡在别的会话里的状态更新（成员开工卡 → 回报/未完成） */
  private patchCardTo(threadId: string, card: FeedCard, patch: Partial<FeedCard>): void {
    if (!threadId || threadId === this.currentThreadId || !this.threadExists(threadId)) {
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

  /**
   * system prompt（M1-17/M2-05）：固定头 + persona + 记忆两层 + 安全尾段；每轮现取。
   * 技能注入**不再拼在这里**（原来按当轮输入重算，命中集一变整段 system prompt + 全部历史
   * 的前缀缓存就废）；改为当轮消息尾部注入（见 pendingSkillText / activateSkillsFor），
   * 前缀保持稳定，技能抖动只影响尾部。
   */
  private systemPrompt(): string {
    return composeSystemPrompt(this.persona.load()) + this.memory.systemPromptSection();
  }

  // ---------- 当前生效模型（每对话覆盖 > 全局默认） ----------

  private decryptBlob(blob: Buffer): string {
    return this.decryptor ? this.decryptor(blob) : blob.toString("utf-8");
  }

  /** 线程单独指定过模型就优先用；删掉的模型会自动回落到全局默认 */
  private activeModelId(): string | undefined {
    const id = this.threads.get(this.currentThreadId)?.modelId;
    return id && this.settings.getModels().some((e) => e.id === id) ? id : undefined;
  }

  private activeModelConfig(): StoredModelConfig | null {
    return this.settings.getModel(this.activeModelId());
  }

  private activeApiKey(): string | null {
    return loadApiKey(this.settings, (b) => this.decryptBlob(b), this.activeModelId());
  }

  /** 壳层读偏好（托盘/通知开关 M1-18、截图快捷键）：壳不直接碰 SettingsStore */
  getPrefs(): { autoStart: boolean; trayOnClose: boolean; notify: boolean; captureHotkey: string } {
    const p = this.settings.getPrefs();
    return { autoStart: p.autoStart, trayOnClose: p.trayOnClose, notify: p.notify, captureHotkey: p.captureHotkey };
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
    const hasProject = Boolean(this.projectRoot);
    const trusted = hasProject && (this.trust?.isTrusted(this.projectRoot) ?? false);
    const allRoots: { dir: string; level: SkillEntry["level"] }[] = [
      { dir: path.join(this.dataRoot, "skills"), level: "user" },
      ...(hasProject ? [{ dir: path.join(this.projectRoot, ".lynn", "skills"), level: "project" as const }] : []),
      { dir: path.join(this.dataRoot, "plugins"), level: "plugin" },
    ];
    const roots = allRoots.filter((r) => r.level !== "project" || trusted);
    const { entries, errors } = discoverSkills(roots);
    // 停用清单（用户在设置里关的技能）：不参与激活与 allowed-tools 强制
    const disabled = this.settings.getPrefs().disabledSkills ?? [];
    this.skillEntries = entries.filter((e) => !disabled.includes(e.name));
    for (const e of errors.slice(0, 5)) this.log("skill_error", { error: e });
    for (const e of entries) {
      for (const w of e.warnings.slice(0, 3)) this.log("skill_warning", { skill: e.name, warning: w });
    }
    this.log("skills_ready", { count: entries.length, projectTrusted: trusted });
  }

  /** 命中技能 → 本轮生效：注入预算内内容（拼在当轮消息尾部）+ allowed-tools 强制子集 */
  private activateSkillsFor(text: string): void {
    this.activeSkills = matchSkills(text, this.skillEntries);
    this.pendingSkillText = "";
    if (this.activeSkills.length) {
      const inj = buildInjection(this.activeSkills);
      if (inj.text) this.pendingSkillText = `【本轮技能（按需加载）】\n${inj.text}`;
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
    void Promise.resolve(this.host.updateSystemPrompt(this.systemPrompt()))
      .catch((err) => {
        this.card({
          kind: "system",
          text: `persona 已保存，但当前会话热更新失败：${err instanceof Error ? err.message : String(err)}。重启应用后生效。`,
        });
      });
    return true;
  }

  /**
   * 默认工作区（2026-11-10）：独立 GUI 没有 cwd 可依，必须显式给一个。
   * 优先级：设置 > 环境变量（兼容旧用法）> 平台默认。
   * 测试/隔离环境（LYNN_HOME）落到数据根内，绝不写用户的 home。
   */
  private resolveDefaultWorkspace(): string {
    const pref = this.settings.getPrefs().defaultWorkspace?.trim();
    if (pref) return path.resolve(pref);
    if (process.env.LYNN_PROJECT_DIR) return path.resolve(process.env.LYNN_PROJECT_DIR);
    // 隔离环境（单测传临时 dataRoot / LYNN_HOME）：默认工作区落在数据根内，
    // 绝不能因为跑一次测试就往用户 home 里建目录。
    const platformDefault = path.join(os.homedir(), ".lynn");
    if (path.resolve(this.dataRoot) !== path.resolve(platformDefault)) {
      return path.join(this.dataRoot, "workspace");
    }
    return path.join(os.homedir(), "LynnWorkspace");
  }

  /** 首次启动把默认工作区建出来并落进设置（之后不再推导，避免 home 变化后漂移） */
  private ensureDefaultWorkspace(): void {
    try {
      fs.mkdirSync(this.defaultWorkspace, { recursive: true });
    } catch {
      /* 建不出来不阻塞启动；用到时会如实报错 */
    }
    if (!this.settings.getPrefs().defaultWorkspace?.trim()) {
      try {
        this.settings.savePrefs({ defaultWorkspace: this.defaultWorkspace });
      } catch {
        /* 设置写不进去也不影响本次会话 */
      }
    }
  }

  /** 旧数据迁移：projectRoot → roots.primary（一次性，失败不阻塞启动） */
  private migrateThreadRoots(): void {
    for (const t of this.threads.list()) {
      if (t.roots) continue;
      const roots = rootsFromLegacy({ projectRoot: t.projectRoot });
      if (!roots) continue;
      try {
        this.threads.setRoots(t.id, roots);
      } catch {
        /* 索引写不进去就下次再试 */
      }
    }
  }

  /**
   * 这个会话用哪套根：显式 roots > 旧 projectRoot > 默认工作区。
   * 注意：**不再沿用上一个会话的目录**——那是旧实现的串目录根因。
   */
  private rootsForThread(meta: ThreadMeta | null | undefined): RootSet {
    const roots = rootsFromLegacy({ roots: meta?.roots, projectRoot: meta?.projectRoot });
    if (roots) return roots;
    return { primary: this.defaultWorkspace, extras: [] };
  }

  /** 只改内存里的当前根（projectRoot 是主根镜像） */
  private applyRoots(roots: RootSet): void {
    this.roots = normalizeRoots(roots) ?? emptyRoots();
    this.projectRoot = primaryOf(this.roots);
  }

  /**
   * 换当前会话的根集合：落会话、重建 Pi（cwd 跟着走）、重载项目级 MCP/技能。
   * 目录存不存在由调用方校验（切会话恢复历史路径时不强校验——用户可能只是临时移走了）。
   */
  private setSessionRoots(next: RootSet): void {
    const normalized = normalizeRoots(next) ?? emptyRoots();
    this.applyRoots(normalized);
    if (this.currentThreadId) {
      try {
        this.threads.setRoots(this.currentThreadId, normalized);
      } catch {
        /* 索引写失败不影响本次会话 */
      }
    }
    this.createFreshSession = true;
    void this.resetAgentHost();
    void this.reloadMcp();
    this.reloadSkills();
    this.watchMcpConfig();
    this.log("session_roots", {
      primary: this.projectRoot,
      extras: normalized.extras.map((r) => `${r.mode}:${r.path}`),
      trusted: this.projectRoot ? this.trust.isTrusted(this.projectRoot) : false,
    });
  }

  /**
   * 任务工作区形态（2026-11-10）：
   *  - 根在 tasks/<id>/ 下 → sandbox（不碰用户项目）
   *  - 否则 → project（就地改代码/文档，生成物进 deliverables）
   * scratch 永远在数据根内，可被 TTL 清理。
   */
  private workspaceRecordFor(taskId: string, root: string): TaskWorkspaceRecord {
    const taskDir = path.join(this.dataRoot, "tasks", taskId);
    const abs = path.resolve(root);
    const sandbox = isInside(taskDir, abs) || isInside(path.join(this.dataRoot, "tasks"), abs);
    return {
      mode: sandbox ? "sandbox" : "project",
      root: abs,
      deliverablesDir: sandbox ? path.join(abs, "deliverables") : path.join(abs, "deliverables", taskId),
      scratchDir: path.join(taskDir, "scratch"),
    };
  }

  /**
   * 成员可读根（只读并集）：会话附加根 ∪ 团队附加根 ∪ 任务权（readRoots / workspace.roots）。
   * 成员的写仍然只走工作区；这里只决定"能看哪儿"。
   */
  private effectiveReadRoots(taskId: string, teamId?: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (p?: string) => {
      const s = String(p ?? "").trim();
      if (!s) return;
      const abs = path.resolve(s);
      if (seen.has(abs.toLowerCase())) return;
      seen.add(abs.toLowerCase());
      out.push(abs);
    };
    // L0 全局常用只读根（设置里长期授权）
    for (const r of this.settings.getPrefs().knownReadRoots ?? []) add(r);
    // L1 会话附加根
    for (const r of this.roots.extras) add(r.path);
    // L2 团队附加根
    if (teamId) {
      try {
        for (const r of this.teamStore.readTeam(teamId).roots?.extras ?? []) add(r.path);
      } catch {
        /* 团队记录读不到就只算会话与任务 */
      }
    }
    const rec = this.taskStore.get(taskId);
    for (const r of rec?.readRoots ?? []) add(r);
    for (const r of rec?.workspace?.roots ?? []) add(r.path);
    return out;
  }

  /** 成员交来的路径：工作区优先，其次只读根；绝对路径原样。找不到就原样交回校验 */
  private resolveMemberPath(rel: string, workdir: string, readRoots: string[]): string {
    if (/^https?:\/\//i.test(rel) || path.isAbsolute(rel)) return rel;
    const ws = path.resolve(workdir, rel);
    if (isInside(workdir, ws) && fs.existsSync(ws)) return ws;
    for (const r of readRoots) {
      const p = path.resolve(r, rel);
      if (isInside(r, p) && fs.existsSync(p)) return p;
    }
    return rel;
  }

  /**
   * 交付物固化（2026-11-10）：工作区内的交付物复制进卷宗 artifacts（≤10MB）；
   * 只读根/超大文件只登记引用。清单写进 task.json.deliverables，永久保留。
   */
  private solidifyDeliverables(taskId: string, paths: string[], workdir: string, threadId: string): void {
    const items: DeliverableRef[] = [];
    const LIMIT = 10 * 1024 * 1024;
    for (const p of paths) {
      const abs = path.isAbsolute(p) ? p : path.resolve(workdir, p);
      let bytes = 0;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
      let ref = abs;
      if (bytes <= LIMIT && isInside(workdir, abs)) {
        try {
          ref = this.taskCase.importArtifact(taskId, abs).ref;
        } catch {
          ref = abs;
        }
      }
      items.push({ path: p, ref, bytes, at: new Date().toISOString() });
    }
    if (!items.length) return;
    try {
      this.taskStore.setDeliverables(taskId, items);
      this.taskCase.append(taskId, {
        kind: "artifact",
        text: `交付物 ${items.length} 件：${items.map((i) => i.path).join("、")}`,
      });
    } catch {
      /* 工单写失败不阻塞回报 */
    }
    this.cardTo(threadId, {
      kind: "system",
      jobId: taskId,
      text: `收到 ${items.length} 件交付物（验收后永久保留）：${items.map((i) => i.path).join("、")}`,
    });
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
        usage: {
          sessionIn: this.usage.sessionIn,
          sessionOut: this.usage.sessionOut,
          cacheRead: this.usage.cacheRead,
          cacheWrite: this.usage.cacheWrite,
          cost: this.usage.cost,
          tokensUsed: this.tokensUsed,
        },
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
      cacheRead: st.usage?.cacheRead ?? 0,
      cacheWrite: st.usage?.cacheWrite ?? 0,
      cost: st.usage?.cost ?? 0,
      contextTokens: 0,
      contextPercent: null,
    };
    for (const c of st.feed) {
      this.feed.push(c);
      const n = Number(/^c-(\d+)$/.exec(c.id)?.[1] ?? 0);
      if (n > this.cardSeq) this.cardSeq = n;
    }
    this.history = st.history;
    this.liveCard = null;
    // 会话各带一套根：切回来要回到它自己的目录（不同项目的 @ 检索与 Pi cwd 不能串）。
    // 没有显式根的旧会话走默认工作区，绝不"沿用上一个会话"。
    const prevRoot = this.projectRoot;
    this.applyRoots(this.rootsForThread(meta));
    if (this.projectRoot !== prevRoot) {
      this.reloadSkills();
      void this.reloadMcp();
      this.watchMcpConfig();
    }
    this.createFreshSession = true;
    void this.resetAgentHost();
    this.checkpoints.discard();
    this.setTurn({ phase: "idle", busy: false, pending: 0, taskId: undefined, startedAt: undefined, canUndo: false, changedFiles: [] });
  }

  /**
   * 进入空场：最后一条会话被删掉后的状态。
   * 不是"新建一条空会话"，而是真的什么都没有——界面据此给空场，
   * 用户说第一句话时再由 submitTurn 就地开一条（见那里的注释）。
   */
  private enterEmptySession(): void {
    this.currentThreadId = "";
    // 空场回到默认工作区：不让"上一条会话的目录"残留在内存里变成隐式继承
    this.applyRoots({ primary: this.defaultWorkspace, extras: [] });
    this.feed = [];
    this.history = [];
    this.cardSeq = 0;
    this.liveCard = null;
    this.tokensUsed = 0;
    this.usage = { ...this.usage, turnIn: 0, turnOut: 0, sessionIn: 0, sessionOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextPercent: null };
    this.createFreshSession = true;
    void this.resetAgentHost();
    this.checkpoints.discard();
    this.setTurn({ phase: "idle", busy: false, pending: 0, taskId: undefined, startedAt: undefined, canUndo: false, changedFiles: [] });
  }

  /**
   * 要"这单/这轮属于哪条会话"时统一走这里：一条会话都没有就地开一条。
   * 不这么兜的话，删光会话后派的单会记成无主单（台账里点哪都删不掉）。
   */
  private ensureThreadId(): string {
    if (!this.currentThreadId) {
      const meta = this.threads.create("新会话", this.roots);
      // 不走 switchThread：它会清空 feed，把这一轮已经生成的心跳卡/工具卡一起抹掉。
      // 这里是"给内存里已有的内容补一个归属"，不是"切到另一条会话"。
      this.currentThreadId = meta.id;
      this.persistThread();
    }
    return this.currentThreadId;
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

  /** Pi 官方 RPC 入口（基座原样，不 patch / 不 fork）；风铃逻辑全在 --extension 插件里 */
  private get rpcEntryPath(): string {
    return path.join(
      __dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "rpc-entry.js",
    );
  }

  private get piExtensionPath(): string {
    return path.join(__dirname, "..", "..", "agent", "extensions", "lynn-bridge.mjs");
  }

  /** 旧自建协议：只作为一键回退（LYNN_USE_LEGACY_RPC=1），不再默认使用 */
  private get legacyEntryPath(): string {
    return path.join(__dirname, "..", "..", "agent", "pi-rpc-entry.mjs");
  }

  private get useOfficialRpc(): boolean {
    return process.env.LYNN_USE_LEGACY_RPC !== "1";
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
    const entry = this.useOfficialRpc ? this.rpcEntryPath : this.legacyEntryPath;
    const piPkg = path.join(__dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
    const extensionOk = !this.useOfficialRpc || fs.existsSync(this.piExtensionPath);
    // 单测（node --test 会给每个测试文件设 NODE_TEST_CONTEXT）不走 Pi worker：
    // 否则每个内核测试都要冷启动一个子进程，并发跑时直接超时（2026-11-10 实测）。
    // 需要真链路的测试（pi-rpc-smoke）直接用 AgentHost，不经过这里。
    const inTest = Boolean(process.env.NODE_TEST_CONTEXT) && process.env.LYNN_PI_RPC !== "1";
    this.piReady = !inTest && fs.existsSync(entry) && fs.existsSync(piPkg) && extensionOk;
    if (!this.piReady) {
      console.warn(`[kernel] Pi RPC 不可用（entry=${fs.existsSync(entry)} / sdk=${fs.existsSync(piPkg)} / extension=${extensionOk}），降级直连模式`);
    } else {
      // 上次异常退出可能留下还在跑的 worker：启动时按标记清掉（单实例锁保证没有别人在用）
      const reaped = reapOrphanWorkers(path.join(this.dataRoot, "runtime", "workers"), { entry });
      if (reaped.length) this.log("orphans_reaped", { pids: reaped });
    }
    // 内置技能种子（M3-01）：缺才写入（用户改过不覆盖；删除后下次启动还原）
    this.seedBuiltinSkills();
    // 过程文件清理（P2-1）：只碰 scratch/检查点/旧日志，失败不影响启动
    try {
      runCleanup(this.dataRoot, this.settings.getPrefs().retention);
    } catch {
      /* 清理失败不阻塞启动 */
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
    // 指挥者巡检（2026-11-04）：成员长时间没动静 / 反复撞边界时，风铃自己跟进一步，
    // 不再"派完就睡、等用户来问"。判定与节流见 supervisorTick / supervisorCase。
    this.supervisorTimer = setInterval(() => this.supervisorTick(), 60_000);
    this.supervisorTimer.unref?.();
    // 心跳巡检（M3-01）：机械层聚合"待审查/停滞工单/定时任务异常"，没事零 token，
    // 有事才起一轮由风铃自主处置（停/催/捡/问/汇报），间隔与去重见 heartbeatTick。
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), 60_000);
    this.heartbeatTimer.unref?.();
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
    // 实时生效：盯住两处 mcp.json，保存即重连（不用重启应用）
    this.watchMcpConfig();
  }

  /**
   * 重新连 MCP（M0-07 + M1-13）：全局 `mcp.json` 永远加载；项目级 `.lynn/mcp.json`
   * 只有在项目被信任时才加载——陌生仓库不能靠一个文件把工具塞进她的工具面。
   */
  private async reloadMcp(opts: { quiet?: boolean } = {}): Promise<void> {
    await this.mcp.stopAll();
    const merged = new Map<string, McpServerConfig>();
    const global = loadMcpConfig(this.dataRoot);
    if (global.error) {
      this.log("mcp_config_error", { error: global.error });
      if (!opts.quiet) this.card({ kind: "system", text: global.error });
    }
    for (const s of global.servers) merged.set(s.id, s);

    const projectFile = this.projectRoot ? path.join(this.projectRoot, ".lynn", "mcp.json") : "";
    if (projectFile && fs.existsSync(projectFile)) {
      if (this.trust.isTrusted(this.projectRoot)) {
        const p = loadMcpConfigAt(projectFile);
        if (p.error) {
          this.log("mcp_project_config_error", { error: p.error });
          if (!opts.quiet) this.card({ kind: "system", text: `项目级 MCP 配置有问题：${p.error}` });
        }
        for (const s of p.servers) merged.set(s.id, s);
      } else {
        this.log("mcp_project_untrusted", { root: this.projectRoot });
        if (!opts.quiet) {
          this.card({
            kind: "system",
            text: `发现项目级 MCP 配置（${projectFile}），这个项目还没被信任，暂不加载。到「设置 → 权限与安全」信任后再试。`,
          });
        }
      }
    }

    const servers = [...merged.values()];
    if (!servers.length) return;
    await this.mcp.startAll(servers);
    for (const e of this.mcp.lastErrors()) {
      this.log("mcp_server_error", e);
      if (!opts.quiet) this.card({ kind: "system", text: `MCP 服务器「${e.id}」没连上：${e.message}` });
    }
    this.log("mcp_ready", {
      tools: this.mcp.size(),
      fingerprint: this.mcp.fingerprint(),
      projectTrusted: this.projectRoot ? this.trust.isTrusted(this.projectRoot) : false,
    });
  }

  /**
   * 实时重载：串行执行（避免两次 stopAll/startAll 交错），
   * 完成后指纹变化 → 下一轮 ensureHost 自动带着新工具面重建 worker，不用重启应用。
   */
  private async reloadMcpLive(reason: "manual" | "config-changed"): Promise<void> {
    const run = async () => {
      await this.reloadMcp({ quiet: true });
      const connected = this.mcp.status().filter((s) => s.connected).length;
      this.card({
        kind: "system",
        text: `MCP 已重新加载（${reason === "manual" ? "手动" : "检测到配置变更"}）：${this.mcp.size()} 个工具，${connected} 台已连接；下一条消息起生效。`,
      });
    };
    this.mcpReloadChain = this.mcpReloadChain.then(run, run);
    return this.mcpReloadChain;
  }

  /** 盯住两处 mcp.json：改完保存即重连（编辑器多为原子替换，所以监听目录而不是文件） */
  private watchMcpConfig(): void {
    for (const w of this.mcpWatchers) {
      try {
        w.close();
      } catch {
        /* 关不掉也无妨 */
      }
    }
    this.mcpWatchers = [];
    const targets: { dir: string; name: string }[] = [
      { dir: this.dataRoot, name: "mcp.json" },
      ...(this.projectRoot ? [{ dir: path.join(this.projectRoot, ".lynn"), name: "mcp.json" }] : []),
    ];
    for (const t of targets) {
      if (!fs.existsSync(t.dir)) continue;
      try {
        const w = fs.watch(t.dir, (_ev, file) => {
          if (!file || String(file) !== t.name) return;
          this.scheduleMcpReload();
        });
        w.on("error", () => undefined);
        this.mcpWatchers.push(w);
      } catch {
        /* 监听不上就退回"手动重新加载"按钮，不假装实时 */
      }
    }
  }

  private scheduleMcpReload(): void {
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    this.mcpReloadTimer = setTimeout(() => {
      this.mcpReloadTimer = null;
      void this.reloadMcpLive("config-changed").catch(() => undefined);
    }, 300);
    this.mcpReloadTimer.unref?.();
  }

  /** mcp.status / mcp.reload 共用：配置文件里有什么 + 实际连上没连上 */
  private mcpStatusPayload(): {
    servers: { id: string; command: string; enabled: boolean; lazy: boolean; connected: boolean; tools: number; error?: string }[];
    globalFile: string;
    projectFile: string;
    projectTrusted: boolean;
    errors?: string[];
  } {
    const globalFile = path.join(this.dataRoot, "mcp.json");
    const projectFile = this.projectRoot ? path.join(this.projectRoot, ".lynn", "mcp.json") : "";
    const projectTrusted = this.projectRoot ? this.trust.isTrusted(this.projectRoot) : false;
    const global = loadMcpConfig(this.dataRoot);
    const project: { servers: McpServerConfig[]; error?: string } = projectTrusted && projectFile
      ? loadMcpConfigAt(projectFile)
      : { servers: [] };
    const live = new Map(this.mcp.status().map((s) => [s.id, s]));
    const seen = new Set<string>();
    const servers = [...global.servers, ...project.servers]
      .filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      })
      .map((c) => {
        const st = live.get(c.id);
        return {
          id: c.id,
          command: [c.command, ...(c.args ?? [])].join(" "),
          enabled: c.enabled !== false,
          lazy: c.lazy === true,
          connected: st?.connected ?? false,
          tools: st?.tools ?? 0,
          ...(st?.error ? { error: st.error } : {}),
        };
      });
    const errors = [global.error, project.error].filter(Boolean) as string[];
    return { servers, globalFile, projectFile, projectTrusted, ...(errors.length ? { errors } : {}) };
  }

  // ---------- 工具执行（Pi execute 与直连 tool_calls 共用） ----------

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
    /**
     * 只有落在这个根里的证据才复制进 artifacts；
     * 只读根里的文件只登记引用（不把用户项目整份拷走，2026-11-10）。
     */
    copyRoot?: string,
  ): string {
    this.tools.reviewResult(teamId, taskId, { member, text, evidence, sessionId: sessionId ?? this.host?.sessionId });
    this.taskCase.append(taskId, { kind: "report", member, text, meta: { evidence } });
    this.taskCase.appendSummary(taskId, `${member} 回报：${text.slice(0, 60)}`);

    try {
      this.taskStore.ensureInProgress({
        id: taskId,
        title: taskId,
        teamId,
        member,
        threadId,
        workspaceRoot: this.taskStore.get(taskId)?.workspaceRoot ?? this.projectRoot,
      });
    } catch {
      // 工单已存在或状态已就位
    }
    let verified = 0;
    for (const [i, e] of evidence.entries()) {
      let ref = e;
      let ok = this.taskCase.verifyRef(taskId, e);
      if (ok && !/^https?:\/\//i.test(e) && !e.startsWith("artifacts/")) {
        const abs = path.resolve(e);
        const copiable = copyRoot ? isInside(copyRoot, abs) : true;
        if (copiable) {
          try {
            ref = this.taskCase.importArtifact(taskId, e).ref;
            ok = true;
          } catch {
            ok = this.taskCase.verifyRef(taskId, ref);
          }
        } else {
          // 只读根里的文件：只登记引用（绝对路径），不复制
          ref = abs;
          ok = fs.existsSync(abs);
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
      /* 成员交的活归风铃验：她 accept 即归档，不弹给用户（用户只审风铃的最终汇报） */
      this.taskStore.setReviewer(taskId, "lynn");
      moved = true;
      this.setTurn({ phase: "review", taskId });
      this.taskCase.append(taskId, { kind: "transition", member, text: "→ in_review（待风铃验）" });
      this.taskCase.appendSummary(taskId, `进入待风铃验收（已验证证据 ${verified} 项）`);
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
        const wsRoot = p.workspace ?? (this.projectRoot || path.join(this.dataRoot, "tasks", p.taskId, "workspace"));
        this.taskStore.create({
          id: p.taskId,
          title: (p.brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 40) || p.taskId,
          teamId: p.teamId,
          member: p.member,
          // 记下"这单从哪个会话派出"：换会话后旧工单的往来还能读回来
          threadId: this.ensureThreadId(),
          // 成员的读写工作区 = 契约上批准的目录（缺省 = 会话主根）
          workspaceRoot: wsRoot,
          workspace: this.workspaceRecordFor(p.taskId, wsRoot),
        });
        this.taskStore.transition(p.taskId, "todo");
      } else if (existing.status === "backlog" || existing.status === "blocked") {
        this.taskStore.transition(p.taskId, "todo", { threadId: this.ensureThreadId() });
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
    // 用户点「开始」= 批准契约卡上的只读授权申请：此刻落权（写仍限工作区，模型不能自我扩权）
    if (p.readRoots?.length) {
      const prev = this.taskStore.get(p.taskId)?.readRoots ?? [];
      this.taskStore.setReadRoots(p.taskId, [...new Set([...prev, ...p.readRoots])]);
      this.taskCase.append(p.taskId, { kind: "note", text: `用户批准只读授权：${p.readRoots.join("、")}（写仍限工作区）` });
    }
    const kickoff = this.dispatchMember(p.teamId, p.taskId, p.member, p.brief, p.deadline, p.tools, p.draftId, p.maxTurns);
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
    maxTurns?: number,
  ): { ok: boolean; message: string } {
    const cfg = this.activeModelConfig();
    const apiKey = this.activeApiKey();
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
    // 成员的读写工作区：插件工坊=草稿区；否则用派单时钉住的会话项目目录（可读写），老单补记后同样落在项目目录
    if (!draftId) {
      const rec = this.taskStore.get(taskId);
      if (rec && !rec.workspaceRoot) {
        // 老单补记：没有会话主根就落任务沙箱，绝不拿数据根冒充用户项目
        const fallback = this.projectRoot || path.join(this.dataRoot, "tasks", taskId, "workspace");
        try {
          this.taskStore.setWorkspace(taskId, this.workspaceRecordFor(taskId, fallback));
        } catch {
          /* 写不进去就退回默认任务工作区 */
        }
      }
    }
    const recForWork = this.taskStore.get(taskId);
    const workdir = draftId
      ? path.join(draftsDir(this.dataRoot), draftId)
      : recForWork?.workspace?.root ?? recForWork?.workspaceRoot ?? path.join(this.dataRoot, "tasks", taskId, "workspace");
    fs.mkdirSync(workdir, { recursive: true });
    // 过程文件目录：永远在数据根内（可被 TTL 清理），不污染用户项目
    const scratchDir = recForWork?.workspace?.scratchDir ?? path.join(this.dataRoot, "tasks", taskId, "scratch");
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
    } catch {
      /* 建不出来时成员写临时文件会落系统 temp，不影响主流程 */
    }
    // 简报放任务目录（别往用户项目里塞文件）
    const briefFile = path.join(this.dataRoot, "tasks", taskId, "_brief.md");
    fs.mkdirSync(path.dirname(briefFile), { recursive: true });
    fs.writeFileSync(
      briefFile,
      `# 简报包（来自风铃）\n\n- 截止：${deadline}\n- 工作区：${workdir}（可读写）\n- 本次分配工具：${allowed.join("、") || "无"}\n\n${brief}\n`,
      "utf-8",
    );

    // 进度卡：一张单一张卡，跑的过程中就地更新——不再一次工具调用刷一张卡。
    // 必须带 jobId 且写回出发会话：否则图纸「往来」里只有"派单·契约"一条，
    // 用户看到的就是"跑了二十分钟什么都没发生"（实报）。
    const controller = new AbortController();
    const steps: string[] = [];
    const startedAt = Date.now();
    const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
    const live = this.cardTo(runThreadId, {
      kind: "tool",
      badge: "进度",
      jobId: taskId,
      title: `${member} 在干 · ${taskId}`,
      meta: "刚开工",
      body: "（等他第一步）",
    });
    let lastStepAt = Date.now();
    /** 里程碑汇报：不打断成员，但每 2 分钟给自己留一条可回看的进度卡（不催也要报） */
    let lastMilestoneAt = Date.now();
    const pushStep = (text: string) => {
      steps.push(text);
      lastStepAt = Date.now();
      this.memberLastStep.set(memberKey, text);
      this.memberStepAt.set(taskId, Date.now());
      const tail = steps.slice(-6).join("\n");
      this.patchCardTo(runThreadId, live, {
        meta: `第 ${steps.length} 步 · ${elapsedSec()}s`,
        body: tail.length > 1500 ? `…\n${tail.slice(-1500)}` : tail,
      });
      if (Date.now() - lastMilestoneAt >= 120_000) {
        lastMilestoneAt = Date.now();
        this.cardTo(runThreadId, {
          kind: "tool",
          badge: "进度",
          jobId: taskId,
          title: `${member} 第 ${steps.length} 步 · ${taskId}`,
          meta: `已用时 ${elapsedSec()}s`,
          body: steps.slice(-3).join("\n"),
        });
      }
    };
    // 卡死可见：长时间没有任何动作就报一次（不自动杀，让人决定）
    let stalledNotified = false;
    const stallTimer = setInterval(() => {
      const quiet = Date.now() - lastStepAt;
      if (quiet < MEMBER_STALL_MS || stalledNotified) return;
      stalledNotified = true;
      const body = `已经 ${Math.round(quiet / 1000)}s 没有任何动作。可以点台账/右键「停」，或再等等。\n\n最后动作：\n${steps.slice(-3).join("\n") || "（一步都没做）"}`;
      this.patchCardTo(runThreadId, live, { meta: `第 ${steps.length} 步 · 可能卡住`, body });
      this.cardTo(runThreadId, { kind: "system", jobId: taskId, text: `${member} · ${taskId}：${body}` });
    }, 15_000);
    stallTimer.unref?.();

    const run: Promise<MemberRunResult> = runMemberTask({
      profile,
      brief,
      deadline,
      tools: allowed,
      maxTurns,
      signal: controller.signal,
      workdir,
      scratchDir,
      model: { baseUrl: cfg.baseUrl, apiKey, model: cfg.model },
      chatFn: this.memberChatFn,
      // 成员可见只读根 = 会话 ∪ 团队 ∪ 任务（只读并集）；写仍限工作区。
      // 用函数现取：跑到一半用户补授权，下一轮立刻生效。
      readRoots: () => this.effectiveReadRoots(taskId, teamId),
      // 可写附加根：只给 run_command 的 cwd 用（跨项目跑构建/测试），文件写入仍限工作区
      writableRoots: () => [
        ...this.roots.extras.filter((r) => r.mode === "rw").map((r) => r.path),
        ...(this.taskStore.get(taskId)?.workspace?.roots ?? []).filter((r) => r.mode === "rw").map((r) => r.path),
      ],
      // 删除类命令必须用户点头：挂一张审批卡，超时按拒绝
      onBeforeCommand: (cmd) => this.awaitCommandApproval(member, taskId, cmd),
      // 收件箱：风铃/巡检中途补的指示，成员每轮开头取（催办不杀进程、不重派）
      inbox: (() => {
        const box = this.memberInbox.get(taskId) ?? [];
        this.memberInbox.set(taskId, box);
        return box;
      })(),
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
          const rootsForEvidence = this.effectiveReadRoots(taskId, teamId);
          const evidence = result.evidence.map((e) => this.resolveMemberPath(e, workdir, rootsForEvidence));
          // 只有真交了证据才登记；空回报进登记通道会抛错，原来那条路直接变成"崩溃"卡
          this.registerReport(teamId, taskId, member, result.report, evidence, undefined, runThreadId, result.evidence, workdir);
          // 交付物与证据分开：交付物永久固化，过程证据只登记
          if (result.deliverables.length) {
            this.solidifyDeliverables(
              taskId,
              result.deliverables.map((e) => this.resolveMemberPath(e, workdir, rootsForEvidence)),
              workdir,
              runThreadId,
            );
          }
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
        this.memberInbox.delete(taskId);
        this.memberStepAt.delete(taskId);
        this.memberBlocked.delete(taskId);
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
      body: `工作区：${workdir}（可读写；删除类命令要你点头；回报后自动进审查台）`,
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

  /**
   * 用户授予"这张单可以只读访问这些目录"（写仍只能在工作区）。
   * 只由界面入口调用；模型没有拿到这个能力，所以不存在自我扩权。
   * 2026-11-10：支持一次多个目录；整盘只读需要用户显式确认（allowDriveRoot）。
   */
  grantReadRoots(
    taskId: string,
    dirs: string[],
    opts: { allowDriveRoot?: boolean } = {},
  ): { ok: boolean; roots?: string[]; error?: string } {
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    const wanted = [...new Set(dirs.map((d) => String(d ?? "").trim()).filter(Boolean))];
    if (!wanted.length) return { ok: false, error: "没有选中目录" };
    const accepted: string[] = [];
    for (const dir of wanted) {
      const abs = path.resolve(dir);
      const dirErr = rootDirError(abs);
      if (dirErr) return { ok: false, error: dirErr };
      if (isDriveRoot(abs) && !opts.allowDriveRoot) {
        return { ok: false, error: `${abs} 是整盘：只读授权整盘需要二次确认（手输盘符或勾选确认）。` };
      }
      const forbid = forbiddenRootReason(abs, this.dataRoot);
      if (forbid) return { ok: false, error: forbid };
      accepted.push(abs);
    }
    const roots = [...new Set([...(rec.readRoots ?? []), ...accepted])];
    this.taskStore.setReadRoots(taskId, roots);
    this.taskCase.append(taskId, { kind: "note", text: `用户授予只读访问：${accepted.join("、")}（写仍限工作区）` });
    const owner = rec.threadId ?? this.currentThreadId;
    this.cardTo(owner, {
      kind: "system",
      jobId: taskId,
      text: `已授权 ${taskId} 只读访问 ${accepted.join("、")}：成员可以读这里的文件，但写仍然只能在工作区。`,
    });
    // 正在跑的成员要立刻知道，否则它会继续撞墙
    if (this.memberRuns.has(taskId)) {
      this.nudgeMember(
        taskId,
        `用户已授权你只读访问 ${accepted.join("、")}（用绝对路径 read_file / list_dir）。写入仍然只能在工作区；别再反复试被拦的路径。`,
      );
    }
    return { ok: true, roots };
  }

  /** 单目录兼容入口 */
  grantReadRoot(taskId: string, dir: string): { ok: boolean; roots?: string[]; error?: string } {
    return this.grantReadRoots(taskId, [dir]);
  }

  revokeReadRoot(taskId: string, dir?: string): { ok: boolean; roots?: string[]; error?: string } {
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    const roots = dir ? (rec.readRoots ?? []).filter((r) => path.resolve(r) !== path.resolve(dir)) : [];
    this.taskStore.setReadRoots(taskId, roots);
    this.taskCase.append(taskId, { kind: "note", text: dir ? `撤销只读访问：${dir}` : "撤销全部只读访问" });
    const owner = rec.threadId ?? this.currentThreadId;
    this.cardTo(owner, { kind: "system", jobId: taskId, text: dir ? `已撤销只读访问 ${dir}` : `已撤销 ${taskId} 的全部只读访问` });
    return { ok: true, roots };
  }

  /**
   * 删除类命令的用户审批：挂一张审批卡（右栏「等你拍板」），最长等 5 分钟，超时按拒绝。
   * 成员被拒就停手（工具层已挡住，不存在"换个写法绕过"）。
   */
  private awaitCommandApproval(member: string, taskId: string, command: string): Promise<{ ok: boolean; reason?: string }> {
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const owner = this.taskStore.get(taskId)?.threadId ?? this.currentThreadId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        this.decisions = this.decisions.filter((d) => d.id !== id);
        this.setTurn({ phase: "awaiting_plan" });
        resolve({ ok: false, reason: "等了 5 分钟没人点头，按拒绝处理" });
      }, 300_000);
      timer.unref?.();
      this.pendingApprovals.set(id, {
        kind: "delete",
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          this.pendingApprovals.delete(id);
          resolve(ok ? { ok: true } : { ok: false, reason: "用户拒绝了这次删除" });
        },
      });
      this.decisions.push({
        id,
        from: member,
        title: `${member} 要删除文件（${taskId}）`,
        detail: command,
        kind: "approval",
        jobId: taskId,
        at: new Date().toISOString(),
      });
      this.cardTo(owner, {
        kind: "system",
        jobId: taskId,
        text: `${member} 申请执行删除类命令，等你点头（5 分钟内不答复按拒绝）：\n${command}`,
      });
      this.setTurn({ phase: "awaiting_plan" });
    });
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

  /**
   * 单张单的物理清理：停成员 → 执行中的先置 canceled → 删目录/派单账本 → 清运行时痕迹。
   * 不写任何提示卡（删会话级联时那些卡已经没有落点了），提示由调用方给。
   * 运行时痕迹必须一起清：memberActive 里留着已删的 taskId，快照就会继续把成员挂在
   * 一张不存在的单上——界面看着「工单删了动态还在」，就是这个残留。
   */
  private purgeTask(rec: TaskRecord): void {
    if (this.memberRuns.has(rec.id)) this.cancelMemberTask(rec.id);
    const cur = this.taskStore.get(rec.id) ?? rec;
    if (cur.status === "in_progress") {
      try {
        this.taskStore.transition(rec.id, "canceled", { member: cur.member });
      } catch {
        /* 已不在可迁移范围（比如刚被停成 blocked）：直接进删除 */
      }
    }
    this.taskStore.remove(rec.id);
    // 派单账本也是台账的兜底来源：不删它，删完工单还会从 assignments 里"复活"一条
    try {
      fs.rmSync(path.join(this.dataRoot, "team", rec.teamId, "assignments", `${rec.id}.jsonl`), { force: true });
    } catch {
      /* 没有账本文件是常态 */
    }
    if (rec.member) {
      const memberKey = `${rec.teamId}::${rec.member}`;
      this.memberProgress.delete(rec.member);
      this.memberLastStep.delete(memberKey);
      if (this.memberActive.get(memberKey) === rec.id) this.memberActive.delete(memberKey);
    }
    this.memberInbox.delete(rec.id);
    this.memberStepAt.delete(rec.id);
    this.memberBlocked.delete(rec.id);
    this.supervisorNoted.delete(rec.id);
    // 指向这张单的挂起裁决/契约一并撤掉，避免点开已删的工单
    if (this.decisions.some((d) => d.jobId === rec.id)) {
      this.decisions = this.decisions.filter((d) => d.jobId !== rec.id);
      this.setTurn({});
    }
  }

  /**
   * 删会话时连带撤掉挂在它名下的工单。
   * 会话在用户心里就是"任务容器"：只删对话记录、把工单留在台账里，
   * 结果就是「会话删了工单还在、值台动态区还在动」——两套存储两套真身，界面没法解释。
   */
  private purgeThreadTasks(threadId: string): { removed: number; kept: number } {
    const mine = this.taskStore.list().filter((t) => t.threadId === threadId);
    let removed = 0;
    let kept = 0;
    for (const t of mine) {
      try {
        this.purgeTask(t);
        removed += 1;
      } catch {
        // 目录被占用之类：留在台账里，至少别把删会话整个搞失败
        kept += 1;
      }
    }
    return { removed, kept };
  }

  /** 无主单：threadId 指向已删会话（老版本删会话只删对话记录留下的） */
  private orphanTasks(): TaskRecord[] {
    const live = new Set(this.threads.list().map((t) => t.id));
    return this.taskStore.list().filter((t) => t.threadId && !live.has(t.threadId));
  }

  /** 清掉无主单：给用户一个出口，否则这些单永远挂在台账里点哪都删不掉 */
  purgeOrphanTasks(): { removed: number; kept: number } {
    let removed = 0;
    let kept = 0;
    for (const t of this.orphanTasks()) {
      try {
        this.purgeTask(t);
        removed += 1;
      } catch {
        kept += 1;
      }
    }
    if (removed) {
      this.card({ kind: "system", text: `清掉 ${removed} 张无主单（所属会话已被删除）。` });
    }
    return { removed, kept };
  }

  /**
   * 彻底删除一张单（tasks/<id>/ 整目录）：不可恢复，界面必须二次确认。
   * 2026-11-10：数据根外的文件（用户项目）**一律不动**，返回值如实分开"删了什么/没动什么"。
   */
  removeTask(taskId: string): { ok: boolean; error?: string; removed?: string[]; kept?: string[] } {
    if (this.memberRuns.has(taskId)) return { ok: false, error: `${taskId} 还在跑：先停成员再删` };
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    const taskDir = path.join(this.dataRoot, "tasks", taskId);
    const wsRoot = rec.workspace?.root ?? rec.workspaceRoot ?? "";
    try {
      this.purgeTask(rec);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const removed = [taskDir];
    // 工作区只要不在这张单的目录里，就不归这张单所有（可能是共享默认工作区或用户项目）——一律不动
    const kept = wsRoot && !isInside(taskDir, wsRoot) ? [wsRoot] : [];
    const shared = kept.length > 0 && isInside(this.dataRoot, kept[0]);
    const text = kept.length
      ? shared
        ? `已删除 ${taskId}：工单、卷宗与临时文件已移除；共享工作区 ${kept.join("、")} 未改动。`
        : `已删除 ${taskId}：工单、卷宗与临时文件已移除；用户项目目录 ${kept.join("、")} 未改动。`
      : `已删除 ${taskId}：工单、卷宗与工作区一并移除（不可恢复）。`;
    if (rec.threadId) this.cardTo(rec.threadId, { kind: "system", text });
    else this.card({ kind: "system", text });
    return { ok: true, removed, kept };
  }

  /**
   * 审查快照（P2-4）：把这张单现在的工作区复制进任务沙箱，之后在副本里跑构建/测试。
   * 只读根不放开执行——复制一份再跑，原项目一个字节都不动。
   */
  snapshotProject(taskId: string): { ok: boolean; error?: string; root?: string } {
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    if (this.memberRuns.has(taskId)) return { ok: false, error: `${taskId} 还在跑：先停成员再做快照` };
    const src = rec.workspace?.root ?? rec.workspaceRoot;
    if (!src) return { ok: false, error: "这张单没有工作区可复制" };
    const absSrc = path.resolve(src);
    try {
      if (!fs.statSync(absSrc).isDirectory()) return { ok: false, error: `${absSrc} 不是目录` };
    } catch {
      return { ok: false, error: `工作区不存在：${absSrc}` };
    }
    const dest = path.join(this.dataRoot, "tasks", taskId, "workspace");
    if (path.resolve(dest) === absSrc || isInside(dest, absSrc)) {
      return { ok: true, root: absSrc };
    }
    if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      return { ok: false, error: `任务沙箱里已经有内容（${dest}），先清掉再复制，免得两份混在一起` };
    }
    const skip = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage", ".cache", "__pycache__"]);
    try {
      fs.cpSync(absSrc, dest, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (p) => {
          if (skip.has(path.basename(p))) return false;
          try {
            const st = fs.statSync(p);
            if (st.isFile() && st.size > 50 * 1024 * 1024) return false; // 超大文件不复制，避免把沙箱撑爆
          } catch {
            /* 读不到就按可复制处理，copy 自己会报错 */
          }
          return true;
        },
      });
    } catch (err) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* 清不掉也如实报错 */
      }
      return { ok: false, error: `复制失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const ws = this.workspaceRecordFor(taskId, dest);
    this.taskStore.setWorkspace(taskId, ws);
    const owner = rec.threadId ?? this.currentThreadId;
    this.taskCase.append(taskId, { kind: "note", text: `用户做了审查快照：${absSrc} → ${dest}（原项目不动）` });
    this.cardTo(owner, {
      kind: "system",
      jobId: taskId,
      text: `已把工作区复制进任务沙箱：${dest}（排除了 node_modules / .git / dist 等大目录）。要跑测试就让成员重新开工，命令在副本里跑。`,
    });
    return { ok: true, root: dest };
  }

  /**
   * 导出任务卷宗 zip（P2-3）：给用户一个能带走的包。
   * 只收卷宗内的东西（task.json / timeline / summary / artifacts / 交付清单），
   * 不打包 sandbox 整个工作树（可能很大），也不碰用户项目。
   */
  exportTask(taskId: string): { ok: boolean; error?: string; path?: string } {
    const rec = this.taskStore.get(taskId);
    if (!rec) return { ok: false, error: `工单不存在：${taskId}` };
    const dir = path.join(this.dataRoot, "tasks", taskId);
    if (!fs.existsSync(dir)) return { ok: false, error: `卷宗目录不存在：${dir}` };
    const entries: ZipEntry[] = [];
    for (const name of ["task.json", "timeline.jsonl", "summary.md", "_brief.md"]) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      try {
        entries.push({ name, data: fs.readFileSync(p), mtime: fs.statSync(p).mtime });
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
    entries.push(...collectZipEntries(path.join(dir, "artifacts"), "artifacts"));
    if (rec.deliverables?.length) {
      entries.push({
        name: "deliverables.json",
        data: Buffer.from(JSON.stringify(rec.deliverables, null, 2), "utf-8"),
      });
    }
    const exportsDir = path.join(this.dataRoot, "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const target = path.join(exportsDir, `${taskId}-${stamp}.zip`);
    try {
      fs.writeFileSync(target, buildZip(entries));
    } catch (err) {
      return { ok: false, error: `导出失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.log("task_exported", { taskId, path: target, entries: entries.length });
    return { ok: true, path: target };
  }

  /**
   * 给在跑的成员补一句指示（风铃催办）：进收件箱，成员下一轮开头就会看到。
   * 不杀进程、不重派，已写出的文件与进度都保留。
   */
  nudgeMember(taskId: string, note: string): string {
    const text = note.trim();
    if (!text) return "补充指示不能为空：要它改什么、先交什么，写清楚。";
    if (!this.memberRuns.has(taskId)) {
      return `${taskId} 没有在跑（可能已结束/已停）：要改要求请重新派单，或用 check_progress 看它交了什么。`;
    }
    const box = this.memberInbox.get(taskId) ?? [];
    box.push(text);
    this.memberInbox.set(taskId, box);
    const rec = this.taskStore.get(taskId);
    const owner = rec?.threadId ?? this.currentThreadId;
    this.cardTo(owner, {
      kind: "system",
      jobId: taskId,
      text: `给 ${rec?.member ?? "成员"} 补了一句（下一轮生效）：${text.slice(0, 200)}`,
    });
    return `已送达 ${taskId}：成员下一轮会看到，不用重派。`;
  }

  /**
   * 指挥者巡检（每分钟 tick，但真正触发受 5 分钟全局 / 10 分钟每单节流）：
   * 成员长时间没动作、或反复撞边界时，风铃自己起一轮跟进——她不再"派完就睡"。
   */
  private supervisorTick(): void {
    if (!this.settings.getPrefs().supervisor) return;
    if (this.busy || this.memberRuns.size === 0) return;
    const now = Date.now();
    if (now - this.lastSupervisorAt < 5 * 60_000) return;
    const runs = [...this.memberRuns.keys()].map((id) => {
      const rec = this.taskStore.get(id);
      const key = `${rec?.teamId ?? ""}::${rec?.member ?? ""}`;
      return {
        taskId: id,
        member: rec?.member ?? "成员",
        quietMs: now - (this.memberStepAt.get(id) ?? now),
        blocked: this.memberBlocked.get(id) ?? 0,
        lastStep: this.memberLastStep.get(key),
      };
    });
    const hit = supervisorCase(runs, now, this.supervisorNoted);
    if (!hit) return;
    this.lastSupervisorAt = now;
    this.supervisorNoted.set(hit.taskId, now);
    const owner = this.taskStore.get(hit.taskId)?.threadId ?? this.currentThreadId;
    this.cardTo(owner, { kind: "system", jobId: hit.taskId, text: `阿黎开始跟进 ${hit.taskId}：${hit.text}` });
    this.submitTurn(
      `[自动巡检] ${hit.text}\n\n请作为指挥者处理这张单：①check_progress 看细节；②能用一句话纠正就 nudge_member（下一轮生效，不用重派、不丢已写文件）；③明显做不到（例如要访问工作区外的目录）就 stop_task 停掉，并告诉我原因和替代方案；④只是慢就回一句「继续等」。不要重复派单。`,
      undefined,
      { internal: true },
    );
  }

  /**
   * 心跳巡检（M3-01）：机械层每分钟看一眼，聚合三类机器事实——待审查的回报、
   * 停滞工单（backlog/blocked/todo 且没人跟、不在等用户拍板）、定时任务异常。
   * 纪律：没事零 token；忙时跳过（事实持续存在，下个窗口再看，不排队防堆积）；
   * 同一批事实 30 分钟内不重复注入；间隔由 prefs.heartbeatMinutes 控制（0/关 = 不巡检）。
   * 注入后判断与处置完全由风铃做主——代码只把该看的事摆到她面前，不写死动作。
   */
  /** 内置技能种子：缺才写入 dataRoot/skills（用户改过不覆盖；删除后下次启动还原） */
  private seedBuiltinSkills(): void {
    for (const [dir, content] of Object.entries(BUILTIN_SKILLS)) {
      const full = path.join(this.dataRoot, "skills", dir);
      if (fs.existsSync(full)) continue;
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf-8");
        this.log("builtin_skill_seeded", { dir });
      } catch (err) {
        console.warn(`[kernel] 内置技能写入失败（${dir}）：`, err instanceof Error ? err.message : err);
      }
    }
  }

  private heartbeatTick(): void {
    const prefs = this.settings.getPrefs();
    if (!prefs.heartbeat) return;
    if (this.busy) return;
    const now = Date.now();
    const minutes = Math.max(1, Math.round(prefs.heartbeatMinutes || 5));
    if (now - this.lastHeartbeatAt < minutes * 60_000) return;
    const facts: HeartbeatFacts = collectHeartbeatFacts({
      tasks: this.taskStore.list(),
      runningTaskIds: [...this.memberRuns.keys()],
      pendingPlanTaskIds: [...this.pendingPlans.values()].map((p) => p.taskId),
      schedules: this.scheduler.list(),
    });
    if (heartbeatIsEmpty(facts)) return;
    const sig = heartbeatSignature(facts);
    const notedAt = this.heartbeatNoted.get(sig);
    if (notedAt !== undefined && now - notedAt < 30 * 60_000) return;
    // 去重表瘦身：2 小时前的记录清掉，防长驻增长
    for (const [k, at] of this.heartbeatNoted) {
      if (now - at > 2 * 60 * 60_000) this.heartbeatNoted.delete(k);
    }
    this.heartbeatNoted.set(sig, now);
    this.lastHeartbeatAt = now;
    const brief = [
      ...facts.awaitingReview.map((t) => `待审查 ${t.taskId}「${t.title}」`),
      ...facts.stalledTasks.map((t) => `停滞 ${t.taskId}「${t.title}」（${t.status}）`),
      ...facts.scheduleIssues.map((s) => `定时任务异常 ${s.name}（${s.lastStatus}）`),
    ].join("；");
    this.card({ kind: "system", badge: "心跳", text: `心跳巡检（${brief}）。机器事实已摆到桌面上，由风铃判断处置：停/催/捡/问/汇报。` });
    this.submitTurn(heartbeatPrompt(facts), undefined, { internal: true });
    this.log("heartbeat_fired", {
      awaitingReview: facts.awaitingReview.length,
      stalled: facts.stalledTasks.length,
      schedules: facts.scheduleIssues.length,
    });
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
            ...(isAvatarId(args.avatarId) ? { avatarId: args.avatarId } : {}),
          },
          args.justification as string | undefined,
        );
        const hired = this.teamStore.readMember(teamId, String(args.name));
        const face = avatarById(hired.avatarId) ?? avatarFor(hired.name);
        this.emit({
          type: "tool",
          badge: "组队",
          title: `招募 ${args.name} · ${args.role}`,
          body: `目标：${args.goal}\n边界：${((args.boundaries as string[]) ?? []).join("；") || "（未写）"}`,
          members: [{ name: String(args.name), role: String(args.role), color: face.color, avatarId: face.id }],
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
        // 简报质量闸（代码层把关，不靠提示词自觉）：目标/完成标准/材料位置/限制缺一退回
        const briefRejection = validateBrief(brief, args.acceptance as string[] | undefined);
        if (briefRejection) return briefRejection;
        // 工作区：默认会话项目目录；给了就必须是已存在目录（用户会在契约卡上看到并批准）
        let workspace: string | undefined;
        if (args.workspace !== undefined && String(args.workspace).trim()) {
          const ws = path.resolve(String(args.workspace).trim());
          if (!path.isAbsolute(ws)) {
            return `workspace 必须是绝对路径（收到：${String(args.workspace)}）。不确定就先 ask_user 问用户材料在哪。`;
          }
          if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
            return `workspace 目录不存在：${ws}。先 ask_user 向用户确认工作目录，不要猜路径。`;
          }
          if (ws === path.resolve(this.dataRoot) || ws.length <= 3) {
            return `workspace 不能是数据目录或盘符根（${ws}）：成员会拿到整棵树的写权限。选一个具体的项目/任务子目录。`;
          }
          workspace = ws;
        }
        // 只读授权申请：只登记不生效——用户在契约卡上点「开始」才落权（模型不能自我扩权）
        let readRoots: string[] | undefined;
        if (Array.isArray(args.readRoots) && args.readRoots.length > 0) {
          const roots = (args.readRoots as unknown[]).map((r) => path.resolve(String(r).trim())).filter(Boolean);
          const bad = roots.filter((r) => !path.isAbsolute(r) || !fs.existsSync(r) || !fs.statSync(r).isDirectory());
          if (bad.length) {
            return `readRoots 里这些目录不存在或不是目录：${bad.join("、")}。先 ask_user 向用户确认材料位置。`;
          }
          readRoots = roots;
        }
        let maxTurns: number | undefined;
        if (args.maxTurns !== undefined) {
          const n = Number(args.maxTurns);
          if (!Number.isFinite(n) || n < 1) {
            return `maxTurns 必须是 ≥1 的数字（收到：${String(args.maxTurns)}）。`;
          }
          maxTurns = Math.min(Math.round(n), 40);
        }
        // 标题取简报里最像"任务名"的一行：跳过【背景】这类段落标记，取第一个正行；
        // 全是标记行时去掉标记再看（原来直接把"【背景】用户要审查……"摆上台账，读不出任务是什么）
        const briefLines = brief.split("\n").map((l) => l.trim()).filter(Boolean);
        const plain = briefLines.find((l) => !/^【[^】]*】/.test(l)) ?? briefLines[0]?.replace(/^【[^】]*】\s*/, "") ?? "";
        const title = (plain || taskId).slice(0, 40);
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
        // 工作区三态（2026-11-10）：显式目录 / "sandbox" / 省略=继承会话主根。
        // 没有主根时落任务沙箱，绝不拿应用数据根冒充用户项目。
        // 继承链：显式目录 > 团队根 > 会话主根 > 任务沙箱
        const inheritedRoot = this.teamStore.workspaceOf(teamId) || this.projectRoot;
        const wsFinal =
          workspace && workspace !== "sandbox"
            ? path.resolve(workspace)
            : workspace === "sandbox" || !inheritedRoot
              ? path.join(this.dataRoot, "tasks", taskId, "workspace")
              : inheritedRoot;
        const wsRec = this.workspaceRecordFor(taskId, wsFinal);
        const ctx: PendingPlan = {
          teamId,
          taskId,
          member,
          brief,
          deadline,
          tools,
          draftId,
          workspace: wsFinal,
          readRoots,
          maxTurns,
        };
        // 还没开工：工单只落 todo，不能谎报"执行中"（七态见 §4.10.4）
        if (!this.taskStore.get(taskId)) {
          // 建单时就钉住会话与工作区：任务线判定、往来归属、成员在哪儿干活都靠它
          this.taskStore.create({
            id: taskId,
            title,
            teamId,
            member,
            threadId: this.ensureThreadId(),
            workspaceRoot: wsFinal,
            workspace: wsRec,
          });
          this.taskStore.transition(taskId, "todo");
        }
        if (this.settings.getPrefs().autoStart) {
          return `已按任务契约开工（设置里开启了自动开始）。${this.startAssignment(ctx)}`;
        }
        const decisionId = `plan-${taskId}-${Date.now().toString(36)}`;
        this.pendingPlans.set(decisionId, { ...ctx, decisionId });
        const permNote = readRoots?.length ? `\n\n只读授权申请（点「开始」即批准）：${readRoots.join("、")}` : "";
        this.decisions.push({
          id: decisionId,
          from: "计划",
          title: `任务契约 · ${title}`,
          detail: `${brief}\n\n工作区（可读写）：${wsFinal}${permNote}`,
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
          body: `${brief}\n\n验收：${plan.acceptance.join("；")}\n工作区（可读写）：${wsFinal}${permNote}`,
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
      case "nudge_member": {
        return this.nudgeMember(String(args.taskId), String(args.note ?? ""));
      }
      case "stop_task": {
        const taskId = String(args.taskId);
        const r = this.cancelMemberTask(taskId);
        if (!r.ok) return `停不下来：${r.error ?? "未知原因"}`;
        const why = args.reason ? `原因：${String(args.reason)}。` : "";
        return `已停 ${taskId}。${why}工单转入「卡住」，可以向我说明情况，或让用户右键取消。`;
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
        /**
         * 验收通过＝归档。成员交的活归风铃管，她点头就算结案，不再让用户逐单盖章；
         * 用户只在风铃交出最终结果时拍一次板（§4.10.5 改成只对最终交付生效）。
         */
        let archived = false;
        let whyNot = "";
        if (args.verdict === "accept" && !r.escalated) {
          try {
            this.taskStore.approve(String(args.taskId), "lynn", `风铃代验：${String(args.member)} 的证据齐全且可复跑`);
            this.taskStore.transition(String(args.taskId), "done", { member: String(args.member) });
            this.taskCase.append(String(args.taskId), {
              kind: "approve",
              member: "风铃",
              text: "代验归档（成员单由风铃验收，不经用户）",
            });
            this.taskCase.appendSummary(String(args.taskId), "风铃代验通过 → 已归档");
            archived = true;
          } catch (err) {
            whyNot = err instanceof Error ? err.message : String(err);
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
            ? archived
              ? "已代验归档：这张单结案，不再占用用户。整件事做完后用 report_to_user 把最终结果汇报给她，她只对那一份拍板。"
              : `验收结论已记录，但没能归档（${whyNot}）。先补齐可说清的证据，或确认这张单确实在待验状态。`
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
        /* 她交出最终结果：这张单改由用户拍板，并推进到待审（没验证过证据就推不动，只呈汇报） */
        try {
          const rec = this.taskStore.get(String(args.taskId));
          if (rec) {
            this.taskStore.setReviewer(rec.id, "user");
            if (rec.status === "in_progress") this.taskStore.transition(rec.id, "in_review");
          }
        } catch {
          // 没有权威工单（临时派活）：汇报照常呈上，不弹章
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
        // 解散即停：在跑的成员单跟着停，别让一支不存在的队继续烧预算
        for (const [key, taskId] of [...this.memberActive.entries()]) {
          if (key.startsWith(`${args.teamId}::`)) void this.cancelMemberTask(taskId);
        }
        this.emit({
          type: "tool",
          badge: "工具",
          title: r === "kept" ? `保留编制 · ${args.teamId}` : `已解散 · ${args.teamId}`,
        });
        return r === "kept" ? "编制已保留，下次同类任务可直接调用。" : "团队已解散（档案保留供复盘，在跑的单已停）。";
      }
      case "save_memory": {
        const entry = String(args.entry ?? "").trim();
        if (!entry) return "entry 不能为空：一条事实/决定/坑，写具体（含上下文），不写流水账。";
        const kind: MemoryKind = args.scope === "user" ? "user" : "memory";
        const label = kind === "user" ? "用户记忆" : "助理记忆";
        const current = this.memory.load(kind).replace(/\s+$/, "");
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        this.memory.save(kind, `${current}\n- ${stamp} ${entry}\n`);
        const hot = this.hotSyncSystemPrompt();
        this.card({ kind: "system", badge: "记忆", text: `已沉淀到${label}：${entry.slice(0, 120)}` });
        this.log("memory_saved_by_agent", { kind, chars: entry.length, hot });
        return `已写入${label}并热更新到你的系统提示词（hot=${hot}）。同类任务再遇到时你会直接想起来。`;
      }
      case "create_plugin_draft": {
        const title = String(args.title ?? "").trim();
        const kind = String(args.kind ?? "L0") as WorkshopKind;
        const spec = String(args.spec ?? "").trim();
        if (!title || !spec) {
          return "title 与 spec 都必填。spec 按四段写：解决什么 / 输入输出 / 边界（不许做什么）/ 验收用例——成员只能看到规格，要写全。";
        }
        let meta;
        try {
          meta = createDraft(this.dataRoot, { title, kind, spec });
        } catch (err) {
          return `草稿创建失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const draftDir = path.join(draftsDir(this.dataRoot), meta.draftId);
        this.card({
          kind: "system",
          text: `插件草稿 ${meta.draftId} 已开：${title}（${kind}）。接下来派插件工程师开发，产物只能写进草稿区。`,
        });
        this.log("draft_created_by_agent", { draftId: meta.draftId, kind });
        return JSON.stringify({
          draftId: meta.draftId,
          draftDir,
          next: [
            `1) create_member 招插件工程师（L0 用 write_file 就够；L1 要会 TS）`,
            `2) assign_task 派单，workspace 填 "${draftDir}"（绝对路径，产物只能写进草稿区）`,
            `3) 成员做完后 ship_plugin 走准入审查：L0 过审可自启用；L1/L2 过审后请用户在插件面板启用`,
            `开发与验收标准见 plugin-dev 技能；用户的原始需求一并写进简报，别只传规格原文`,
          ].join("\n"),
        });
      }
      default:
        return `未知工具: ${name}`;
    }
  }

  // ---------- Pi RPC 会话（M0-03：模型循环在子进程，工具与权限留在壳） ----------

  /** 起/复用运行时；模型或工具面变化时重建（子进程崩溃不影响壳） */
  private async ensureHost(): Promise<RuntimeHost> {
    const cfg = this.activeModelConfig();
    const apiKey = this.activeApiKey();
    if (!cfg || !apiKey) throw new Error("no-model-config");
    const official = this.useOfficialRpc;
    // 带上模型 id：两条配置可能只差 Key（同端点同模型），不换 worker 就会用错凭据
    // 根指纹必须进指纹：Pi 的 cwd 只在 spawn 时传入，指纹不含根就会"界面一个目录、命令另一个目录"
    const stamp = `${official ? "official" : "legacy"}@${this.activeModelId() ?? this.settings.getDefaultModelId() ?? "single"}@${cfg.baseUrl}@${cfg.model}@${cfg.updatedAt}@${this.l1.fingerprint()}@${this.mcp.fingerprint()}@root:${this.projectRoot}`;
    if (this.host && this.hostStamp === stamp) return this.host;
    await this.resetAgentHost();
    const tools: RpcToolSpec[] = this.allTools().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    const common = {
      model: { baseUrl: cfg.baseUrl, apiKey, model: cfg.model, provider: cfg.provider },
      tools,
      systemPrompt: this.systemPrompt(),
      onToolCall: async (name: string, args: Record<string, unknown>) => {
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
      resume:
        !this.createFreshSession &&
        (fs.existsSync(this.timelineFile) ||
          (!!this.currentThreadId && this.threads.loadState(this.currentThreadId).history.length > 0)),
      sessionDir: this.currentThreadId ? this.threads.piDir(this.currentThreadId) : path.join(this.dataRoot, "session", "pi"),
      // 无主根的会话：不传 cwd（Pi 用 entry 所在目录），成员命令仍各自钉在工作区
      projectRoot: this.projectRoot || undefined,
      onEvent: (ev: { type: string; [k: string]: unknown }) => this.onAgentEvent(ev),
      onError: (message: string) => {
        // 运行时错误必须进对话流：只发事件的话界面会一片空白（用户只看到自己那半句）
        this.card({ kind: "system", text: `运行时错误：${message}` });
        this.emit({ type: "error", message });
      },
    };
    const host: RuntimeHost = official
      ? new PiRpcHost({
        ...common,
        entryPath: this.rpcEntryPath,
        extensionPath: this.piExtensionPath,
        agentDir: path.join(this.dataRoot, "kernel", "agent"),
        personaFile: path.join(this.dataRoot, "kernel", "persona-live.md"),
      })
      : new AgentHost({ ...common, entryPath: this.legacyEntryPath });
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
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.kbWatch?.close();
    this.kbWatch = null;
    for (const w of this.mcpWatchers) {
      try {
        w.close();
      } catch {
        /* 已关就跳过 */
      }
    }
    this.mcpWatchers = [];
    if (this.mcpReloadTimer) {
      clearTimeout(this.mcpReloadTimer);
      this.mcpReloadTimer = null;
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

  /** 本轮最后一次模型错误（官方 message_end 带 stopReason=error / errorMessage） */
  private lastModelError: string | null = null;

  private onAgentEvent(ev: { type: string; [k: string]: unknown }): void {
    // 官方 RPC 的流式事件是 message_update + assistantMessageEvent.text_delta（字段名 delta）；
    // 旧回退 worker 用的是顶层 text_delta（字段名 text）。两种都收，不做事件白名单裁剪。
    const nested = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    const delta =
      ev.type === "message_update" && nested?.type === "text_delta" ? nested.delta
        : ev.type === "text_delta" && typeof ev.text === "string" ? ev.text
          : undefined;
    if (typeof delta === "string" && delta && this.liveCard) {
      this.liveCard.text = (this.liveCard.text ?? "") + delta;
      // 节流到 ~80ms：渲染层按 cardId 就地更新，不拉全量快照
      const now = Date.now();
      if (now - this.lastDeltaEmit >= 80) {
        this.lastDeltaEmit = now;
        this.notify({
          type: "delta",
          text: this.liveCard.text,
          thinking: this.liveCard.thinking,
          cardId: this.liveCard.id,
        });
      }
    }
    // 思考（reasoning 模型才有）单独收：正文只装 text_delta，两段在界面上必须分得开
    const thinkingDelta =
      ev.type === "message_update" && nested?.type === "thinking_delta" ? nested.delta : undefined;
    if (typeof thinkingDelta === "string" && thinkingDelta && this.liveCard) {
      this.liveCard.thinking = (this.liveCard.thinking ?? "") + thinkingDelta;
      const now = Date.now();
      if (now - this.lastDeltaEmit >= 80) {
        this.lastDeltaEmit = now;
        this.notify({
          type: "delta",
          text: this.liveCard.text,
          thinking: this.liveCard.thinking,
          cardId: this.liveCard.id,
        });
      }
    }
    // 模型错误由 Pi 写进最终消息；只记录，等本轮结束再决定要不要落卡（重试中别抢先判失败）
    if (ev.type === "message_end") {
      const m = ev.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
      if (m?.role === "assistant" && m.stopReason === "error" && m.errorMessage) {
        this.lastModelError = m.errorMessage;
      }
    }
    // 重试状态走状态行；中文「周限额」话术 Pi 内置词表认不出，用官方 abort_retry 立刻止损
    if (ev.type === "auto_retry_start") {
      const attempt = typeof ev.attempt === "number" ? ev.attempt : 1;
      const max = typeof ev.maxAttempts === "number" ? ev.maxAttempts : 3;
      const detail = typeof ev.errorMessage === "string" ? ev.errorMessage : "";
      this.setTurn({ activity: "model", activityName: `自动重试 ${attempt}/${max}`, activityAt: Date.now() });
      if (/用量上限|额度不足|配额已用|购买积分|请升级|Token Plan|周限额/i.test(detail) && !this.turnErrorReported) {
        this.turnErrorReported = true;
        void this.host?.request("abort_retry").catch(() => undefined);
        this.card({ kind: "system", text: "端点提示额度/配额已用尽，已停止自动重试。换模型或等额度恢复后再发。" });
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
  /**
   * 完整工具面：管理型 8 件 + L1 插件 + L2 MCP（同一道门禁，只是来源不同）。
   * L1/MCP 来自 Map 遍历（加载完成先后不定）——按名字排序，保证工具段前缀稳定（缓存友好）。
   */
  private allTools(): ToolSchema[] {
    const extra = [...this.l1.toolSchemas(), ...this.mcp.schemas()].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
    return [...TOOL_JSON, ...extra];
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
    if (reused) {
      this.snapshotTeamRoots(id);
      return { id, name: reused.name, reused };
    }
    const created = this.tools.createTeam(prettyName, id, !machine);
    this.snapshotTeamRoots(created.id);
    return { id: created.id, name: created.name, reused: null };
  }

  /** 建队时快照会话根；已记过的团队不覆盖（用户的显式修改优先） */
  private snapshotTeamRoots(teamId: string): void {
    try {
      if (this.teamStore.readTeam(teamId).roots) return;
      this.teamStore.setRoots(teamId, this.roots);
    } catch {
      /* 团队记录写不进去不阻塞建队 */
    }
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
    this.lastModelError = null;
    this.turnErrorReported = false;
    const beforeIn = this.usage.sessionIn;
    const beforeOut = this.usage.sessionOut;
    // 从收到指令那一刻就开始计时：避免冷启动/首 token 期间界面完全静默
    this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
    try {
      const host = await this.ensureHost();
      // 人设/记忆/技能注入每轮现取：官方扩展在 before_agent_start 重读文件，天然热更新
      await host.updateSystemPrompt(this.systemPrompt());
      this.setTurn({ phase: "accepted", busy: true });
      // 官方 prompt 的响应只代表被接受；PiRpcHost.prompt() 会等到官方 agent_settled
      const promptResult = await host.prompt(userText);
      this.log("prompt_ok", { disposition: promptResult?.disposition ?? "started" });
      if (this.abortRequested) {
        this.card({ kind: "system", text: "已停止（已产出的内容保留）。" });
      }
      // 模型报错但一个字都没产出时，必须给错误卡，不能留下空气泡当作"不回复"
      // （错误由 onAgentEvent 写入，TS 不跨方法追踪属性 narrowing，这里显式收成局部变量）
      const modelError = this.lastModelError as string | null;
      if (modelError && !(live.text ?? "").trim()) {
        const fail = this.classifyError(new Error(modelError));
        this.failTurn(fail.code, `${fail.message}（端点原文：${modelError.slice(0, 160)}）`, fail.action);
        return;
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
          cacheRead: stats.tokens.cacheRead ?? 0,
          cacheWrite: stats.tokens.cacheWrite ?? 0,
          cost: stats.cost ?? 0,
          contextTokens: stats.contextTokens,
          contextWindow: stats.contextWindow,
          contextPercent: stats.contextPercent ?? null,
        });
        // 缓存命中可观测：按轮落一行（agent.log），命中率掉时能回查到哪一轮、哪次变更之后
        {
          const prompt = stats.tokens.input + (stats.tokens.cacheRead ?? 0) + (stats.tokens.cacheWrite ?? 0);
          this.log("usage_round", {
            in: stats.tokens.input,
            out: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead ?? 0,
            cacheWrite: stats.tokens.cacheWrite ?? 0,
            hitRate: prompt > 0 ? Math.round(((stats.tokens.cacheRead ?? 0) / prompt) * 1000) / 10 : null,
          });
        }
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
    // 技能注入只改当轮 user 消息（尾部）：system prompt 与历史前缀原样，缓存命中不被技能抖动打穿
    if (this.pendingSkillText) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "user") {
          messages[i] = { role: "user", content: `${this.pendingSkillText}\n\n${messages[i].content}` };
          break;
        }
      }
    }
    try {
      for (let round = 0; round < 8; round++) {
        let roundText = "";
        const result = await streamChat({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: usedModel,
          messages,
          tools: this.allTools(),
          onDelta: (t) => {
            roundText += t;
            patchLive(roundText, true);
          },
        });
        this.tokensUsed += result.promptTokens + result.completionTokens;
        // 口径与 Pi 路径一致：sessionIn = 未命中缓存的输入；命中/写入单独累计（端点没报就是 0）
        const hit = Math.max(0, result.cacheRead);
        const write = Math.max(0, result.cacheWrite);
        const unhit = Math.max(0, result.promptTokens - hit);
        this.setUsage({
          turnIn: result.promptTokens,
          turnOut: result.completionTokens,
          sessionIn: this.usage.sessionIn + unhit,
          sessionOut: this.usage.sessionOut + result.completionTokens,
          cacheRead: this.usage.cacheRead + hit,
          cacheWrite: this.usage.cacheWrite + write,
          contextTokens: this.usage.contextTokens + result.promptTokens + result.completionTokens,
        });
        this.log("usage_direct", { in: result.promptTokens, out: result.completionTokens, cacheRead: hit, cacheWrite: write });
        // 按次记账（M2-11）+ 软上限检查（达限提示/可切备用模型；不静默停机）
        appendUsage(this.dataRoot, {
          at: new Date().toISOString(),
          kind: "turn",
          in: result.promptTokens,
          out: result.completionTokens,
          model: usedModel,
          cacheRead: hit,
          cacheWrite: write,
        });
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

  /**
   * 提交一轮：卡片 + 落史 + 回合状态 + 结束后排水（排队输入）。
   * `internal`：巡检回合——不进「你」的声音、不改会话标题，用户看到的是那张「开始跟进」卡。
   */
  private submitTurn(text: string, att?: TurnAttachments, opts?: { internal?: boolean }): void {
    // 会话可以一条不剩：这时候开口说话，就地开一条再写，不用先点「新建会话」
    this.ensureThreadId();
    // 技能激活（M2-10）：每轮按输入重算，命中后 allowed-tools 强制到工具门禁
    this.activateSkillsFor(text);
    // 本轮随附（M1-16）：文件注入 + 图片落盘；带不上的如实出卡，不静默丢
    let fullText = text;
    if (opts?.internal) {
      fullText = text;
    } else if (att && (att.files?.length || att.images?.length)) {
      if (!this.projectRoot && att.files?.length) {
        // 无主根会话：文件无法相对工作区解析，如实说，不拿进程 cwd 冒充（图片仍可带）
        this.card({ kind: "system", text: "当前会话没有工作区，文件随附带不上；先在顶部选一个工作区，或直接把内容贴进消息。" });
      }
      const effective = this.projectRoot ? att : { images: att.images };
      const built = buildTurnAttachments(this.projectRoot || this.dataRoot, this.dataRoot, text, effective);
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
    this.log("turn_start", { chars: text.length, model: this.activeModelConfig()?.model ?? "", modelId: this.activeModelId() ?? "default", threadId: this.currentThreadId, internal: !!opts?.internal });
    if (!opts?.internal) this.threads.autoTitle(this.currentThreadId, text);
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
      await this.host.steer(text);
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
    const cfg = this.activeModelConfig();
    const apiKey = this.activeApiKey();
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
        .map((p) => {
          const face = avatarById(p.avatarId) ?? avatarFor(p.name);
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
            lastStep: this.memberLastStep.get(key),
            budgetUsed: Math.round((this.memberUsage.get(key) ?? 0) / 1000),
            budgetTotal: Math.round(p.limits.budgetTokens / 1000),
            rejections: activeTask?.rejectRounds ?? 0,
            rejectionLimit: activeTask?.rejectLimit ?? 3,
            toolWhitelist: p.tools,
            effectiveTools,
            color: face.color,
            avatarId: face.id,
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
    // 没有 team 目录也不能提前返回：底下的兜底要保证"有工单就必须出现在台账上"
    const teamDirs = fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      : [];
    for (const entry of teamDirs) {
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
            readRoots: task.readRoots,
            workspaceRoot: task.workspaceRoot,
            evidenceCount: task.evidence.length,
            version: task.version,
            parentId: task.parentId ?? undefined,
            rejectRounds: task.rejectRounds,
            reviewer: task.reviewer ?? "user",
            evidence: task.evidence.map((e) => ({ label: e.label, ref: e.ref ?? "", verified: e.verified, at: e.at })),
            deliverables: task.deliverables?.map((d) => ({ path: d.path, ref: d.ref, bytes: d.bytes })),
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
    // 兜底：有权威工单却没有派单账本的（手工建单 / 迁移 / 账本被删）也要出现在台账上，
    // 否则用户看到的是"单不见了"。
    const seen = new Set(track.map((t) => t.id));
    for (const task of this.taskStore.list()) {
      if (seen.has(task.id)) continue;
      track.push({
        id: task.id,
        teamId: task.teamId,
        title: task.title,
        status: task.status,
        statusNote: `${task.status} · ${task.member ?? "风铃"} · 证据 ${task.evidence.length}`,
        member: task.member,
        at: task.updatedAt,
        threadId: task.threadId,
        readRoots: task.readRoots,
        workspaceRoot: task.workspaceRoot,
        evidenceCount: task.evidence.length,
        version: task.version,
        parentId: task.parentId ?? undefined,
        rejectRounds: task.rejectRounds,
        reviewer: task.reviewer ?? "user",
        evidence: task.evidence.map((e) => ({ label: e.label, ref: e.ref ?? "", verified: e.verified, at: e.at })),
        deliverables: task.deliverables?.map((d) => ({ path: d.path, ref: d.ref, bytes: d.bytes })),
      });
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
        const cfg = this.activeModelConfig();
        // C3：会话 → 工单归属计数（按 task.threadId 汇总；老单没记 threadId 就不归到任何会话，不猜）
        const threadCounts = countTasksByThread(this.taskStore.list());
        const snap: RpcContracts["session.snapshot"]["result"] = {
          // 项目名只作显示；没有主根时如实说「临时」，不拿数据根目录名冒充
          workspace: {
            project: this.projectRoot ? path.basename(this.projectRoot) : "临时",
            subdir: this.roots.extras.length ? `可读 ${this.roots.extras.length}` : "工作区",
            ...(this.projectRoot ? { primary: this.projectRoot } : {}),
            extras: this.roots.extras.map((r) => ({
              path: r.path,
              mode: r.mode,
              ...(r.label ? { label: r.label } : {}),
            })),
          },
          thread: {
            id: this.currentThreadId,
            title: this.currentThreadId ? (this.threads.get(this.currentThreadId)?.title ?? "新会话") : "",
            projectRoot: this.threads.get(this.currentThreadId)?.projectRoot,
          },
          threads: this.threads
            .list()
            .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, counts: threadCounts.get(t.id) })),
          // 真在跑的成员单：台账"进行中"不等于在跑（卡住/停机也会留在 in_progress 历史里）
          running: this.runningTaskIds(),
          // 无主单计数：会话删了单还在（老版本不级联）。界面据此给一键清理出口
          orphans: this.orphanTasks().length,
          project: {
            root: this.projectRoot,
            trusted: this.projectRoot ? this.trust.isTrusted(this.projectRoot) : false,
            hasMcp: this.projectRoot ? fs.existsSync(path.join(this.projectRoot, ".lynn", "mcp.json")) : false,
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
          // 删除审批不被"切权限档"顺带放行：那是用户明确要求逐次点头的事
          if (pending.kind === "delete") continue;
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
              const effective = this.projectRoot ? attachments! : { images: attachments!.images };
              const built = buildTurnAttachments(this.projectRoot || this.dataRoot, this.dataRoot, trimmed, effective);
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
        if (!this.projectRoot) return { files: [] } as RpcContracts[M]["result"];
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

      // 技能管理（M2-10）：列表含停用标记；启停落 prefs.disabledSkills 并即时重发现
      case "skills.list": {
        const trusted = this.trust?.isTrusted(this.projectRoot) ?? false;
        const roots = [
          { dir: path.join(this.dataRoot, "skills"), level: "user" as const },
          { dir: path.join(this.projectRoot, ".lynn", "skills"), level: "project" as const },
          { dir: path.join(this.dataRoot, "plugins"), level: "plugin" as const },
        ].filter((r) => r.level !== "project" || trusted);
        const disabled = this.settings.getPrefs().disabledSkills ?? [];
        const { entries, errors } = discoverSkills(roots);
        return {
          skills: entries.map((e) => ({
            name: e.name,
            description: e.description,
            allowedTools: e.allowedTools,
            level: e.level,
            dir: e.dir,
            disabled: disabled.includes(e.name),
            warnings: e.warnings,
          })),
          errors,
        } as RpcContracts[M]["result"];
      }

      case "skills.toggle": {
        const p = params as { name: string; enabled: boolean };
        if (!String(p.name).trim()) {
          return { ok: false, error: "技能名不能为空" } as RpcContracts[M]["result"];
        }
        const cur = this.settings.getPrefs().disabledSkills ?? [];
        const next = p.enabled ? cur.filter((n) => n !== p.name) : [...new Set([...cur, p.name])];
        this.settings.savePrefs({ disabledSkills: next });
        this.reloadSkills();
        this.log("skill_toggled", { skill: p.name, enabled: p.enabled });
        return { ok: true, enabled: p.enabled } as RpcContracts[M]["result"];
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

      // MCP 实况：配置文件里写了几台 + 实际连上几台 + 各带几个工具（不推断、不美化）
      case "mcp.status": {
        return this.mcpStatusPayload() as RpcContracts[M]["result"];
      }

      // 手动重连：改完 mcp.json 立刻生效。重连是异步的（要拉起子进程），
      // 先回执"重连前的实况"，完成后落一张卡；界面随后轮询 mcp.status 刷新。
      case "mcp.reload": {
        void this.reloadMcpLive("manual").catch((err) =>
          this.card({ kind: "system", text: `MCP 重连失败：${err instanceof Error ? err.message : String(err)}` }),
        );
        return { ok: true, ...this.mcpStatusPayload() } as RpcContracts[M]["result"];
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

      case "task.grantRead": {
        const { taskId, dir, dirs, allowDriveRoot } = params as {
          taskId: string;
          dir?: string;
          dirs?: string[];
          allowDriveRoot?: boolean;
        };
        const list = dirs?.length ? dirs : dir ? [dir] : [];
        return this.grantReadRoots(String(taskId), list, { allowDriveRoot }) as RpcContracts[M]["result"];
      }

      case "task.revokeRead": {
        const { taskId, dir } = params as { taskId: string; dir?: string };
        return this.revokeReadRoot(String(taskId), dir ? String(dir) : undefined) as RpcContracts[M]["result"];
      }

      case "task.dismiss": {
        const { taskId } = params as { taskId: string };
        return this.dismissTask(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.snapshotProject": {
        const { taskId } = params as { taskId: string };
        return this.snapshotProject(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.export": {
        const { taskId } = params as { taskId: string };
        return this.exportTask(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.remove": {
        const { taskId } = params as { taskId: string };
        return this.removeTask(String(taskId)) as RpcContracts[M]["result"];
      }

      case "task.purgeOrphans": {
        const r = this.purgeOrphanTasks();
        return { ok: true, removed: r.removed, kept: r.kept } as RpcContracts[M]["result"];
      }

      // 建团队（§4.10.3 修正）：界面上给名字就够，ID 由系统生成
      case "team.create": {
        const { name } = params as { name?: string };
        try {
          const created = this.tools.createTeam(name ? String(name) : undefined);
          this.snapshotTeamRoots(created.id);
          this.card({ kind: "system", text: `已建团队「${created.name}」（ID ${created.id}）。` });
          return { ok: true, id: created.id, name: created.name } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      // 编制管理（用户手动）：列 / 改岗位 / 删成员 / 解散
      case "team.list": {
        try {
          const teams = this.teamStore.listTeams().map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            createdAt: t.createdAt,
            members: this.teamStore.listMembers(t.id).map((p) => ({
              name: p.name,
              role: p.role,
              goal: p.goal,
              body: p.body,
              tools: p.tools,
              model: p.model,
              avatarId: (avatarById(p.avatarId) ?? avatarFor(p.name)).id,
            })),
          }));
          return { teams } as RpcContracts[M]["result"];
        } catch (err) {
          return { teams: [], error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "team.member.save": {
        const { teamId, name, role, goal, body, avatarId } = params as {
          teamId: string;
          name: string;
          role?: string;
          goal?: string;
          body?: string;
          avatarId?: string;
        };
        try {
          const team = this.teamStore.readTeam(String(teamId));
          if (team.status !== "active") {
            return { ok: false, error: `团队「${team.name}」已解散，岗位只能读` } as RpcContracts[M]["result"];
          }
          if (avatarId !== undefined && !isAvatarId(avatarId)) {
            return { ok: false, error: `未知头像 id：${avatarId}` } as RpcContracts[M]["result"];
          }
          const updated = this.teamStore.updateMember(String(teamId), String(name), {
            ...(role !== undefined ? { role: String(role) } : {}),
            ...(goal !== undefined ? { goal: String(goal) } : {}),
            ...(body !== undefined ? { body: String(body) } : {}),
            ...(avatarId !== undefined ? { avatarId } : {}),
          });
          this.card({ kind: "system", text: `已更新成员「${updated.name}」的岗位（${updated.role}）：下一单按新说明执行。` });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "team.member.remove": {
        const { teamId, name } = params as { teamId: string; name: string };
        const busy = this.memberActive.get(`${teamId}::${name}`);
        if (busy) {
          return { ok: false, error: `「${name}」手上还有在跑的单（${busy}）：先停单再删` } as RpcContracts[M]["result"];
        }
        const open = this.taskStore
          .list()
          .find((t) => t.teamId === teamId && t.member === name && t.status !== "done" && t.status !== "canceled");
        if (open) {
          return {
            ok: false,
            error: `「${name}」名下还有未收的单（${open.id} · ${open.status}）：先验收或取消再删`,
          } as RpcContracts[M]["result"];
        }
        try {
          this.teamStore.removeMember(String(teamId), String(name));
          this.card({ kind: "system", text: `已把「${name}」移出编制（岗位档案已删，历史派单记录保留）。` });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "team.dissolve": {
        const { teamId } = params as { teamId: string };
        const running = [...this.memberActive.entries()]
          .filter(([key]) => key.startsWith(`${teamId}::`))
          .map(([, id]) => id);
        if (running.length) {
          return {
            ok: false,
            error: `还有 ${running.length} 张单在跑（${running.join("、")}）：先停单再解散`,
          } as RpcContracts[M]["result"];
        }
        const open = this.taskStore.list().filter((t) => t.teamId === teamId && t.status !== "done" && t.status !== "canceled");
        if (open.length) {
          return {
            ok: false,
            error: `还有 ${open.length} 张未收的单（${open.map((t) => t.id).join("、")}）：先验收或取消再解散`,
          } as RpcContracts[M]["result"];
        }
        try {
          const rec = this.teamStore.readTeam(String(teamId));
          this.teamStore.dissolveTeam(String(teamId));
          this.card({ kind: "system", text: `已解散团队「${rec.name}」：档案保留为资产，不能再派活。` });
          return { ok: true } as RpcContracts[M]["result"];
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
          void this.host!.abort().catch(() => undefined);
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
          action: "approve" | "reject" | "reopen";
          reason?: { what: string; expect: string; deadline: string };
        };
        try {
          /* 重开：风铃代验可能判错，锁死的归档单得留一条只有用户能走的路 */
          if (p.action === "reopen") {
            const rec = this.taskStore.transition(p.taskId, "in_progress");
            this.taskStore.setReviewer(p.taskId, "user");
            this.taskCase.append(p.taskId, { kind: "transition", member: "user", text: "用户重开已归档单" });
            this.taskCase.appendSummary(p.taskId, "用户重开：从归档拉回执行中");
            this.card({ kind: "system", text: `已重开 · ${p.taskId}，回到执行中。要她接着干就用底栏下令派回去。` });
            return { ok: true, status: rec.status } as RpcContracts[M]["result"];
          }
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

      case "plugins.safeMode": {
        const p = params as { on: boolean };
        // 进安全模式是自动的（连续崩溃），出安全模式只能是人点的这一下
        this.pluginSet.setSafeMode(p.on, p.on ? "用户手动开启" : "");
        if (!p.on) {
          this.emit({
            type: "tool",
            badge: "工具",
            title: "已退出安全模式",
            body: "插件按启用状态重新加载；下次变更会重新拍快照。",
          });
        }
        return { ok: true } as RpcContracts[M]["result"];
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
        const cfg = this.activeModelConfig();
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
        try {
          this.settings.saveModel({
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey: p.apiKey,
            previous: this.settings.getModel(),
          });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          // 主进程的 ipcMain.handle 会把 throw 吞成 {error}，渲染层不会抛；这里显式回 ok:false
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "config.test": {
        const p = params as { baseUrl: string; apiKey: string; model: string };
        // 输入框留空 = 用已保存的 Key 测（渲染层拿不到明文，由主进程解密）
        let apiKey = p.apiKey?.trim() ?? "";
        if (!apiKey) {
          const stored = this.activeModelConfig();
          if (!stored) {
            return { ok: false, error: "还没有保存过 Key，先填一个再测。" } as RpcContracts[M]["result"];
          }
          apiKey = this.activeApiKey() ?? "";
        }
        if (!apiKey) return { ok: false, error: "Key 无法解密，请重新填一次。" } as RpcContracts[M]["result"];
        return probeEndpoint({ ...p, apiKey }) as unknown as RpcContracts[M]["result"];
      }

      // ---------- 模型库：多条配置 / 全局默认 / 每对话覆盖 ----------

      case "model.list": {
        const entries = this.settings.getModels();
        const defaultId = this.settings.getDefaultModelId();
        const threadId = this.threads.get(this.currentThreadId)?.modelId ?? null;
        const activeId = this.activeModelId() ?? defaultId ?? entries[0]?.id ?? null;
        return {
          models: entries.map((e) => ({
            id: e.id,
            label: e.label,
            provider: e.provider,
            baseUrl: e.baseUrl,
            model: e.model,
            apiKeySet: !!e.apiKey?.data,
            isDefault: e.id === defaultId,
            isThreadModel: !!threadId && e.id === threadId,
            updatedAt: e.updatedAt,
          })),
          defaultModelId: defaultId,
          threadModelId: threadId,
          activeModelId: activeId,
          threadTitle: this.threads.get(this.currentThreadId)?.title ?? "新会话",
        } as RpcContracts[M]["result"];
      }

      case "model.save": {
        const p = params as { id?: string; label: string; provider: string; baseUrl: string; model: string; apiKey?: string };
        if (!p.baseUrl?.trim() || !p.model?.trim()) {
          return { ok: false, error: "Base URL 和模型都要填。" } as RpcContracts[M]["result"];
        }
        try {
          const entry = this.settings.upsertModel({
            id: p.id,
            label: p.label,
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey: p.apiKey,
          });
          return { ok: true, id: entry.id } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "model.remove": {
        const p = params as { id: string };
        const r = this.settings.removeModel(String(p.id));
        if (!r.ok) return { ok: false, error: r.error ?? "删除失败" } as RpcContracts[M]["result"];
        // 清理所有指向它的对话覆盖，避免留悬空 id
        for (const t of this.threads.list()) {
          if (t.modelId === p.id) this.threads.setModel(t.id, null);
        }
        void this.resetAgentHost();
        return { ok: true, defaultModelId: r.defaultModelId } as RpcContracts[M]["result"];
      }

      case "model.setDefault": {
        const p = params as { id: string };
        try {
          this.settings.setDefaultModel(String(p.id));
          void this.resetAgentHost();
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "model.setThread": {
        const p = params as { id: string | null };
        const id = p.id === null || p.id === "" ? null : String(p.id);
        if (id && !this.settings.getModels().some((e) => e.id === id)) {
          return { ok: false, error: "模型不存在" } as RpcContracts[M]["result"];
        }
        try {
          this.threads.setModel(this.currentThreadId, id);
          // 换模型必须换 Pi 运行时（--provider/--model 是启动参数），下一条消息重建
          void this.resetAgentHost();
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "model.test": {
        const p = params as { id?: string; baseUrl?: string; apiKey?: string; model?: string };
        let baseUrl = p.baseUrl?.trim() ?? "";
        let model = p.model?.trim() ?? "";
        let apiKey = p.apiKey?.trim() ?? "";
        if (p.id) {
          const cfg = this.settings.getModel(p.id);
          if (!cfg) return { ok: false, error: "模型不存在" } as RpcContracts[M]["result"];
          baseUrl = baseUrl || cfg.baseUrl;
          model = model || cfg.model;
          if (!apiKey) apiKey = loadApiKey(this.settings, (b) => this.decryptBlob(b), p.id) ?? "";
        }
        if (!baseUrl || !model) return { ok: false, error: "Base URL 和模型都要填。" } as RpcContracts[M]["result"];
        if (!apiKey) return { ok: false, error: "请先填写 API Key（新配置不能借用别的模型 Key）。" } as RpcContracts[M]["result"];
        return probeEndpoint({ baseUrl, apiKey, model }) as unknown as RpcContracts[M]["result"];
      }

      case "config.prefs": {
        const p = params as { autoStart: boolean; trayOnClose?: boolean; notify?: boolean; softBudgetTokens?: number; fallbackModel?: string; lang?: "zh" | "en"; captureHotkey?: string; heartbeat?: boolean };
        if (p.lang !== undefined && !isLang(p.lang)) {
          return { ok: false, error: `未知语言：${String(p.lang)}（只支持 zh / en）` } as unknown as RpcContracts[M]["result"];
        }
        if (p.captureHotkey !== undefined && !isCaptureHotkey(p.captureHotkey)) {
          return { ok: false, error: `截图快捷键格式不对：${String(p.captureHotkey)}（要像 Alt+Shift+S）` } as unknown as RpcContracts[M]["result"];
        }
        const saved = this.settings.savePrefs({
          autoStart: Boolean(p.autoStart),
          ...(p.trayOnClose !== undefined ? { trayOnClose: Boolean(p.trayOnClose) } : {}),
          ...(p.notify !== undefined ? { notify: Boolean(p.notify) } : {}),
          ...(p.softBudgetTokens !== undefined ? { softBudgetTokens: Math.max(0, Number(p.softBudgetTokens) || 0) } : {}),
          ...(p.fallbackModel !== undefined ? { fallbackModel: String(p.fallbackModel).trim() } : {}),
          ...(p.lang !== undefined ? { lang: p.lang } : {}),
          ...(p.captureHotkey !== undefined ? { captureHotkey: String(p.captureHotkey).trim() } : {}),
          ...(p.heartbeat !== undefined ? { heartbeat: Boolean(p.heartbeat) } : {}),
        });
        return {
          ok: true,
          autoStart: saved.autoStart,
          trayOnClose: saved.trayOnClose,
          notify: saved.notify,
          softBudgetTokens: saved.softBudgetTokens,
          fallbackModel: saved.fallbackModel,
          lang: saved.lang,
          captureHotkey: saved.captureHotkey,
          heartbeat: saved.heartbeat,
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
        if (!this.projectRoot) {
          return { ok: false, error: "当前会话没有工作区：先选一个目录再设信任。" } as RpcContracts[M]["result"];
        }
        this.trust.setTrusted(this.projectRoot, Boolean(trusted));
        // 重新连 MCP 是异步的：先回执，再在后台完成并落一张卡
        this.watchMcpConfig();
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
        const wasCurrent = p.id === this.currentThreadId;
        // 先把当前会话落盘，再删——顺序反了会把刚删的会话又写回来
        if (wasCurrent) this.persistThread();
        // 会话 = 任务容器：删会话必须连带撤掉它名下的工单（在跑的先停）。
        // 只删对话记录会把工单留成"无主单"——台账照列、动态区照动，用户看不懂。
        const purged = this.purgeThreadTasks(p.id);
        this.threads.remove(p.id);
        if (wasCurrent) {
          // 断开旧会话再切：否则 switchThread 的落盘会把已删的会话写成孤儿文件
          this.currentThreadId = "";
          const rest = this.threads.list();
          if (rest.length) this.switchThread(rest[0].id);
          else this.enterEmptySession();
        }
        return {
          ok: true,
          removedTasks: purged.removed,
          keptTasks: purged.kept,
          threadsLeft: this.threads.list().length,
        } as RpcContracts[M]["result"];
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

      case "project.setRoot": {
        const { root } = params as { root: string };
        const raw = String(root ?? "").trim();
        if (!raw) return { ok: false, error: "工作区不能为空" } as RpcContracts[M]["result"];
        // 支持 `cd 子目录`、`~/xxx`：相对路径基于当前根解析，绝对路径原样
        const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
          ? path.join(os.homedir(), raw.slice(1))
          : raw;
        const abs = path.isAbsolute(expanded)
          ? path.resolve(expanded)
          : this.projectRoot
            ? path.resolve(this.projectRoot, expanded)
            : path.resolve(expanded);
        const dirErr = rootDirError(abs);
        if (dirErr) return { ok: false, error: dirErr } as RpcContracts[M]["result"];
        if (isDriveRoot(abs)) {
          return { ok: false, error: "不能把整个盘作为可写工作区：请选具体项目目录（整盘只能作为只读根）。" } as RpcContracts[M]["result"];
        }
        const forbid = forbiddenRootReason(abs, this.dataRoot);
        if (forbid) return { ok: false, error: forbid } as RpcContracts[M]["result"];
        const from = this.projectRoot || "（无）";
        this.setSessionRoots({ ...this.roots, primary: abs });
        this.card({
          kind: "system",
          text: `工作区已换成 ${abs}（原 ${from}）。@ 文件检索、附件与 Pi 的 cwd 都跟着走；项目级插件/MCP 只有该目录被信任时才加载。`,
        });
        return { ok: true, root: abs, trusted: this.trust.isTrusted(abs) } as RpcContracts[M]["result"];
      }

      case "project.clearRoot": {
        this.setSessionRoots(emptyRoots());
        this.card({
          kind: "system",
          text: "这个会话先不用工作区：接下来的任务产出会落在任务卷宗里（~/.lynn/tasks/<id>/workspace）。随时可以在顶栏再选一个。",
        });
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "workspace.prefs": {
        const prefs = this.settings.getPrefs();
        return {
          ...(prefs.defaultWorkspace ? { defaultWorkspace: prefs.defaultWorkspace } : {}),
          knownReadRoots: prefs.knownReadRoots ?? [],
        } as RpcContracts[M]["result"];
      }

      case "workspace.savePrefs": {
        const p = params as { defaultWorkspace?: string | null; knownReadRoots?: string[] };
        let defaultWorkspace: string | undefined;
        if (p.defaultWorkspace !== undefined) {
          const raw = String(p.defaultWorkspace ?? "").trim();
          if (!raw) {
            defaultWorkspace = "";
          } else {
            const abs = path.resolve(raw);
            const dirErr = rootDirError(abs) ?? forbiddenRootReason(abs, this.dataRoot);
            if (dirErr) return { ok: false, error: dirErr } as RpcContracts[M]["result"];
            if (isDriveRoot(abs)) {
              return { ok: false, error: "默认工作区不能是整盘：请选具体目录。" } as RpcContracts[M]["result"];
            }
            defaultWorkspace = abs;
          }
        }
        let knownReadRoots: string[] | undefined;
        if (p.knownReadRoots !== undefined) {
          const out: string[] = [];
          for (const raw of p.knownReadRoots) {
            const abs = path.resolve(String(raw));
            const err = rootDirError(abs) ?? forbiddenRootReason(abs, this.dataRoot);
            if (err) return { ok: false, error: err } as RpcContracts[M]["result"];
            out.push(abs);
          }
          knownReadRoots = [...new Set(out)];
        }
        const saved = this.settings.savePrefs({
          ...(defaultWorkspace !== undefined ? { defaultWorkspace } : {}),
          ...(knownReadRoots !== undefined ? { knownReadRoots } : {}),
        });
        return {
          ok: true,
          ...(saved.defaultWorkspace ? { defaultWorkspace: saved.defaultWorkspace } : {}),
          knownReadRoots: saved.knownReadRoots ?? [],
        } as RpcContracts[M]["result"];
      }

      case "data.usage": {
        const prefs = this.settings.getPrefs();
        return {
          usage: measureUsage(this.dataRoot),
          retention: prefs.retention,
        } as RpcContracts[M]["result"];
      }

      case "data.cleanup": {
        const p = params as { retention?: { scratchDays?: number; checkpointDays?: number; logDays?: number } };
        const base = this.settings.getPrefs().retention;
        const clamp = (v: unknown, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.min(365, Math.max(0, Math.floor(n))) : fallback;
        };
        const retention: Retention = {
          scratchDays: clamp(p?.retention?.scratchDays, base.scratchDays),
          checkpointDays: clamp(p?.retention?.checkpointDays, base.checkpointDays),
          logDays: clamp(p?.retention?.logDays, base.logDays),
        };
        if (p?.retention) this.settings.savePrefs({ retention });
        const r = runCleanup(this.dataRoot, retention);
        this.log("data_cleanup", { freedBytes: r.freedBytes, removed: r.removed.length });
        if (r.removed.length) {
          this.card({
            kind: "system",
            text: `已清理 ${r.removed.length} 项过程文件，释放 ${Math.round(r.freedBytes / 1024)} KB（交付物与证据没动）。`,
          });
        }
        return { ok: true, freedBytes: r.freedBytes, removed: r.removed.length } as RpcContracts[M]["result"];
      }

      case "workspace.get": {
        return {
          ...(this.projectRoot ? { primary: this.projectRoot } : {}),
          extras: this.roots.extras.map((r) => ({
            path: r.path,
            mode: r.mode,
            scope: r.scope,
            ...(r.label ? { label: r.label } : {}),
          })),
          readable: readableRoots(this.roots),
          writable: writableRoots(this.roots),
        } as RpcContracts[M]["result"];
      }

      case "workspace.addRoot": {
        const p = params as {
          path: string;
          mode?: "rw" | "ro";
          scope?: "session" | "team" | "task";
          label?: string;
          allowDriveRoot?: boolean;
        };
        const abs = path.resolve(String(p.path));
        const dirErr = rootDirError(abs);
        if (dirErr) return { ok: false, error: dirErr } as RpcContracts[M]["result"];
        if (isDriveRoot(abs) && p.mode === "rw") {
          return { ok: false, error: "整盘不能设为可写：请选具体目录（整盘只能只读）。" } as RpcContracts[M]["result"];
        }
        if (isDriveRoot(abs) && !p.allowDriveRoot) {
          return { ok: false, error: `${abs} 是整盘：只读授权整盘需要二次确认。` } as RpcContracts[M]["result"];
        }
        const forbid = forbiddenRootReason(abs, this.dataRoot);
        if (forbid) return { ok: false, error: forbid } as RpcContracts[M]["result"];
        const next = addRoot(this.roots, {
          path: abs,
          mode: p.mode === "rw" ? "rw" : "ro",
          scope: p.scope ?? "session",
          label: p.label,
          addedBy: "user",
        });
        this.setSessionRoots(next);
        return { ok: true, roots: readableRoots(next) } as RpcContracts[M]["result"];
      }

      case "workspace.removeRoot": {
        const { path: target } = params as { path: string };
        const next = removeRoot(this.roots, String(target));
        this.setSessionRoots(next);
        return { ok: true, roots: readableRoots(next) } as RpcContracts[M]["result"];
      }

      case "session.new": {
        // 新对话 = 新线程：旧会话留在磁盘上可切回，不再清空历史。
        // 不弹框（2026-11-10）：默认继承当前会话的根；显式传 projectRoot 才换。
        const { projectRoot } = (params ?? {}) as { projectRoot?: string };
        this.persistThread();
        const inherited: RootSet = projectRoot
          ? { primary: path.resolve(String(projectRoot)), extras: this.roots.extras }
          : this.roots;
        const meta = this.threads.create("新会话", inherited);
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
