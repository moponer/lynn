import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BoardData,
  Decision,
  FeedAuthor,
  FeedCard,
  FeedMention,
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
import type { VoicePort } from "./voice-policy";
import { ManagementTools, MANAGEMENT_ONLY_TOOLS } from "./management-tools";
import {
  LlmError,
  isQuotaMessage,
  probeEndpoint,
  streamChat,
  streamChatWithRetry,
  type ChatMessage,
  type ToolSchema,
} from "./llm";
import { compactKeepRecent, compactToolHistory } from "./history-compact";
import { composeTurnText } from "./turn-text";
import { prefixFingerprint } from "./prefix-hash";
import { discoverModels, endpointRiskError, normalizeBaseUrl, redactSecrets } from "./endpoint";
import { probeGateways } from "./gateways";
import { SettingsStore, loadApiKey, defaultDataRoot, type Prefs, type StoredModelConfig } from "./settings";
import { applyPiEnvironment } from "./pi-home";
import { reapOrphanWorkers } from "./agent-orphans";
import { McpRegistry, loadMcpConfig, loadMcpConfigAt, type McpServerConfig } from "./mcp";
import { CheckpointStore } from "./checkpoints";
import { measureUsage, runCleanup, type Retention } from "./cleanup";
import { buildZip, collectZipEntries, type ZipEntry } from "./zip";
import { TrustStore } from "./trust";
import { ThreadStore, type ThreadMeta } from "./threads";
import { buildTurnAttachments, searchProjectFiles, type TurnAttachments } from "./attachments";
import { PersonaStore, composeSystemPrompt } from "./persona";
import { MemoryStore, parseEntries, type MemoryKind } from "./memory";
import { PRESETS, loadProviders, saveProviders, presetContextWindow, type ProviderEntry } from "./providers";
import { CalendarStore, dueReminders } from "./calendar";
import { SchedulerStore, recover as recoverScheduler, type DueItem } from "./scheduler";
import { KnowledgeStore, watchKnowledge } from "./knowledge";
import { appendUsage, evaluateBudget, pickModel } from "./budget";
import { groupOf } from "../shared/task-groups";
import { magicWordsNotice } from "../shared/magic-words";
import { consultAdvisor, filterNotes, severityLabel, type AdvisorChatFn, type AdvisorSeverity } from "./advisor";
import { destructiveFamily } from "./toolkit";
import { LogGate } from "./log-policy";
import { detectTrailingRepetition, stripTrailingRepetition } from "./repetition";
import { estimateTaskScale, scaleLimits, type EvidencePolicy } from "./task-scale";
import {
  createStagePlan,
  finalizeStagePlan,
  reopenStage,
  shouldFinalize,
  stageBrief,
  stageDefsFor,
  stageLine,
  tryCompleteStage,
} from "./stage-plan";
import { findDuplicateAssignment } from "./assignment-guard";
import { compileLynnPrompt } from "./prompt-compiler";
import { resolveRole, mixedRoleRejection, roleGateNote, roleSpec, MEMBER_ROLE_IDS } from "./role-registry";
import { MemberPool, lessonsFromOutcome, type Lesson } from "./member-pool";
import { gateMemberCompile } from "./member-compile";
import { errorCopy, shouldMergeError, ERROR_MERGE_WINDOW_MS, type ErrorAction } from "./error-copy";
import { readDocxText } from "./docx-read";
// 写作规则（2026-11-15 重做）：可选外部插件 humanizer-stream，只往系统提示词里加一段约束，
// 不改任何模型输出（0.1 的展示层改写已删除）
import { humanizerStatus, loadHumanizer, setHumanizerEnabled, writingRulesSection } from "./humanizer";
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
import { TeamStore, effectiveToolsOf, generateTeamId, type MemberProfile } from "./team-store";
import {
  MEMBER_WORK_STYLE_BODY,
  MEMBER_PROFILE_RULES,
  validateMemberProfile,
  memberProfileRejection,
  writesProseDocs,
} from "./member-profile";
import { isAskingUserForOutputDetails, claimsDone, NO_DELIVERABLE_HINT, REPLY_GUARD_HINT } from "./reply-guard";
import {
  createDraft,
  listDrafts,
  reviewDraft,
  promoteDraft,
  discardDraft,
  draftsDir,
  type WorkshopKind,
} from "./workshop";
import { mergeStrings } from "../shared/i18n";
import { createSettingsRpc, type SettingsRpc } from "./rpc/settings-rpc";
import { createThreadRpc, type ThreadRpc } from "./rpc/thread-rpc";
import { createCalendarRpc, type CalendarRpc } from "./rpc/calendar-rpc";
import { createScheduleRpc, type ScheduleRpc } from "./rpc/schedule-rpc";
import { createKbRpc, type KbRpc } from "./rpc/kb-rpc";
import { createTaskRpc, type TaskRpc, type TaskRpcDeps } from "./rpc/task-rpc";
import {
  buildKernelRegistry,
  type CalendarRpcDeps,
  type ConfigRpcDeps,
  type DataRpcDeps,
  type HumanizerRpcDeps,
  type KbRpcDeps,
  type ModelRpcDeps,
  type RpcRegistry,
  type TaskRpcDeps as TaskRpcContractDeps,
  type ScheduleRpcDeps,
  type ThreadRpcDeps,
  type UiRpcDeps,
} from "./rpc-registry";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { ConnectorStore, CONNECTOR_CATALOG, probeConnector as probeConnectorLive } from "./connectors";
import { allPresets, buildSkillMd, installPreset, presetInstalled, SCHEDULE_PRESETS } from "./capability-catalog";
import { ProjectStore, defaultProjectName, type ProjectRecord } from "./projects";
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
import { TaskCase, type TimelineEvent } from "./task-case";
import { ContextStore } from "./context-store";
import { scanUiPlugins } from "./ui-plugins";
import { importPluginPackage } from "./plugin-package";
import { scanPluginCommands } from "./plugin-commands";
import { scanPluginMcp } from "./plugin-mcp";
import { listVersions, rollbackToVersion, KEEP_VERSIONS } from "./plugin-versions";
import { PluginHost } from "./plugin-host";
import { PluginSetStore } from "./plugin-set";
import {
  runMemberTask,
  validateBrief,
  MEMBER_EXEC_TOOLS,
  type MemberRunResult,
  type MemberPost,
} from "./member-runner";
import {
  collectHeartbeatFacts,
  heartbeatSignature,
  heartbeatIsEmpty,
  heartbeatPrompt,
  heartbeatWakeDecision,
  capHeartbeatFacts,
  probeDelayMs,
  type HeartbeatFacts,
  type WakeGateState,
} from "./heartbeat";
import { L1Host } from "./plugin-l1";
import { AgentHost, type AgentStats, type RpcToolSpec } from "./agent-host";
import { PiRpcHost } from "./pi-rpc-host";
import { unpackedPath } from "./unpack-path";
import { execFile, execSync } from "node:child_process";

/**
 * 构建号（2026-11-13 审计 #19）：git 提交计数，与 vite.config.ts 同一算法——
 * 同一仓库的前后端必然同值且随提交单调，"界面新内核旧"才能可靠判定。
 * 时间戳取自构建机时钟，跨机器/时钟回拨会判错。无 git（打包介质）回落时间戳。
 * 模块级缓存：app.info 每次握手都调，不重复 spawn git。
 */
let cachedBuildId: string | null = null;
function kernelBuildId(): string {
  if (cachedBuildId) return cachedBuildId;
  try {
    const n = execSync("git rev-list --count HEAD", {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    cachedBuildId = /^\d+$/.test(n) ? `git-${n}` : `t-${Date.now()}`;
  } catch {
    cachedBuildId = `t-${Date.now()}`;
  }
  return cachedBuildId;
}

const SSH_READ_ONLY_COMMANDS = new Set([
  "ls", "ps", "df", "du", "free", "uptime", "uname", "whoami", "hostname", "date",
  "cat", "head", "tail", "grep", "egrep", "fgrep", "find", "stat", "wc", "sort", "uniq",
  "journalctl", "ss", "netstat", "ip", "lsblk", "lscpu", "vmstat", "pgrep", "pidof", "id",
  "mount", "systemctl", "top",
]);

/** SSH 只读命令白名单：在真正连接前做纯字符串校验，便于脱离远端环境单测 */
export function sshReadOnlyCommandError(command: string): string | null {
  const cmd = String(command ?? "").trim();
  if (!cmd) return "命令不能为空。";
  if (/[`>;\r\n]/.test(cmd) || cmd.includes("$(") || cmd.includes("<(") || cmd.includes("|") || cmd.includes("&")) {
    return "拒绝执行：SSH 只读排查不支持重定向、命令替换、多条命令或管道。只读排查：多条命令/管道请拆分执行。";
  }
  const tokens = cmd.split(/\s+/);
  const name = tokens[0];
  if (!SSH_READ_ONLY_COMMANDS.has(name)) {
    return `拒绝执行：命令「${name}」不在 SSH 只读白名单。SSH 只用于只读排查（看日志/磁盘/进程）；要改配置或重启服务，请让用户自己动手。`;
  }
  const args = tokens.slice(1).map((t) => t.replace(/^["']|["']$/g, ""));
  if (name === "systemctl" && args.find((t) => !t.startsWith("-")) !== "status") {
    return "拒绝执行：systemctl 只允许 status 子命令；启动、停止、重启与改配置请让用户自己动手。";
  }
  if (name === "top" && !args.includes("-b")) {
    return "拒绝执行：top 只允许 -b 批处理模式（可搭配 -n 指定次数），交互模式不适用只读排查。";
  }
  if (name === "mount" && args.length > 0 && !(args.length === 1 && args[0] === "-l")) {
    return "拒绝执行：mount 只允许无参数或 -l 查看挂载，不允许挂载/卸载操作。";
  }
  if (name === "ip" && args.some((t) => /^(set|add|del|delete|change|replace|flush|save|restore|exec)$/i.test(t))) {
    return "拒绝执行：ip 只允许 show/list/get 等只读查看，不允许改地址、链路、路由或借 netns exec 执行命令。";
  }
  if (name === "find" && args.some((t) => /^-(delete|exec|execdir|ok|okdir|fprintf|fprint)$/i.test(t))) {
    return "拒绝执行：find 只允许查找与查看，禁止 -delete/-exec/-fprintf 等删除、执行或写文件动作。";
  }
  if (name === "sort" && args.some((t) => t === "-o" || t.startsWith("-o") || t === "--output" || t.startsWith("--output="))) {
    return "拒绝执行：sort 不允许 -o/--output 写文件，请直接读取标准输出。";
  }
  if (name === "journalctl" && args.some((t) => /^--(vacuum-|rotate$|flush$|sync$|setup-keys$|relinquish-var$)/.test(t))) {
    return "拒绝执行：journalctl 只允许查询日志，禁止清理、轮转或写入动作。";
  }
  if (name === "ss" && args.some((t) => t === "--kill" || /^-[A-Za-z]*K/.test(t))) {
    return "拒绝执行：ss 不允许 -K/--kill 关闭连接。";
  }
  return null;
}

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

const TEAM_HINT = "团队 id，可省略（系统自动绑定/新建）";

/**
 * 工单标题清洗（2026-11-11）：简报首行常常是「上一单失败：被当成项目的 C:\Users\Ad…」这种
 * 复盘+半截路径，直接 slice(40) 会变成主区大标题里的乱码。这里去掉段落标记/路径/URL，
 * 超长用省略号而不是硬砍，保留全文在 title 属性里回查。
 */
export function cleanTaskTitle(raw: string, fallback: string): string {
  const s = (raw ?? "")
    .replace(/^【[^】]*】\s*/, "")
    // 模型常把简报第一句连编号一起当标题（「1. 文档包含四个章节：…」），编号不是任务名
    .replace(/^\s*(?:\d+[.、)]|第[一二三四五六七八九十]+[、.)])\s*/, "")
    // 重派标题里的「（第2轮）」「（workspace模式重派）」是轮次噪声，不是任务名；
    // 留着会让台账出现两张看起来不同的单，其实是同一件事。
    .replace(/[（(]\s*(第\s*\d+\s*轮|workspace\s*模式重派|重派|重做|替补|承接|备份|最终版|第\s*\d+\s*版|并行备份)\s*[）)]/gi, "")
    .replace(/[A-Za-z]:[\\/][^\s，。；,，)）]*/g, "（路径）")
    .replace(/\\\\[^\s]+|https?:\/\/\S+/g, "（链接）")
    .replace(/\s+/g, " ")
    .trim();
  const base = s || fallback;
  return base.length > 36 ? `${base.slice(0, 36)}…` : base;
}

/** 流式 delta 的发送去抖：一帧一次。渲染层再按 rAF 合帧，两处都不许降到"肉眼看得出卡"的档位 */
const DELTA_FRAME_MS = 16;

/**
 * 默认同时最多几个成员在跑：三个任务并行是常态（ABC 各一个团队），
 * 2 会把第三张单直接拒掉。可用 settings.prefs.maxParallelMembers 覆盖（上限 8）。
 */
const DEFAULT_MAX_PARALLEL_MEMBERS = 4;
/** 成员多久没有任何动作就标"可能卡住"（蓝本 tether-ai 是 120s） */
const MEMBER_STALL_MS = 120_000;
/**
 * 单条工具最长免检时长：命令在跑时不算"没动作"（构建/大文件/浏览器会跑很久），
 * 但一条工具占着跑这么久就是真卡住了，照常报，不能永远豁免。
 */
const TOOL_BUSY_MAX_MS = 10 * 60_000;
/** 卡住超过这么久还没人处置 → 再交一次风铃，不让它安静地烂在台账里 */
const BLOCKED_AGE_MS = 30 * 60_000;
/** 堆积超限时一轮只交这么多张给她清（多了上下文会爆，少了清不动堆积） */
const BACKLOG_BATCH = 3;
/** 堆积态下的额外纪律：只清这一批就停，不许罗列全表、不许反问用户 */
const BACKLOG_ORDER =
  "\n\n【堆积态·只清一批】上面只列了其中一部分，先把这几张处理掉（验收 / 原单重做 / 关单都行），处理完就停，" +
  "不要一次性罗列其余单子，也不要问用户要不要取消——关不关由你定。下一轮会给你下一批。";
/** 这类卡片是"重复事件"（权限拦截 / 外呼审计）：同一张单反复出现就聚合计数，不逐条刷屏 */
const AGGREGATED_BADGES = new Set(["已拦截", "出站"]);

/**
 * 成员工具轮次下限。一轮一次模型调用，读材料 / 写产物 / 提交回报至少各占一轮；
 * 低于 8 轮时成员通常只能交出「章节目录式」骨架稿（2026-11-12 实机：给 3 轮 → 只有标题）。
 */
const MIN_TURNS = 8;

/**
 * 同一张单最多把风铃叫醒几次来回答成员提问（2026-11-16）。
 * 超过就只落群卡 + 进心跳事实，不再单独唤醒——问答不能变成新的无限循环
 * （AutoGen 的教训：群聊必须至少有两个独立终止条件，否则会一直说到预算烧完）。
 */
const MEMBER_QUESTION_WAKES = 3;

/** 成员中途发言的徽标（2026-11-16）：进展/结论只落群，疑问/风险才需要人接 */
const POST_BADGE: Record<string, NonNullable<FeedCard["badge"]>> = {
  update: "进展",
  finding: "结论",
  question: "疑问",
  risk: "风险",
};

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
        // 2026-11-17 精简（P2-1b）：工具描述每轮都要发送，三句重复的"别多招"合并成一句，约束一条不减。
        `招募团队成员（书面岗位）。${MEMBER_PROFILE_RULES}\n一个人做得完就只招 1 人（每人都在烧预算与时限）；一条任务线一支团队——不把人招进上一条任务的团队，沿用旧班底要显式传 teamId；超 6 人需 justification。团队不存在会自动新建。`,
      parameters: {
        type: "object",
        required: ["name", "role", "goal", "tools"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          teamName: { type: "string", description: "需要自动建队时用的团队名（可选）" },
          name: { type: "string", description: "通用岗位名（如「代码审查员」）；禁带任务对象、阶段、编号或 A/B/C 后缀——名字是战绩主键" },
          // 2026-11-17 P3-1：roleId 进枚举。role 仍是人类可读的岗位名，但**主角色由这里定**。
          roleId: {
            type: "string",
            enum: [...MEMBER_ROLE_IDS],
            description:
              "主角色（注册表 id）：implementer 开发 / reviewer-quality 质量评审 / reviewer-spec 规格评审 / " +
              "debugger 排查 / tester 测试 / researcher 调研 / writer 文档 / analyst 表格 / presenter 演示 / " +
              "visual-judge 视觉验收 / ops 运维。只选一个；不确定就 implementer 或 researcher。不要写「全栈兼文档」这类混合岗位",
          },
          role: { type: "string", description: "岗位名（人类可读，如「代码审查员」）；一个成员一个主角色，别写复合岗位" },
          goal: { type: "string", description: "这个岗位长期对哪类结果负责（不写本次要看哪个目录/文件、要算哪个数字）" },
          boundaries: { type: "array", items: { type: "string" }, description: "稳定边界：永远不做什么；本次任务的临时限制写进简报" },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              // 2026-11-16：这份清单以前是手写的，与 MEMBER_EXEC_TOOLS 漂移——glob/grep 实际可用却没写进来，
              // 她因此从不分配，成员只能扫盘。改成从同一处生成，名字不会再对不上。
              // 2026-11-17 P2-1b：前缀压到最短（名字一个不能少——写错名字成员就带着空工具集开工）。
              `只能填这些真实名字：${MEMBER_EXEC_TOOLS.join(" / ")}`,
          },
          deliverable: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          avatarId: { type: "string", description: "头像库 id（a01…a12，可省略：系统按名字自动挑一张本队没用过的）" },
          acceptor: {
            type: "boolean",
            description:
              "是否设为常驻验收员岗位（2026-11-15）：true = 只做验收、不参与执行。验收会下沉给这名成员，风铃据此不必逐一读所有执行成员的全文汇报，只等它那张紧凑的【验收结论】。验收员实际工具面会被收窄到 read_file / list_dir / submit_report，这里填的 tools 仅作档案记录。",
          },
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
        "向成员派单。成员只看到简报包、看不到对话，所以简报必须自足：四段【目标】【完成标准】【材料与位置】【限制】，缺了会被代码层退回。目标或材料位置不明确先用 ask_user，别猜着派。不传 teamId = 新建团队（不会塞进上一条任务的班底）；沿用旧班底要显式传 teamId 并说明理由。多单并行先告诉用户分工。用户 @某人 是对他的定向诉求，不是全队广播；派完在群里 @他 说清做什么。",
      parameters: {
        type: "object",
        required: ["member", "brief", "deadline"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          teamName: { type: "string", description: "需要自动建队时用的团队名（可选；以任务主题命名，不要花哨代号）" },
          taskId: { type: "string", description: "系统生成，模型不要填；旧调用可省略" },
          reworkTaskId: {
            type: "string",
            description: "重做/打回/卡住重来填**原工单 ID**（沿用状态与卷宗，不新建单）；新任务不填",
          },
          evidencePolicy: {
            type: "string",
            enum: ["required", "optional"],
            description: "required=关键任务（审计/对账/安全/可复跑）；其余省略，默认 optional",
          },
          title: { type: "string", description: "任务名（可选；不给则从简报首行取）" },
          taskTitle: { type: "string", description: "title 的旧别名（可选）" },
          member: { type: "string" },
          brief: {
            type: "string",
            description:
              "四段简报（缺会被退回）：【目标】产出什么；【完成标准】可验证的验收点；【材料与位置】完整路径，关键内容直接贴进来；【限制】不许做什么、范围与口径",
          },
          deadline: { type: "string", description: "具体时间（如「2026-11-10 18:00」「2小时后」），不写「尽快」" },
          tools: { type: "array", items: { type: "string" }, description: "本次工具集，必须 ⊆ 岗位白名单" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（可验证；写进契约，用户点开始后生效）" },
          forbidden: {
            type: "array",
            items: { type: "string" },
            description:
              "本次禁区（违反即不合格）：点名不许做的事与具体姿势，如「不许 skip 测试」「不许 mock 被测对象」「不许放宽阈值」；不写「认真一点」这类没法验的话",
          },
          priority: {
            type: "string",
            description: "取舍口径：冲突时保什么，如「算得对 > 做得全 > 做得快」；不给则成员自己猜",
          },
          mode: {
            type: "string",
            enum: ["execute", "explore"],
            description: "execute=要有产物（缺省）；explore=要结论+依据+不确定性，别硬凑产物",
          },
          workspace: {
            type: "string",
            description: "读写工作目录（须已存在）；缺省 = 会话项目目录。用户在契约卡上批准",
          },
          readRoots: {
            type: "array",
            items: { type: "string" },
            description: "需**只读**访问的目录（须已存在）：材料在工作区外时填，用户批准后生效，你不能自行扩权",
          },
          maxTurns: { type: "number", description: "轮次上限（1–40）；缺省用岗位档案上限。量大就给足" },
          template: {
            type: "string",
            description: "复用哪套编制模板（省略则按任务标题匹配；没有再新建空队，不会失败）",
          },
          network: {
            type: "boolean",
            description:
              "本单是否放行联网（缺省 false，不给网）。只在**确实要抓数据/装依赖/克隆仓库**时置 true；" +
              "**取网页数据优先用 browser_* 工具**，那不用开网。开了就要为这张单的出站负责",
          },
          networkReason: { type: "string", description: "为什么需要联网（进审计；一句话说清要访问什么）" },
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
        "给**正在跑**的成员补一句指示（下一轮生效，不用重派、不丢已写文件）。用于纠正方向、划清边界（例如「你只能访问任务工作区，别再去读 F:\\\\spiker」）、要求先交阶段性回报。用户 @某个成员 时，这是对他的定向要求——用这个转达，别新建工单。",
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
      name: "reply_member",
      description:
        "回答或纠正**正在跑**的成员（下一轮生效，不用重派、不丢已写文件）。成员用 post_message 提问/报风险时用它：能一句话答就答；他说错了就当场指明错在哪、该按什么做；他在为猜着做找借口就要求按简报执行。回答会落到群里并 @ 他。成员已经跑完就别用这个（改不动了）——要它继续就用 assign_task 带 reworkTaskId。",
      parameters: {
        type: "object",
        required: ["taskId", "text"],
        properties: {
          taskId: { type: "string" },
          text: { type: "string", description: "直接给结论/纠正/新做法，一句话说清；不要复述他的问题" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_task",
      description:
        "停掉一张在跑/卡住的单。成员收手后由**你**决定下一步：目标仍成立就在同一张单上重做（assign_task 带 reworkTaskId），方向已错或做不了就带 dismiss=true 关单并如实汇报。不要问用户要不要取消——这是你的活。",
      parameters: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" },
          reason: { type: "string", description: "为什么停（会记进卷宗与卡）" },
          dismiss: {
            type: "boolean",
            description: "判定这张单不再继续时置 true：直接取消归档（卷宗保留），不再把决定推给用户",
          },
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
      name: "read_artifact",
      description:
        "读任务产物的正文（docx / md / txt / csv…）。验收前必须看一眼内容：'文件存在 + 成员说结构齐全'不是验收，骨架稿、占位符（undefined）、空章节都只能靠读正文发现。缺省读最后一件交付物。",
      parameters: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "工单 ID" },
          ref: { type: "string", description: "产物在卷宗里的路径（如 artifacts/报告.docx）；省略=最后一件交付物" },
          maxChars: { type: "number", description: "最多读多少字（默认 8000，上限 20000）" },
          offset: { type: "number", description: "从第几个字开始读（被截断后要读后续就传上次的 offset+maxChars）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_result",
      description:
        "登记成员节点回报。证据可选：普通任务不强制登记；关键任务（审计/对账/安全/可复跑）会在进审查时要求证据。",
      parameters: {
        type: "object",
        required: ["taskId", "member", "text"],
        properties: {
          teamId: { type: "string", description: TEAM_HINT },
          taskId: { type: "string" },
          member: { type: "string" },
          text: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, description: "可选：真实文件/命令输出；关键任务要求" },
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
          failedChecks: {
            type: "array",
            items: { type: "string" },
            description:
              "打回时填：具体哪几条判据没过（照抄完成标准原文）。重派时只重做这几条，已通过的不用重来；不填就只能整段重做。",
          },
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
      name: "set_group_notice",
      description:
        "写本群公告（全局段）：整体干什么、谁管哪段、接缝在哪、共享写入点归谁。公告是你自己的活，不用等用户让你写——第一次派活前先写一版；分工或接缝变了也用它更新。写完群里每个人看得见，你每轮也看得见（接缝没人接是并行协作的头号事故，所以它得是群级事实）。",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "群公告正文，几行就够：整体目标 / 谁管哪段 / 接缝（谁的产出交给谁）/ 共享写入点归谁",
          },
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
        "记一件事（M2-05）：把一条事实/决定/坑/做法写进长期记忆（跨会话都在你的系统提示词里）。做完任务的经验教训、用户偏好、项目的关键路径都值得记。scope=user 写「用户记忆」（偏好/背景，永远保留）；scope=project 写「这个项目的记忆」（换个项目看不到，适合仓库怎么跑、谁负责哪块这类事实）。",
      parameters: {
        type: "object",
        required: ["entry"],
        properties: {
          entry: { type: "string", description: "一条具体的事实（一句话，含上下文；不要写流水账）" },
          scope: {
            type: "string",
            enum: ["memory", "user", "project"],
            description: "缺省=助理记忆；user=用户记忆（偏好/背景）；project=当前项目的记忆",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description:
        "列出你的记忆条目（助理记忆/用户记忆/当前项目记忆）：序号 + 时间 + 摘要。删除前先读一遍，确认要删哪条——你要删的是某条**已作废**的事实（任务取消了、结论改了），不是加一条『已作废』糊过去。",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["memory", "user", "project"],
            description: "缺省=助理记忆；user=用户记忆；project=当前项目的记忆",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description:
        "删掉一条记忆（2026-11-13）：按关键词唯一定位一条，删掉并留一版可回滚。**记忆归你管，不要派成员去删文件**——他们在项目工作区里，够不着 ~/.lynn 下的记忆文件。匹配到多条时会拒绝并列出候选，让你换更具体的关键词。",
      parameters: {
        type: "object",
        required: ["keyword"],
        properties: {
          keyword: { type: "string", description: "记忆里能唯一定位那条的原文片段（如 HERMIX-4471）" },
          scope: { type: "string", enum: ["memory", "user"], description: "缺省=助理记忆；user=用户记忆" },
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
  /**
   * 插件自举三件套（2026-11-17 P8-2 / 24 章第 6 节）。
   * 只做"用户也能做"的事：看清单、开关已装的、删掉装错的。
   * **不提供改已装插件代码的能力**——那条走草稿 + 新 id，见 24 章第 6 节的缺口说明。
   */
  {
    type: "function",
    function: {
      name: "list_plugins",
      description: "列出已安装的插件（id / 档位 / 是否启用 / 提供了哪些工具）。装了什么、哪些没开、有没有加载错误，一次看全。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_plugin_enabled",
      description:
        "启用或停用**已安装**的插件。停用永远允许（只会减少能力）；启用 L1 会让它的代码重新加载，要确认这个插件是可信的。",
      parameters: {
        type: "object",
        required: ["id", "enabled"],
        properties: {
          id: { type: "string", description: "插件 id（list_plugins 可查）" },
          enabled: { type: "boolean", description: "true=启用，false=停用" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "uninstall_plugin",
      description:
        "卸载已安装的插件。文件会被移到 plugins-trash/（不是永久删除），需要时可以手工恢复。装错了就用这个收拾，别留在那里。",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "插件 id（list_plugins 可查）" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_plugin_versions",
      description: "列出某个插件的历史版本（新的在前）。改插件前先看这个：可能已经有旧版可以直接回滚，不用重写。",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "插件 id（list_plugins 可查）" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rollback_plugin",
      description:
        "把插件回滚到某个历史版本。当前版本会先归档，所以回滚本身也能再回滚——点错了不会变成单行道。",
      parameters: {
        type: "object",
        required: ["id", "versionDir"],
        properties: {
          id: { type: "string", description: "插件 id" },
          versionDir: { type: "string", description: "历史版本目录名（list_plugin_versions 可查）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_plugin",
      description:
        "从插件包安装插件（.zip 文件或插件目录）。校验失败会返回**具体到字段**的原因，照它改就行。" +
        "你自己开发完插件（工坊草稿产物就是标准包结构）也走这个装。装不上时先看 issues，别反复试同一个包。",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "插件包路径：.zip 文件，或含 plugin.json 的目录（绝对路径）" },
          override: { type: "boolean", description: "覆盖同名插件（默认 false；覆盖会丢掉回滚能力，谨慎）" },
        },
      },
    },
  },
];

/**
 * 风铃实际挂给模型的工具名（§3.1 硬约束）。
 * 测试据此断言：她只有管理型工具，没有任何执行类工具。
 */
export const AGENT_TOOL_NAMES: readonly string[] = TOOL_JSON.map((t) => t.function.name);

/**
 * 发给模型的紧凑工具面（2026-11-11）。
 * 完整定义仍保留在 TOOL_JSON 里供文档/测试/执行使用；这里只把「重复的规则说明、冗长的参数描述」
 * 去掉——规则已在 system prompt 里，模型不需要在 15 个工具里各读一遍。
 * 关键参数（brief/tools/readRoots/workspace/deadline/evidence/acceptance/spec/entry）保留说明，
 * 避免压过头让模型不会派单。
 */
const COMPACT_TOOL_DESC: Record<string, string> = {
  create_team: "建团队，只需给任务主题名；ID 系统生成。",
  create_member: "招募 1 名成员（岗位档案）：只写能力域/做事风格/稳定边界/通用产出，禁写本次路径、文件名、阶段、数字、截止与验收；具体任务进简报。名字用通用岗位名，不带任务词或编号。",
  assign_task: "派单。简报四段自足；按规模自动配轮次/预算；证据默认可选，关键任务才强制。",
  check_progress: "查工单/团队进度与状态。",
  nudge_member: "给在跑的成员补一句指示。",
  reply_member: "回答/纠正成员在群里的提问或错误（下一轮生效）。",
  stop_task: "停单后由你决定：同单重做（dismiss=false）或自行关单（dismiss=true），别问用户。",
  check_roster: "查编制与成员状态。",
  read_artifact: "读产物正文（docx/md/txt）：验收前看内容，别只看文件在不在。",
  review_result: "登记成员回报（证据可空；关键任务缺证据会被拦在审查外）。",
  // 2026-11-17 P2-1b：这条原先写成「处理待审契约（approve 开工 / reject 取消）」——
  // 把契约审批和验收打回混成了两个动作，模型会拿它去处理"待拍板契约"。事实是：
  // 验收/打回走这里，契约审批走 accept_or_reject 之外的表单卡（用户点，模型不调）。
  accept_or_reject: "验收/打回成员交付；打回必须写 what/expect/deadline，连续 3 次打回强制升级问用户。",
  report_to_user: "向用户汇报结论、证据、未完成项与待拍板项。",
  ask_user: "目标/标准/材料/工作区有缺口时问用户；不猜。",
  dissolve_team: "解散团队（编制与历史仍在，成员不再可用）。",
  save_memory: "把长期事实写进记忆。",
  // 下面三条 2026-11-17 补齐（P2-1b）：此前这三个工具没有紧凑描述，原版长文案
  // 每轮都要发（set_group_notice 153 / forget_memory 145 / read_memory 125 tokens），
  // 加起来比 assign_task 还贵。规则一条没删，只把"为什么"挪回 system prompt。
  set_group_notice: "写本群公告：整体目标 / 谁管哪段 / 接缝 / 共享写入点归谁。派活前先写一版。",
  read_memory: "列出记忆条目（序号+时间+摘要）：删之前先读，确认要删哪一条。",
  forget_memory: "按关键词删一条记忆（多条会拒绝并给候选）。记忆归你管，别派成员去删文件。",
  create_plugin_draft: "把稳定流程写成插件草稿（不会自动启用）。",
  ship_plugin: "仅启用通过准入的 L0 技能草稿；L1/L2 必须由用户启用。",
};

const KEEP_PARAM_DESC = new Set(["brief", "tools", "network", "networkReason"]);

/**
 * 紧凑工具面里显式剔除的参数（2026-11-17 P2-1b 收尾）。
 *
 * 判据只有一条：**模型不该填、或填了也没用**。这类参数留在 schema 里，
 * 每轮调用都要付一次 JSON 结构费，还会增加模型填错的概率。
 * 完整定义仍保留在 TOOL_JSON（文档/测试/兼容旧调用），这里只是不发出去。
 *
 *  - assign_task.taskId：系统生成，描述原文就写着"模型不要填"
 *  - assign_task.taskTitle：`title` 的旧别名，保留 title 即可
 */
const COMPACT_TOOL_DROP: Record<string, string[]> = {
  assign_task: ["taskId", "taskTitle"],
};

function compactParam(value: unknown, propName?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => compactParam(v, propName));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "description" && !(propName && KEEP_PARAM_DESC.has(propName))) continue;
    if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = compactParam(pv, pk);
      out[k] = props;
    } else {
      out[k] = compactParam(v, k === "items" ? propName : k);
    }
  }
  return out;
}

const COMPACT_TOOL_JSON: ToolSchema[] = TOOL_JSON.map((t) => {
  const dropped = COMPACT_TOOL_DROP[t.function.name];
  const params = compactParam(t.function.parameters) as Record<string, unknown>;
  if (dropped?.length && params && typeof params === "object") {
    const props = params.properties;
    const required = params.required;
    if (props && typeof props === "object") {
      const keptProps: Record<string, unknown> = { ...(props as Record<string, unknown>) };
      for (const name of dropped) delete keptProps[name];
      params.properties = keptProps;
    }
    if (Array.isArray(required)) {
      params.required = required.filter((r) => !dropped.includes(String(r)));
    }
  }
  return {
    type: "function",
    function: {
      name: t.function.name,
      description: COMPACT_TOOL_DESC[t.function.name] ?? t.function.description,
      parameters: params,
    },
  };
});

type DecisionEntry = Decision;

/** 待确认的任务契约（只存一次派单所需的最小上下文） */
interface PendingPlan {
  decisionId?: string;
  /** 契约是哪个群在等你拍板（2026-11-15）：切到别的群不该再看见它 */
  threadId?: string;
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
  /** 证据策略：required 才强制；缺省按简报自动判定（2026-11-11 放宽） */
  evidencePolicy?: EvidencePolicy;
  /** 派单时的完成标准（冻结版；落单时写进 TaskRecord） */
  acceptance?: string[];
  /** 本次禁区（法）：点名不许做的事，违反即不合格 */
  forbidden?: string[];
  /** 取舍口径：冲突时保什么 */
  priority?: string;
  /** 任务型态：execute 要产物 / explore 要结论与依据 */
  mode?: "execute" | "explore";
  /** M3-07：插件工坊草稿 id——成员工作区即草稿区（产物只能写进草稿） */
  draftId?: string;
  /** 本单的联网授权（P5-1）：批准后建单时原样写进 TaskRecord */
  network?: TaskRecord["network"];
}

/** 排队中的输入 */
interface QueuedInput extends QueueItem {
  mode: "queue" | "steer";
  attachments?: TurnAttachments;
  /** 群内 @（排队的这条消息点了谁） */
  mentions?: FeedMention[];
}

/**
 * 成员在群里抛出的疑问 / 风险（2026-11-16）：按任务合并，等风铃答复。
 * 合并是有意的——同一张单连发三条疑问只该叫醒她一次，否则就是新的刷屏源。
 */
interface PendingMemberQuestion {
  taskId: string;
  teamId: string;
  member: string;
  threadId: string;
  items: { id: string; kind: string; text: string; needAnswer?: boolean }[];
}

/** 计划档位下也允许的只读工具 */
const READ_ONLY_TOOLS = new Set(["check_progress", "check_roster", "read_artifact"]);

/**
 * C4：新会话提示（纯函数，便于单测）。
 * 没有在跑的单就只说"留在会话列表里"；有就必须点名 + 给"全部停掉"的动作，
 * 否则用户以为"从头开始"，后台还在烧预算、还会弹审批。
 */
export function newSessionNotice(running: string[]): { text: string; action?: "stopRunning" } {
  if (running.length === 0) {
    return { text: "新群已开始。上一段的往来留在「群」列表里，随时能切回。" };
  }
  return {
    text: `新群已开始。上一段的往来留在「群」列表里，随时能切回。注意：还有 ${running.length} 张单在后台跑（${running.join("、")}），不停会继续消耗预算并可能弹审批。`,
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
  /** 成员池（P3-2）：跨团队的那个人，L1 岗位说明 + L2 经验 + 战绩。懒建，用到才建目录。 */
  private memberPoolInstance: MemberPool | null = null;
  private get memberPool(): MemberPool {
    return (this.memberPoolInstance ??= new MemberPool(this.dataRoot));
  }
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
  /** 正在执行中的工具起始时间（taskId → ms）：命令在跑就不算"没动作"，避免长构建被误判卡住 */
  private memberToolSince = new Map<string, number>();
  /** 被边界拦下的具体命令（taskId → 命令集合）：按命令去重，同一句反复撞墙才算"做的是做不到的事" */
  private memberBlockedCmds = new Map<string, Set<string>>();
  /** 卡住老化：每张单上次被"催一次风铃"的时间，避免同一张单反复注入 */
  private blockedAgedNoted = new Map<string, number>();

  /** 指挥者巡检：定时器与节流（不催也管） */
  private supervisorTimer: NodeJS.Timeout | null = null;
  private lastSupervisorAt = 0;
  private supervisorNoted = new Map<string, number>();
  /** 本轮技能注入文本（当轮消息尾部拼接；不进 system prompt —— 保前缀缓存稳定） */
  private pendingSkillText = "";
  /**
   * 本轮记忆变更提示（2026-11-17 缓存修复 B3）：与技能同通道拼进当轮 finalText，
   * 保证「刚记的事实当轮就知道」，同时不动 system 前缀。
   */
  private pendingMemoryNote = "";
  /** 会话级记忆快照（见 memorySectionCached）：null = 需要重建 */
  private memorySnapshot: string | null = null;
  private memorySnapshotKey = "";
  /** 上一次请求的前缀指纹（见 prefix-hash.ts）：变了就记一条原因，便于归因命中率 */
  private lastPrefixFp = "";
  /** 最近一次 system prompt 的分段长度（见 prompt-compiler.ts）：诊断/日志用，不参与业务判断 */
  private lastPromptSegments: { name: string; chars: number }[] = [];
  /** 顾问（2026-11-14）：可注入的假模型（测试用）；null = 直接用 streamChat */
  advisorChatFn: AdvisorChatFn | null = null;
  /** 每单只审一次：重派之后再审同一份交付没有新信息，只会多烧一次 token */
  private advisorReviewed = new Set<string>();
  /** 句子级去重（跨任务）：同一句"数字对不上"不在每张单里重复刷；存 severity 以便允许升级重提 */
  private advisorSeen = new Map<string, AdvisorSeverity>();
  /**
   * 额度熔断（2026-11-16 日志复盘）。
   *
   * 实机：09:54 起端点回 "Token Plan 用量上限"（429），此后心跳仍每 5 分钟叫醒一次、
   * 每次 2 连重试，一路空转到 11:35；同一秒内还有 4 个排队回合各自撞 429。
   * 额度用尽是**终态**，不是"再试一次就过"：必须整体停手一段，等额度恢复。
   * 熔断期：心跳/巡检/叫醒/派单/顾问一律不发请求；用户主动说话仍然放行（他可能在充值后重试）。
   */
  private quotaBlockedUntil = 0;
  private quotaStrikes = 0;
  private quotaCardAt = 0;
  /** 最近一张错误卡（F7 合并用）：同 code+action 在窗口内只留一张，计数 */
  private lastErrorCard: { code: string; action: ErrorAction; at: number; cardId: string; count: number } | null = null;
  /**
   * 巡检轮（心跳/验收叫醒）走直连路径的累计用量（2026-11-13 P1）。
   * Pi 的 session stats 只包含主会话，巡检轮的消耗单独累计，展示时合并进 usage——
   * 既不污染 Pi 的单轮增量计算，也不在看板里漏掉这部分真实开销。
   */
  private patrolUsage = { in: 0, out: 0, read: 0, write: 0 };
  /** 心跳巡检（M3-01）：定时器、节流与同批事实去重 */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** 秒级探针（2026-11-11）：有成员在跑 1s 一次，只读内存态，零 token / 零 I/O */
  private probeTimer: NodeJS.Timeout | null = null;
  /** 事件驱动唤醒闸：合并窗口 / 同批冷却 / 每小时配额 */
  private wakeGate: WakeGateState = { lastWakeAt: 0, windowStart: 0, windowCount: 0, lastSig: "", lastSigAt: 0 };
  /** busy 时被挡下的心跳事件：收尾后补评估一次，别让「成员退出」白白蒸发 */
  private heartbeatPending: string | null = null;
  /** 成员交回报后待风铃验收的队列（2026-11-12）：忙时先挂着，收尾再叫 */
  private reviewPending: { taskId: string; member: string; text: string }[] = [];
  /**
   * 成员在群里问的话（2026-11-16）：只有 question / risk 会进这里。
   * 按 taskId 合并，同一单在一轮里说三件事只叫醒她一次。
   */
  private questionPending = new Map<string, PendingMemberQuestion>();
  /** 每单已经为"回答提问"唤醒过几次（上限 MEMBER_QUESTION_WAKES） */
  private questionWakes = new Map<string, number>();
  /**
   * 超过唤醒上限的单：问题仍留在队列里（每轮事实段会继续提醒她），但不再单独打断。
   * 这个标记只是"别再叫醒"，不是"把问题丢掉"——成员的问题不能静默消失。
   */
  private questionMuted = new Set<string>();
  private questionSeq = 0;
  /**
   * 被用户「终止任务」的群（2026-11-15）：这些群里的一切后台动作停手——
   * 成员执行、心跳/巡检、验收叫醒、定时任务注入、排队输入，直到用户在这个群发出新消息。
   * 内存副本由 init 从 threads/index.json 的 haltedAt 恢复（重启也不该偷偷复活）。
   */
  private haltedThreads = new Set<string>();
  /** 探针已报过的「沉默成员」，避免每秒重复触发 */
  private silentNoted = new Map<string, number>();
  private lastHeartbeatAt = Date.now(); // init 后先静默一个间隔，不抢启动窗口
  private heartbeatNoted = new Map<string, number>();
  /**
   * 堆积态节流：上一批没清掉就把注入间隔逐级拉长（上限 60 分钟），清动了立刻恢复常速。
   * 否则她清不动时会每 5 分钟空烧一轮 token，用户那边还看不到任何变化。
   */
  private backlogGate = { at: 0, count: 0, waitMin: 0 };
  /** 本轮前缀可能被打断的原因（2026-11-14）：切群 / 运行时重建 / 冷启动；用完即清 */
  private cacheBreakReason: string | null = null;
  /** 成员本轮累计 token（`teamId::成员` → tokens）：编制表的预算读数不再是硬编码 0 */
  private memberUsage = new Map<string, number>();
  /** 成员累计命中缓存的输入 token（2026-11-13 看板）：与 memberUsage 同口径累计 */
  private memberCacheRead = new Map<string, number>();
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
  /**
   * 成员自己交过回报的单（2026-11-13）：用来挡住风铃的 review_result 重复登记——
   * 重复登记会在群里再落一张一样的「回报」卡。
   * 重派（assign_task 带 reworkTaskId）时清掉，新一轮可以重新登记。
   */
  private selfReported = new Set<string>();
  /** 本轮是否已经给用户落过「汇报」卡（2026-11-13：没收尾汇报就在收轮时按卷宗补一张） */
  private reportedThisTurn = false;
  /** 本轮验收归档了、但还没有汇报的那张单（收轮时兜底汇总） */
  private pendingFinalReport: { taskId: string; member: string } | null = null;
  /** 本轮是否已就模型错误落过卡（Pi 重试时可能连发多条 message_end，别刷屏） */
  private turnErrorReported = false;
  /** 日志闸：分类开关 + 每分钟限流 + 字段截断（设置里可整体关掉） */
  private logGate = new LogGate(() => this.settings.getPrefs().log);
  /** 连续删除合并窗口：批量删 5 张只落一条汇总卡，不再刷 5 条「已删除」 */
  private pendingRemovals: { taskId: string; kept: string[]; shared: boolean; threadId?: string }[] = [];
  private removalTimer: NodeJS.Timeout | null = null;
  /** 本轮是否因流式复读熔断自动停止（别把这次 abort 误报成端点错误） */
  private repetitionAborted = false;
  /** 上次复读扫描的累计长度：每 ~400 字符扫一次，不逐 token 做周期检测 */
  private lastRepetitionScan = 0;
  /** check_progress 空转计数（taskId → 上次结果签名 + 连续相同次数） */
  private progressPolls = new Map<string, { sig: string; count: number }>();
  /** 已把「卡住」交回风铃处置过的单（每单一次，重做时清除） */
  private blockedHandled = new Set<string>();
  /**
   * 已经用 read_artifact 看过产物的单。验收前必须看过正文——
   * 实机她只看"文件存在 + 成员说结构齐全"就把四行标题的骨架稿验收通过了。
   */
  private artifactsInspected = new Set<string>();

  /** 这张单的产物正文有没有在验收前被读过（验收闸查询；只读） */
  hasInspectedArtifact(taskId: string): boolean {
    return this.artifactsInspected.has(taskId);
  }

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
  /** 工单主键序号：生产环境由系统生成，模型不能自己编（2026-11-11） */
  private taskSeq = 0;
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
  /** 项目身份（2026-11-12）：同一目录 = 同一项目，改名跟着项目走 */
  private projects!: ProjectStore;
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
  /** 直连路径当前回合的取消器：session.abort 立即 abort()，不再等整段 SSE 跑完 */
  private chatAbort: AbortController | null = null;
  /** 本轮是「看一眼就走」的巡检轮（心跳/卡住处置）：结束后从 history 摘掉、不写时间线 */
  private ephemeralFrom = -1;
  /** 语音播报端口（壳层注入）：不注入就完全不发声，内核只管决定该说什么 */
  private voice: VoicePort | null = null;
  /** 工单落盘后的合并窗口定时器（秒级事件心跳用） */
  private taskChangeTimer: NodeJS.Timeout | null = null;

  private decryptor: ((blob: Buffer) => string) | null = null;

  /** 外部应用连接（能力中心）：凭据仓库 + 加解密函数（main.ts 注入 safeStorage） */
  private connectorStore: ConnectorStore;
  private connectorEnc: ((plain: string) => Buffer) | null = null;
  private connectorCanEncrypt: () => boolean = () => false;

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = dataRoot;
    // 测试环境（LYNN_HOME 隔离）无 safeStorage；main.ts 会用真实现覆盖
    this.settings = new SettingsStore(dataRoot, (plain) => Buffer.from(plain, "utf-8"), () => false);
    // 外部应用连接的凭据仓库（2026-11-15）：与 API Key 同一道加密闸；main.ts 注入真实现
    this.connectorEnc = (plain) => Buffer.from(plain, "utf-8");
    this.connectorCanEncrypt = () => false;
    this.connectorStore = new ConnectorStore(dataRoot, this.connectorEnc, this.connectorCanEncrypt);
    this.teamStore = new TeamStore(dataRoot);
    // 工单落盘回调：有成员在跑时，状态一变就评估一次心跳（500ms 合并窗口）
    this.taskStore = new TaskStore(dataRoot, { onChange: () => this.onTaskStoreChanged() });
    this.taskCase = new TaskCase(dataRoot);
    this.contextStore = new ContextStore(dataRoot);
    this.checkpoints = new CheckpointStore(path.join(dataRoot, "checkpoints"));
    this.trust = new TrustStore(dataRoot);
    this.defaultWorkspace = this.resolveDefaultWorkspace();
    this.projects = new ProjectStore(dataRoot);
    // MCP 子进程 cwd 钉到数据根（审计 #7）：GUI 下 process.cwd() 是安装目录
    this.mcp = new McpRegistry({ cwd: dataRoot });
    this.pluginHost = new PluginHost(dataRoot);
    this.pluginSet = new PluginSetStore(dataRoot);
    this.l1 = new L1Host({
      listEntries: () => this.pluginHost.listL1Entries(),
      manifestOf: (id) => this.pluginHost.manifestOf(id),
      kernelVersion: "0.0.1",
      // 审计 #3：L1 插件一律隔离进程加载（agent/l1-worker.mjs）——崩溃不带内核、超时强杀。
      // LYNN_L1_INPROC=1 退回进程内直跑（排障逃生口；测试环境也用它保持旧行为）。
      workerEntry:
        process.env.LYNN_L1_INPROC === "1"
          ? undefined
          : unpackedPath(path.resolve(__dirname, "..", "..", "agent", "l1-worker.mjs")),
      /**
       * 内核依赖目录（P10-1）：worker 要在里面找 jiti 转译器。
       * 生产环境 `__dirname` 是 `dist/main`，`node_modules` 在项目根。
       * 打包后（asar）依赖在 unpacked 里，所以走 unpackedPath。
       */
      kernelModules: unpackedPath(path.resolve(__dirname, "..", "..", "node_modules")),
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
    this.migrateThreadProjects();
    const list = this.threads.list();
    // 全新安装（还没有会话索引）给一条默认会话；索引存在但为空 = 用户把会话删光了，
    // 必须保持空场，不能重启一次就偷偷补回一条同名的「新会话」。
    const indexFile = path.join(dataRoot, "threads", "index.json");
    const defaultRoots: RootSet = { primary: this.defaultWorkspace, extras: [] };
    const current = list[0] ?? (fs.existsSync(indexFile) ? null : this.threads.create("新群", defaultRoots));
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
    // 外部应用凭据同一条纪律：换真实加密实现时把连接仓库一起换掉（旧实例缓存的是假加密）
    this.connectorEnc = encrypt;
    this.connectorCanEncrypt = isAvailable;
    this.connectorStore = new ConnectorStore(this.dataRoot, encrypt, isAvailable);
  }

  onEvent(cb: (ev: KernelEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * 结构化日志：~/.lynn/logs/agent.log（JSONL，5MB 轮转，保留 2 份）。
   * 分类与限流见 log-policy.ts：默认只开 member/tool/task/system，heartbeat 关；
   * 每类有每分钟上限，超了丢弃并合并成一条 log_throttled，最坏总量约 15MB。
   */
  private log(kind: string, data: Record<string, unknown> = {}): void {
    try {
      const cat = this.logGate.allow(kind);
      if (!cat) return;
      const dir = path.join(this.dataRoot, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "agent.log");
      const cap = 5 * 1024 * 1024;
      if (fs.existsSync(file) && fs.statSync(file).size > cap) {
        const one = path.join(dir, "agent.1.log");
        const two = path.join(dir, "agent.2.log");
        if (fs.existsSync(one)) fs.renameSync(one, two);
        fs.renameSync(file, one);
      }
      const dropped = this.logGate.takeDropped(cat);
      // kind 必须放在 data 之后：data 里也常有 kind 字段（工具审计的 cmd_run），
      // 之前被它覆盖，agent.log 里只有 cmd_run、看不出这些是 tool_audit 写的。
      let text = JSON.stringify({ at: new Date().toISOString(), ...this.logGate.trim(data), kind }) + "\n";
      if (dropped > 0) {
        text += JSON.stringify({ at: new Date().toISOString(), kind: "log_throttled", category: cat, dropped }) + "\n";
      }
      fs.appendFileSync(file, text, "utf-8");
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
    ev: { kind: "cmd_blocked" | "cmd_net" | "cmd_run" | "cmd_auto"; command: string; why?: string; cwd: string },
    /** 出发会话：后台成员的审计卡要写回它，否则别的会话会被拦截记录刷屏（C2） */
    threadId: string = this.currentThreadId,
  ): void {
    const rec = { at: new Date().toISOString(), kind: ev.kind, teamId, taskId, member, command: ev.command.slice(0, 500), why: ev.why, cwd: ev.cwd };
    try {
      fs.appendFileSync(path.join(this.dataRoot, "audit.jsonl"), JSON.stringify(rec) + "\n", "utf-8");
    } catch {
      /* 审计写不进去也不能影响执行，但会缺一条记录 */
    }
    this.log("tool_audit", { audit: ev.kind, taskId, member, why: ev.why });
    if (ev.kind === "cmd_blocked") {
      // 撞墙计数：巡检据此判断"它在做做不到的事"（而不是单纯慢）。
      // 按命令去重——同一条命令重试 3 次说明真在硬撞；不同命令各撞一次只是正常探索，
      // 累计原始次数会把"换着法子找路"误判成"明知做不到还硬来"。
      const sig = ev.command.trim().replace(/\s+/g, " ").slice(0, 200);
      const seen = this.memberBlockedCmds.get(taskId) ?? new Set<string>();
      seen.add(sig);
      this.memberBlockedCmds.set(taskId, seen);
      this.memberBlocked.set(taskId, seen.size);
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
    } else if (ev.kind === "cmd_auto") {
      // 低风险自清理（本单自己造的文件 / 全权档工作区内删除）：不打扰用户，但必须留痕——
      // "系统替我批了"这件事本身要能回查，否则等于悄悄删。
      this.cardTo(threadId, {
        kind: "tool",
        badge: "放行",
        jobId: taskId,
        title: `${member} · ${taskId}`,
        body: `删除类命令自动放行（不需要你点头）：${ev.why ?? "低风险"}\n${ev.command}`,
      });
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
        artifacts: ev.artifacts,
        author: ev.author,
        mentions: ev.mentions,
        speak: ev.speak,
      });
    }
    this.notify(ev);
  }

  private card(c: Omit<FeedCard, "id" | "createdAt">): FeedCard {
    /**
     * 写作规则（2026-11-15 重做）：**这里一个字都不改**。
     * 0.1 曾在展示层改写模型文本，结果是「界面看到 A、落盘与上下文是 B」，
     * 排查时对不上；而且改写需要语义判断，规则只能猜。现在约束放在生成侧
     * （写作规则进系统提示词），展示层保持与模型输出逐字一致。
     */
    // 同一张单反复出同一种事件（权限拦截 / 外呼审计）：聚合成一张卡计数，不再一屏刷 N 条
    if (AGGREGATED_BADGES.has(c.badge ?? "") && this.feed.length > 0) {
      // 聚合看的是"她那张 live 卡之前"的最后一条：live 卡永远在末尾（见下），
      // 直接取 feed 尾部会把聚合判给她的话，同一张单的拦截记录就重新一张张刷屏。
      const tailIdx = this.feed.length - 1;
      const last = this.liveCard && this.feed[tailIdx] === this.liveCard ? this.feed[tailIdx - 1] : this.feed[tailIdx];
      if (last && last.badge === c.badge && last.jobId === c.jobId) {
        return this.bumpBlocked(last, c);
      }
    }
    const full: FeedCard = {
      ...c,
      id: `c-${++this.cardSeq}`,
      createdAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    /**
     * 顺序纪律（2026-11-16 实机「长任务里仍穿插早期消息」）：
     * 她的实时输出卡（liveCard）一旦建在回合开头，之后所有动作卡与成员回报都排在它后面，
     * 十几分钟后她的话就被埋在中间。这里让 live 卡**永远保持在末尾**：
     * 新卡插到它前面，而不是 push 到它后面。收轮时 live 卡已在末尾，moveCardToEnd 自然幂等。
     */
    const live = this.liveCard;
    const at = live && live !== full && live.streaming ? this.feed.lastIndexOf(live) : -1;
    if (at >= 0) this.feed.splice(at, 0, full);
    else this.feed.push(full);
    this.notify({ type: "card", card: full });
    // 单点播报判定：所有卡片（含 emit 转出来的 tool 卡）都从这里过白名单
    this.voice?.sayCard(full);
    this.persistThreadSoon();
    return full;
  }

  // ---------- 群聊：作者、@ 与本群成员（2026-11-12 群聊模式） ----------

  /**
   * 成员作者身份：档案能读就带上岗位与头像，读不到也不编。
   * 群里"谁在说话"要有名字和脸——这是成员第一次在对话流里有发言位置。
   */
  private memberAuthor(teamId: string, member: string): FeedAuthor | undefined {
    const name = String(member ?? "").trim();
    if (!name) return undefined;
    let role: string | undefined;
    let avatarId: string | undefined;
    try {
      const p = this.teamStore.readMember(teamId, name);
      role = p?.role;
      avatarId = p?.avatarId;
    } catch {
      /* 档案读不到：只留名字，不编岗位 */
    }
    const face = avatarById(avatarId) ?? avatarFor(name);
    return {
      kind: "member",
      name,
      memberId: name,
      teamId: teamId || undefined,
      role,
      avatarId: avatarId ?? face.id,
    };
  }

  /**
   * 本群成员名单（派生，不落盘）：本会话所有工单的承办人 + 这些工单所属团队的成员。
   * 群里 @ 只能 @ 本群的人——@ 别群的人没有意义（他不在这个群里，听不见）。
   */
  private groupMembers(): FeedAuthor[] {
    const out = new Map<string, FeedAuthor>();
    // 本群的队（显式绑定 + 本群工单所属）的全部成员——包括还没派单的
    for (const teamId of this.groupTeamIds()) {
      let list: MemberProfile[] = [];
      try {
        list = this.teamStore.listMembers(teamId);
      } catch {
        list = [];
      }
      for (const p of list) {
        if (out.has(p.name)) continue;
        const face = avatarById(p.avatarId) ?? avatarFor(p.name);
        out.set(p.name, {
          kind: "member",
          name: p.name,
          memberId: p.name,
          teamId,
          role: p.role,
          avatarId: p.avatarId ?? face.id,
        });
      }
    }
    // 工单承办人（队伍已解散、档案读不到的那几个）也算本群成员
    for (const t of this.taskStore.list()) {
      if (t.threadId !== this.currentThreadId || !t.member || out.has(t.member)) continue;
      const a = this.memberAuthor(t.teamId, t.member);
      if (a) out.set(t.member, a);
    }
    return [...out.values()];
  }

  /**
   * 解析消息里的 @：只认本群成员（+ 风铃），陌生名字丢弃并如实回报。
   * "不 @" = 只有风铃看见；"@某人" = 对这个人的定向诉求。
   */
  private resolveMentions(
    text: string,
    hint?: { name: string }[],
  ): { mentions: FeedMention[]; unknown: string[] } {
    const byName = new Map(this.groupMembers().map((m) => [m.name ?? "", m]));
    const found = new Map<string, FeedMention>();
    const unknown: string[] = [];
    const scan = `${text}\n${(hint ?? []).map((h) => `@${h.name}`).join("\n")}`;
    const re = /(^|[^\w@])@([^\s@，。！？、；：,.;:!?"'""''()（）[\]【】<>]{1,20})/g;
    for (const m of scan.matchAll(re)) {
      const name = m[2];
      // 像路径/文件名的（@note.md、@src/x.ts）不是人名：不当 mention，也不报"群里没有这个人"
      if (name.includes(".") || name.includes("/") || name.includes("\\")) continue;
      if (name === "风铃") {
        found.set(name, { kind: "lynn", name });
        continue;
      }
      const hit = byName.get(name);
      if (hit?.memberId) found.set(name, { kind: "member", name, memberId: hit.memberId });
      else if (!unknown.includes(name)) unknown.push(name);
    }
    return { mentions: [...found.values()], unknown };
  }

  /**
   * 工具层强制点名：动作卡正文前缀 @某人 + mentions 标记。
   * 模型忘了写 @ 也要补上——群里"谁对谁做了什么"必须看得见，不能只看标题猜。
   */
  private atMember(member: string, body?: string): { body?: string; mentions?: FeedMention[] } {
    const name = String(member ?? "").trim();
    if (!name) return { body };
    const mentions: FeedMention[] = [{ kind: "member", name, memberId: name }];
    if (!body) return { body: `@${name}`, mentions };
    const already = body.includes(`@${name}`);
    return { body: already ? body : `@${name} ${body}`, mentions };
  }

  /**
   * 群内定向说明（拼在当轮消息尾部，不进历史）。
   * @某人 = 只对他一个人的诉求，不是对全队的广播。
   */
  /**
   * 群里 @ 了人、但风铃还没接住的需求（2026-11-12 群聊模式，心跳兜底用）。
   *
   * 判定：用户卡带 mentions → 其后没有风铃的发言（点名或普通回复都算接住）。
   * 用户已定：走心跳兜底，不强制风铃当轮回应——延迟由心跳周期（默认 5 分钟）承担。
   */
  private pendingMentions(): { member: string; text: string; at: string }[] {
    const out: { member: string; text: string; at: string }[] = [];
    const feed = this.feed;
    for (let i = 0; i < feed.length; i += 1) {
      const c = feed[i];
      if (c.kind !== "user" || !c.mentions?.length) continue;
      // "已回应"= 风铃真的接住了：她点名做了动作，或她开口说了话。
      // 出错的卡不算（模型挂掉时的重试提示也是 lynn 卡，但它不是回应）。
      const answered = feed.slice(i + 1).some((later) => {
        if (later.code) return false;
        if (later.author?.kind === "lynn") return true;
        return later.kind === "lynn" && Boolean((later.text ?? "").trim());
      });
      if (answered) continue;
      for (const m of c.mentions) {
        if (m.kind !== "member") continue;
        out.push({ member: m.name, text: (c.text ?? "").slice(0, 120), at: c.createdAt });
      }
    }
    return out;
  }

  private groupDirective(mentions: FeedMention[]): string {
    const names = mentions.map((m) => (m.kind === "lynn" ? "风铃" : m.name)).join("、");
    const first = mentions[0];
    const who = first ? (first.kind === "lynn" ? "风铃" : first.name) : names;
    return (
      `【群内定向】这条消息 @ 到了：${names}。` +
      "@某人 = 只对他一个人的诉求，不是对全队的广播：必须落到针对他的具体动作" +
      "（在跑就 nudge_member 补话 / 已交就 assign_task 带 reworkTaskId 返工 / 没单就 assign_task），" +
      `并在本群回一条 @${who} 的说明，不要泛泛地说「已安排」。`
    );
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
        this.threads.bumpUnread(threadId);
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
    // 这个群你没在看 → 未读 +1（微信式群列表的红点）
    this.threads.bumpUnread(threadId);
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

  /** 进度卡（每单一张）：taskId+会话 → 卡 id，用来就地更新而不是一刷一张 */
  private progressCards = new Map<string, string>();
  /**
   * 上一轮成员做过的最后几步（2026-11-16）：重派时交给继任者/同一成员，
   * 否则它会从零把那棵目录树再列一遍。实机：同一张单被重派 6 次，每次都从 list_dir 开始。
   */
  private memberTrail = new Map<string, string[]>();
  /** 上一轮真正写出去的文件（2026-11-16）：重派时告诉成员"这些已经写过了"，别重复写/覆盖丢内容 */
  private memberProduced = new Map<string, string[]>();

  /**
   * 跟踪进度（2026-11-16 重做：**一张单只有一张进度卡**）。
   *
   * 实机证据：单张单的进度卡刷到 31 张，整个会话 200 条里 148 条是进度
   * （`list_dir：.` / `正在执行（还没返回）： list_dir：.` 各一条，同一动作两行）。
   * 结果是用户眼里"一直在重写、永远看不到结论"。
   *
   * 现在的规则：
   *  - 同一张单复用同一张卡，追加步骤（最多留最近 8 行，滚动窗口）；
   *  - 卡永远浮在她实时输出的前面（贴底跟随，最新一步在最下）；
   *  - `mode="meta"` 只更新"执行中 · Xs"，不往正文里加行——工具开始/结束不再各刷一条。
   */
  private appendProgress(
    threadId: string,
    taskId: string,
    member: string,
    text: string,
    meta: string,
    badge: NonNullable<FeedCard["badge"]> = "进度",
    mode: "append" | "meta" = "append",
  ): void {
    const local = !threadId || threadId === this.currentThreadId || !this.threadExists(threadId);
    const key = `${local ? (this.currentThreadId ?? "local") : threadId}::${taskId}::${badge}`;
    const list = local ? this.feed : this.threads.loadState(threadId).feed;
    const prevId = this.progressCards.get(key);
    const hit = prevId ? list.find((c) => c.id === prevId) : undefined;
    const at = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    if (hit) {
      // 本地先把它浮到最后一张非 live 卡的位置，再改内容（顺序对了只发一次通知）
      if (local && mode === "append") this.floatAboveLive(hit);
      const lines = (hit.body ?? "").split("\n").filter((l) => l.trim());
      const nextBody = mode === "meta" ? (hit.body ?? "") : [...lines, text].slice(-8).join("\n");
      this.patchCardTo(threadId, hit, { body: nextBody, meta, createdAt: at });
      return;
    }
    const created = this.cardTo(threadId, {
      kind: "tool",
      badge,
      jobId: taskId,
      title: `${member} · ${taskId}`,
      meta,
      body: mode === "append" ? text : "",
    });
    if (created) this.progressCards.set(key, created.id);
  }

  /** 把一张卡挪到"她的实时输出卡"之前（流式期间最新进展永远贴底） */
  private floatAboveLive(card: FeedCard): void {
    const live = this.liveCard;
    if (!live) return;
    const i = this.feed.indexOf(card);
    const l = this.feed.lastIndexOf(live);
    if (i < 0 || l < 0) return;
    if (i > l) return; // 已经在 live 后面（异常）：不动
    if (i === l - 1) return; // 已经在紧邻位置
    this.feed.splice(i, 1);
    const l2 = this.feed.lastIndexOf(live);
    if (l2 >= 0) this.feed.splice(l2, 0, card);
    else this.feed.push(card);
  }

  /** 回合状态迁移：所有 UI 的"谁在干什么"都只读这一个字段 */
  private setTurn(patch: Partial<TurnState>): void {
    this.turn = { ...this.turn, ...patch, pending: this.queue.length };
    this.notify({ type: "turn", turn: this.turn });
  }

  // ---------- 线程落盘（M1-14） ----------

  private threadSaveTimer: NodeJS.Timeout | null = null;

  /**
   * system prompt（M1-17/M2-05）：固定头 + persona + 记忆两层 + 项目身份 + 安全尾段；每轮现取。
   *
   * 这里**只放稳定段**（2026-11-14 缓存分层）：
   *  - 技能正文按当轮输入命中，进当轮消息尾部（pendingSkillText）；
   *  - 群公告 / 成员名单 / 公告未写提醒随时会变，进当轮消息尾部（turnFacts）。
   * 之前这些都拼在 system prompt 里，任何一次「写公告 / 招人 / 有新单」都会让
   * 「人设 + 记忆 + 全部历史」的前缀缓存整体作废，长对话的命中率就是这么掉下去的。
   */
  private systemPrompt(): string {
    /**
     * 组装交给 prompt-compiler（2026-11-17 P2-1c）：纯函数、顺序固定、可量每段。
     * 这里只负责"取料"，不再关心拼接顺序——顺序变了会被 golden 快照测试抓住。
     */
    const compiled = compileLynnPrompt({
      persona: composeSystemPrompt(this.persona.load()),
      memory: this.memorySectionCached(),
      project: this.projectContext(),
      environment: this.environmentFacts(),
      // 写作规则（2026-11-15 重做）：插件提供的固定约束段，会话内不变。
      // 放在 system prompt 末尾：换插件版本才变化，前缀缓存不受日常对话影响。
      rules: this.rulesSection("chat"),
    });
    this.lastPromptSegments = compiled.segments;
    return compiled.text;
  }

  /**
   * 会话级记忆快照（2026-11-17 缓存修复 B3）。
   *
   * 此前 `save_memory` 会热同步 system prompt；记忆段在 system 里，一改就等于把
   * 「人设 + 记忆 + 全部历史」的前缀整体作废（实测每天 13 次记忆变更，每次都断）。
   * 现在：会话内冻结，新记忆走当轮尾部提示（当轮可见），下个会话/切换项目时重建。
   */
  private memorySectionCached(): string {
    const key = `${this.currentThreadId ?? ""}|${this.currentProject()?.id ?? ""}`;
    if (this.memorySnapshot === null || this.memorySnapshotKey !== key) {
      this.memorySnapshot =
        this.memory.systemPromptSection() + this.memory.projectSection(this.currentProject()?.id);
      this.memorySnapshotKey = key;
      this.log("memory_snapshot", { chars: this.memorySnapshot.length, threadId: this.currentThreadId ?? "" });
    }
    return this.memorySnapshot;
  }

  /** 切会话/换项目后调用：下一次 systemPrompt 重建记忆段（本会话前缀因此重建一次） */
  private resetMemorySnapshot(): void {
    this.memorySnapshot = null;
    this.memorySnapshotKey = "";
  }

  /**
   * 写作规则段（外部插件 humanizer-stream）。
   * 没装插件 / 关掉开关 → 空串，一个字都不注入。
   */
  private rulesSection(profile: "chat" | "prose" | "code" | "ui", maxChars?: number): string {
    return writingRulesSection(profile, maxChars);
  }

  /**
   * 环境事实（2026-11-13）：路径别猜。
   *
   * 事故复盘：用户让「删除已取消任务的记忆条目」，风铃把 MEMORY.md/USER.md 当成项目里的文件，
   * 派成员去工作区找——成员的文件工具钉死在工作区（越界直接抛），这单从物理上就不可能成功，
   * 必然空转到打回上限。根因不是她不努力，是她**不知道那些文件在哪、也不知道那归她管**。
   *
   * 所以这里常驻四行事实：路径是真的、"归你管"的边界、数据根里成员碰不到的东西。
   */
  private environmentFacts(): string {
    const memoryDir = path.join(this.dataRoot, "memory");
    return [
      "\n【环境事实（路径都是真的，别猜）】",
      `- 你的记忆文件：${path.join(memoryDir, "MEMORY.md")}（助理记忆）、${path.join(memoryDir, "USER.md")}（用户记忆）——归你管；删条目用 forget_memory，**不要派成员去删文件**。`,
      `- 任务卷宗（没有项目时的沙箱）：${path.join(this.dataRoot, "tasks", "<任务ID>", "workspace")}。`,
      `- 知识库：${path.join(this.dataRoot, "knowledge")}（.md 文件，可检索）。`,
      `- 数据根 ${this.dataRoot} 里其余东西（凭据、会话、团队档案、插件、日志）成员一律够不着：别派单让他们去那里找或删。`,
    ].join("\n");
  }

  /**
   * 每轮可能变的本群事实（公告 + 成员名单 + 公告未写提醒）。
   *
   * 为什么不放 system prompt（2026-11-14）：这三样在同一个群里随时会变——用户改公告、
   * 风铃写公告、招人/遣散、有新单进来。它们一进 system prompt，任何一次变化都会让
   * 「人设 + 记忆 + 全部历史」的前缀缓存整体作废。挪到当轮消息尾部后，变化只影响尾部。
   * 语义不变：每条消息都带着它（风铃派单前仍然看得到谁管哪段、接缝在哪）。
   */
  private turnFacts(): string {
    if (!this.currentThreadId) return "";
    const parts: string[] = [];
    const ann = this.threads.get(this.currentThreadId)?.announcement?.trim();
    if (ann) {
      parts.push(`【本群公告（全局段：整体干什么 / 谁管哪段 / 接缝在哪 / 共享写入点归谁）】\n${ann}`);
    } else if (this.groupHasLiveWork()) {
      /**
       * 群公告没写（2026-11-13 实机）：整整跑完一轮，右栏公告始终是"还没写"。
       * 光在提示词里说"公告是全局段"不够——群里有活干的时候，每轮都把这件事摆到她面前，
       * 她写了就自动消失。只在"有在办的单"时出现，不打扰空群。
       */
      parts.push(
        "【本群公告还没写】群里已经有在办的事，但你还没写公告。" +
          "用 set_group_notice 写一句（整体干什么 / 谁管哪段 / 接缝在哪），写一次就够——它每轮都在你和成员的视野里。",
      );
    }
    const members = this.groupMembers();
    if (members.length) {
      parts.push(
        `【本群成员（${members.length} 人）】\n` +
          members.map((m) => `- ${m.name}${m.role ? `（${m.role}）` : ""}`).join("\n") +
          "\n（@ 只对群里的人有意义；要对某个人说话就 @ 他；派单按公告里的分工与接缝来。）",
      );
    }
    /**
     * 成员在等答复（2026-11-16）：这些是"别人干不了、只有她能定的"问题。
     * 放进每轮事实而不是只靠唤醒——她正忙时可能错过一次叫醒，问题不能就这么烂着。
     */
    const questions = [...this.questionPending.values()];
    if (questions.length) {
      parts.push(
        `【成员在等你答复（${questions.length} 单）】\n` +
          questions
            .map(
              (q) =>
                `- ${q.member}（${q.taskId}）：${q.items[q.items.length - 1]?.text.slice(0, 100) ?? ""}` +
                (this.questionMuted.has(q.taskId) ? "（已叫过 3 次，不再单独打断你，但问题还挂着）" : ""),
            )
            .join("\n") +
          "\n用 reply_member 回答或纠正（下一轮生效，不用重派）；答不了就让他按简报最合理的做法继续，并在回报里标注。",
      );
    }
    return parts.length ? `【本群当前情况】\n${parts.join("\n\n")}` : "";
  }

  /**
   * 把当轮易变事实贴到用户原话前面（只改这一条消息，历史与 system prompt 原样）。
   * 技能正文不在这里拼：直连路径自己拼（runChatDirect），Pi 路径在 runChatRpc 拼，
   * 免得两条路都拼一遍、同一段文字进去两次。
   */
  private withTurnFacts(userText: string): string {
    const facts = this.turnFacts();
    return facts ? `${facts}\n\n${userText}` : userText;
  }

  /** 本群有没有在办/待审的单（决定"公告还没写"要不要提醒；空群不打扰） */
  private groupHasLiveWork(): boolean {
    if (!this.currentThreadId) return false;
    return this.taskStore.list().some(
      (t) => t.threadId === this.currentThreadId && t.status !== "done" && t.status !== "canceled",
    );
  }

  /**
   * 当前项目（2026-11-12）：风铃必须知道这段对话在动哪个项目——
   * 否则派单时 workspace 只能靠猜，成员回报里也说不出项目。
   * 放 system prompt 而不是当轮消息尾部：换根本来就会重置会话（前缀缓存已作废），
   * 而它是每轮都得在的稳定事实，放固定位置比指望模型"记住"可靠。
   */
  private projectContext(): string {
    const proj = this.currentProject();
    const extras = this.roots.extras.map((r) => `${r.path}（${r.mode === "rw" ? "可写" : "只读"}）`);
    if (!this.projectRoot) {
      return (
        `【当前项目】本次不用项目目录（产出落任务卷宗 ~/.lynn/tasks/<id>/workspace）。\n` +
        "要落地到具体目录，派单时用 assign_task 的 workspace 指定绝对路径；材料在工作区外就申请 readRoots。"
      );
    }
    const name = proj?.name ?? defaultProjectName(this.projectRoot);
    return (
      `【当前项目】${name}\n` +
      `- 项目目录（成员读写主根）：${this.projectRoot}\n` +
      (extras.length ? `- 附加根：${extras.join("、")}\n` : "") +
      "（派单不传 workspace = 成员就在这个项目目录里干活；要隔离到卷宗就传 workspace=\"sandbox\"；换目录就传别的绝对路径。）\n" +
      "指代纪律：用户说「项目」「这个项目」「本项目」时默认就是指上面这个绑定项目，直接当已知事实开工——别把它当开放问题反问、更别翻历史里别的仓库来让他二选一；只有他点名了别的目录（或这句话在当前项目里说不通）才需要确认。"
    );
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

  /**
   * 角色模型（2026-11-14）：`prefs.modelRoles[role]` 指向的模型库条目，缺省回落当前默认。
   * 配了但条目被删 = 明确失败（getModel 不会用别的 Key 顶上），此时返回 null 由调用方决定降级。
   */
  private modelForRole(role: "worker" | "smol" | "advisor" | "tiny"): { baseUrl: string; apiKey: string; model: string } | null {
    const id = this.settings.getPrefs().modelRoles?.[role];
    const cfg = this.settings.getModel(id);
    if (!cfg) return null;
    const apiKey = loadApiKey(this.settings, (b) => this.decryptBlob(b), id);
    return apiKey ? { baseUrl: cfg.baseUrl, apiKey, model: cfg.model } : null;
  }

  /** 壳层读偏好（托盘/通知/截图/语音）：壳不直接碰 SettingsStore */
  getPrefs(): Prefs {
    return this.settings.getPrefs();
  }

  private assertMemoryKind(kind: string): asserts kind is MemoryKind {
    if (kind !== "user" && kind !== "memory") throw new Error(`未知记忆层：${kind}（user | memory）`);
  }

  /** 定时任务 tick（M2-02）：单飞——一次至多派一个；错过 >10 分钟如实标 missed 补跑 */
  private tickSchedules(): void {
    // 本群已终止：定时任务也延后（恢复后按 missed 补跑，不偷偷把她的活叫回来）
    if (this.isThreadHalted()) return;
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

  /** 语音播报注入点（2026-11-13）：内核决定「说什么」，壳层决定「怎么合成、怎么播放」 */
  setVoice(port: VoicePort | null): void {
    this.voice = port;
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
    /**
     * 技能来源三档（P12-2 调整）。
     *
     * `skills/`（用户级）与 `.lynn/skills/`（项目级）保持"放进去就生效"——
     * 那是用户自己管的地方，加个 `contributes.skills` 反而多一道手续。
     *
     * **插件目录改成按 manifest 声明**：插件是"别人写的、可能带多个产物"的包，
     * 不按声明过滤会出现"声明写错了技能照样加载"——那 `contributes.skills` 就是空字段。
     * 具体到每个插件目录单独成一个 root（而不是整个 `plugins/` 当一个 root），
     * 这样才能把各自的 `declared` 传下去。
     */
    const allRoots: { dir: string; level: SkillEntry["level"]; declared?: readonly string[] }[] = [
      { dir: path.join(this.dataRoot, "skills"), level: "user" },
      ...(hasProject ? [{ dir: path.join(this.projectRoot, ".lynn", "skills"), level: "project" as const }] : []),
      ...this.pluginSkillRoots(),
    ];
    const roots = allRoots.filter((r) => r.level !== "project" || trusted);
    const { entries, errors } = discoverSkills(roots);
    // 停用清单（用户在设置里关的技能）：不参与激活与 allowed-tools 强制
    const disabled = this.settings.getPrefs().disabledSkills ?? [];
    this.skillEntries = entries.filter((e) => !disabled.includes(e.name));
    for (const e of errors.slice(0, 8)) this.log("skill_error", { error: e });
    for (const e of entries) {
      for (const w of e.warnings.slice(0, 3)) this.log("skill_warning", { skill: e.name, warning: w });
    }
    this.log("skills_ready", { count: entries.length, projectTrusted: trusted });
  }

  /**
   * 把每个插件目录变成一个技能 root，并带上它自己的 `contributes.skills` 声明。
   *
   * 为什么不是一个 root 扫 `plugins/`：
   * `declared` 是**每个插件各自**的清单，混在一个 root 里就传不下去了。
   *
   * 没有声明 `skills` 的插件**不产出 root**——它的目录里就算有 `SKILL.md` 也不加载。
   * 这是"声明即生效"的另一面：不声明就不生效，行为可预期。
   */
  private pluginSkillRoots(): { dir: string; level: SkillEntry["level"]; declared: readonly string[] }[] {
    const pluginsRoot = path.join(this.dataRoot, "plugins");
    if (!fs.existsSync(pluginsRoot)) return [];
    const out: { dir: string; level: SkillEntry["level"]; declared: readonly string[] }[] = [];
    /**
     * 启用状态用 `pluginHost.scan()`——那是主进程的单一真相（`_state.json` + 安全模式）。
     * 自己再读一遍 `_state.json` 会漏掉安全模式这个条件：安全模式下所有非官方插件都算停用。
     */
    const disabled = new Set(this.pluginHost.scan().plugins.filter((p) => !p.enabled).map((p) => p.id));
    for (const e of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const dir = path.join(pluginsRoot, e.name);
      const manifestFile = path.join(dir, "plugin.json");
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as {
          id?: unknown;
          contributes?: { skills?: unknown };
        };
        const id = typeof raw.id === "string" ? raw.id : e.name;
        if (disabled.has(id)) continue;
        const skills = raw.contributes?.skills;
        if (!Array.isArray(skills) || !skills.length) continue;
        const declared = skills.filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
        if (!declared.length) continue;
        out.push({ dir, level: "plugin", declared });
      } catch {
        /* 坏 manifest 由 PluginHost 报，这里跳过 */
      }
    }
    return out;
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

  /**
   * 项目身份迁移（2026-11-12）：有主根但没绑项目的旧群，按主根补一个项目。
   * 同一个目录解析到同一个项目——所以两个群选了同一个目录，它们是同一个项目。
   */
  private migrateThreadProjects(): void {
    for (const t of this.threads.list()) {
      if (t.projectId) continue;
      const primary = primaryOf(this.rootsForThread(t));
      if (!primary) continue;
      try {
        const proj = this.projects.ensureByPath(primary);
        this.threads.setProjectId(t.id, proj.id);
      } catch {
        /* 索引写不进去就下次再试 */
      }
    }
  }

  /** 当前会话绑的项目（没有就 null——不拿目录名冒充项目） */
  private currentProject(): ProjectRecord | null {
    const id = this.threads.get(this.currentThreadId)?.projectId;
    return this.projects.resolve(id);
  }

  /** 把当前会话绑到某个项目（并把主根设成项目目录） */
  private bindProject(proj: ProjectRecord): void {
    if (!this.currentThreadId) return;
    // 项目记忆跟着项目走：绑定/换项目后记忆段必须重建（缓存修复 B3）
    this.resetMemorySnapshot();
    try {
      this.threads.setProjectId(this.currentThreadId, proj.id);
    } catch {
      /* 索引写失败不影响本次会话 */
    }
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
    // 换根往往换项目：记忆快照（含项目记忆）要重建
    this.resetMemorySnapshot();
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
      this.persistPreview();
    } catch {
      /* 落盘失败不影响对话 */
    }
  }

  /**
   * 群列表摘要（2026-11-12）：把最后一条有正文的消息压成一行，落进会话索引。
   * 左栏微信式群列表直接读它——不用逐个切进会话才看得到群里在聊什么。
   */
  private persistPreview(): void {
    if (!this.currentThreadId) return;
    // 摘要取"最后一句对话"，不取系统提示：模型挂掉时的报错不该成为这个群的简介
    const last =
      [...this.feed]
        .reverse()
        .find((c) => c.kind !== "system" && ((c.text ?? "").trim() || (c.body ?? "").trim())) ??
      [...this.feed].reverse().find((c) => (c.text ?? "").trim() || (c.body ?? "").trim());
    if (!last) return;
    const who =
      last.author?.kind === "member"
        ? last.author.name ?? "成员"
        : last.kind === "user"
          ? "你"
          : last.kind === "lynn"
            ? "风铃"
            : "";
    const body = (last.text ?? last.body ?? "").replace(/\s+/g, " ").trim();
    try {
      this.threads.setPreview(this.currentThreadId, who ? `${who}：${body}` : body, last.createdAt);
    } catch {
      /* 摘要写不进去不影响对话 */
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
    // 老卡没有群标记：趁当前群还在，先把它们认领到这里，别跟到新群去
    this.stampDecisionScope();
    // 切群要换 Pi 会话目录（--continue 指向新目录），前缀必然作废，记下来供命中率回查
    this.cacheBreakReason = "thread_switch";
    const meta = this.threads.get(id);
    if (!meta) throw new Error(`会话不存在：${id}`);
    this.persistThread();
    this.currentThreadId = id;
    this.threads.markRead(id); // 切进来 = 都看过了（群列表红点清零）
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
    // 项目身份跟着群走：没绑项目的群（新建/旧数据）按当前主根补一个
    if (meta && !meta.projectId && this.projectRoot) {
      try {
        const proj = this.projects.ensureByPath(this.projectRoot);
        this.threads.setProjectId(meta.id, proj.id);
      } catch {
        /* 索引写不进去不影响本次会话 */
      }
    }
    if (this.projectRoot !== prevRoot) {
      this.reloadSkills();
      void this.reloadMcp();
      this.watchMcpConfig();
    }
    // 切群不丢上下文（2026-11-12 实测后修）：该群有历史就让 Pi 续上（--continue +
    // 按群独立的 sessionDir，天然不串）；空群才开新会话（Pi 的 --continue 在空目录里可能报错）。
    // 原来这里一律 createFreshSession = true —— 切回一个群，风铃就"忘了"之前聊过什么。
    this.createFreshSession = st.history.length === 0;
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
    this.stampDecisionScope();
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
      const meta = this.threads.create("新群", this.roots);
      // 不走 switchThread：它会清空 feed，把这一轮已经生成的心跳卡/工具卡一起抹掉。
      // 这里是"给内存里已有的内容补一个归属"，不是"切到另一条会话"。
      this.currentThreadId = meta.id;
      this.resetMemorySnapshot();
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

  /**
   * Pi 官方 RPC 入口（基座原样，不 patch / 不 fork）；风铃逻辑全在 --extension 插件里。
   * 三条路径都要过 unpackedPath：它们会交给没有 asar 补丁的子进程（见 unpack-path.ts）。
   */
  private get rpcEntryPath(): string {
    return unpackedPath(
      path.join(
        __dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "rpc-entry.js",
      ),
    );
  }

  private get piExtensionPath(): string {
    return unpackedPath(path.join(__dirname, "..", "..", "agent", "extensions", "lynn-bridge.mjs"));
  }

  /** 旧自建协议：只作为一键回退（LYNN_USE_LEGACY_RPC=1），不再默认使用 */
  private get legacyEntryPath(): string {
    return unpackedPath(path.join(__dirname, "..", "..", "agent", "pi-rpc-entry.mjs"));
  }

  private get useOfficialRpc(): boolean {
    return process.env.LYNN_USE_LEGACY_RPC !== "1";
  }

  /**
   * 厂商上下文窗口（2026-11-13 缓存审计）：models.yaml 自定义（带 context_window）优先，
   * 其次内置预设（MiniMax≈1M），未知厂商不传（Pi 侧安全默认 128K）。
   * 这个值决定 Pi 的压缩触发时机——硬编码 128K 会让大窗口模型提前压缩：
   * 一次压缩 = 整段前缀缓存作废 + 全价重读（实测一次 41 万 token）。
   */
  private resolveContextWindow(provider: string | undefined): number | undefined {
    const key = (provider ?? "").trim().toLowerCase();
    if (key) {
      try {
        const { providers } = loadProviders(this.dataRoot);
        for (const p of providers) {
          if (p.contextWindow && (p.id.toLowerCase() === key || p.name.toLowerCase().includes(key))) {
            return p.contextWindow;
          }
        }
      } catch {
        /* yaml 读不了就用预设 */
      }
    }
    return presetContextWindow(provider) ?? undefined;
  }

  /** 这张单此刻是否真有工具在执行（超过上限就不算，免得一条挂死的工具永远免检） */
  private toolBusy(taskId: string, now: number = Date.now()): boolean {
    const since = this.memberToolSince.get(taskId);
    if (since === undefined) return false;
    return now - since < TOOL_BUSY_MAX_MS;
  }

  /**
   * 预览/打开守卫用：这句 ref 是不是这张单登记过的交付物。
   * solidifyDeliverables 只把 ≤10MB 且在工作区内的复制进 artifacts，其余（只读根、超大文件）
   * 只登记绝对路径原文。不认这些路径的话，G 盘这类目录外交付物点开永远没反应。
   */
  isTaskDeliverable(taskId: string, ref: string): boolean {
    const t = this.taskStore.get(taskId);
    if (!t?.deliverables?.length) return false;
    const target = path.resolve(ref);
    return t.deliverables.some(
      (d) => d.ref === ref || d.path === ref || path.resolve(d.path) === target,
    );
  }

  /**
   * 待你拍板的东西必须跨重启活着。
   * pendingPlans / decisions 原本只在内存里：进程一重启，"等用户确认契约"的单就没人认领，
   * 心跳会把一张本来在正常等你的单当成"停滞"去催风铃重做/关单——用户的决定被系统自己吃掉了。
   * 审批类决策带着 promise 解析器，跨重启没有意义（两条审批都有超时兜底），只持久化 plan / question。
   */
  private pendingFile(): string {
    return path.join(this.dataRoot, "pending.json");
  }

  private persistPending(): void {
    try {
      const plans = [...this.pendingPlans.values()];
      const decisions = this.decisions.filter((d) => d.kind !== "approval");
      if (plans.length === 0 && decisions.length === 0) {
        try {
          fs.unlinkSync(this.pendingFile());
        } catch {
          /* 本来就没有 */
        }
        return;
      }
      const tmp = `${this.pendingFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ plans, decisions }, null, 2), "utf-8");
      fs.renameSync(tmp, this.pendingFile());
    } catch {
      /* 持久化失败不能挡住派单：下一次状态变化还会再写 */
    }
  }

  private loadPending(): void {
    type PendingFile = { plans?: PendingPlan[]; decisions?: Decision[] };
    let data: PendingFile;
    try {
      data = JSON.parse(fs.readFileSync(this.pendingFile(), "utf-8")) as PendingFile;
    } catch {
      return; // 没有/坏了就当没有
    }
    for (const p of data.plans ?? []) {
      if (!p?.taskId || !p?.decisionId) continue;
      const rec = this.taskStore.get(p.taskId);
      // 工单已结案/被删：契约作废，别再挂一张点不动的卡
      if (!rec || rec.status === "done" || rec.status === "canceled") continue;
      this.pendingPlans.set(p.decisionId, p);
    }
    for (const d of data.decisions ?? []) {
      if (!d?.id || d.kind === "approval") continue;
      if (this.decisions.some((x) => x.id === d.id)) continue;
      // 指向的单已经没了，问题也就没意义
      if (d.jobId && !this.taskStore.get(d.jobId)) continue;
      // 老版本落盘时没写群标记：能从工单反查就反查，实在查不到归给启动时的当前群，
      // 绝不能变成一张"每个群都弹"的卡。
      if (!d.threadId) d.threadId = this.decisionThreadId(d) || this.currentThreadId;
      this.decisions.push(d);
    }
    // 补上的归属回写一次，下次重启不用再猜
    this.persistPending();
  }

  /**
   * 一张「等你拍板」属于哪个群（2026-11-15）。
   * 新卡自带标记；老卡按它指向的工单或派单契约反查，不猜、不默认给所有群。
   */
  private decisionThreadId(d: Decision): string {
    if (d.threadId) return d.threadId;
    if (d.jobId) {
      const t = this.taskStore.get(d.jobId);
      if (t?.threadId) return t.threadId;
    }
    const p = this.pendingPlans.get(d.id);
    if (p) return p.threadId ?? this.taskStore.get(p.taskId)?.threadId ?? "";
    return "";
  }

  /** 切群前把没标记的老卡认领到切走前的群：不让它们跟着用户串到新群 */
  private stampDecisionScope(): void {
    const from = this.currentThreadId;
    let changed = false;
    for (const d of this.decisions) {
      if (d.threadId) continue;
      const owner = this.decisionThreadId(d) || from;
      if (!owner) continue;
      d.threadId = owner;
      changed = true;
    }
    if (changed) this.persistPending();
  }

  /** 快照只出本群的挂起卡：新建群/切群后不该看见别群的问题、契约、审批 */
  private decisionsForCurrentThread(): DecisionEntry[] {
    const id = this.currentThreadId;
    return this.decisions.filter((d) => {
      const owner = this.decisionThreadId(d);
      return !owner || owner === id;
    });
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
        this.taskStore.transition(t.id, "blocked", {
          blockedReason: "reconcile",
          note: "上次进程中断，成员已不在跑",
        });
        n += 1;
      } catch {
        /* 迁移规则不允许就不强改 */
      }
    }
    if (n > 0) {
      this.card({
        kind: "system",
        title: "恢复",
        systemTone: "recover",
        text: `${n} 张单在上次运行时中断、没有收尾（成员已不在跑），已标成「卡住」。风铃会在同一张单上判断重做或关单，不用你处理。`,
      });
    }
  }

  async init(): Promise<void> {
    // 上次被用户「终止任务」的群：重启后仍然停手，等用户发新消息才恢复（2026-11-15）
    this.haltedThreads = new Set(this.threads.list().filter((t) => t.haltedAt).map((t) => t.id));
    // 先把上次没拍板的契约/提问捞回来：否则它们在内存里消失，重启后会被当成"停滞"误处置
    this.loadPending();
    // 上次没收尾的单先对账（放在最前：界面一打开就该是真实状态）
    this.reconcileOrphanTasks();
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
    // 去 AI 味插件（2026-11-15）：外部包，找不到就当没装（不影响启动，也不影响输出）
    setHumanizerEnabled(this.settings.getPrefs().humanizer !== false);
    void loadHumanizer(this.dataRoot).then((h) => {
      if (h && this.settings.getPrefs().humanizer !== false) this.log("humanizer_loaded", { dir: h.dir, version: h.version });
    });
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
    this.heartbeatTimer = setInterval(() => this.heartbeatTick("timer"), 60_000);
    this.heartbeatTimer.unref?.();
    // 秒级探针（2026-11-11）：只读内存态、零 token；有成员在跑 1s 一次，空闲退避 15s。
    this.probeTick();

    // 第二段（2026-11-14）：office 探测 / 清理 / 知识库 watch / L1 / MCP 都可能等磁盘或等进程，
    // 串行放在这里会拖慢"点了就开"。生产环境推到下一个事件循环 tick；
    // 测试里仍同步跑完（测试习惯 init() 之后立刻断言工具面与 office 健康）。
    if (process.env.NODE_TEST_CONTEXT) await this.lateInit();
    else setImmediate(() => void this.lateInit());
  }

  /**
   * init 的第二段：都不影响"界面能不能用"，但每一项都可能阻塞。
   * 失败只记日志——工具调用侧本来就有"未就绪如实降级"的分支，不该因此启动失败。
   */
  private async lateInit(): Promise<void> {
    try {
      this.officeHealth = await probeSoffice();
    } catch {
      this.officeHealth = { found: false, kind: "none", detail: "引擎探测失败（不影响 CSV）" };
    }
    // 过程文件清理（P2-1）：只碰 scratch/检查点/旧日志
    try {
      runCleanup(this.dataRoot, this.settings.getPrefs().retention);
    } catch {
      /* 清理失败不阻塞任何事 */
    }
    // 知识库增量索引（M2-09）：文件变更去抖 800ms 后增量重索引
    try {
      this.kbWatch = watchKnowledge(this.knowledge.dir, () => this.knowledge.reindex(), {
        onChange: (r) => {
          if (r.indexed || r.removed) this.log("kb_indexed", r);
        },
      });
    } catch (err) {
      console.warn("[kernel] 知识库 watch 启动失败：", err);
    }
    // L1 插件启动加载（§4.2.1）：单个失败不影响其余，诊断留在 l1.lastErrors
    try {
      await this.l1.loadAll();
      for (const e of this.l1.lastErrors) console.warn("[kernel] L1 加载失败：", e);
    } catch (err) {
      console.warn("[kernel] L1 加载失败：", err);
    }
    // L2 MCP（M0-07）：全局配置 + 已信任项目的项目级配置
    try {
      await this.reloadMcp();
    } catch (err) {
      console.warn("[kernel] MCP 连接失败：", err);
    }
    // 实时生效：盯住两处 mcp.json，保存即重连（不用重启应用）
    try {
      this.watchMcpConfig();
    } catch (err) {
      console.warn("[kernel] MCP watch 启动失败：", err);
    }
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

    /**
     * 插件声明的 MCP server（P11-2）。
     *
     * 合并进同一份 map：`McpRegistry` 只认 server id，不关心来源。
     * 插件 server 的 id 已加插件前缀（`lynn.a:fs`），不会与全局/项目配置撞车。
     *
     * 顺序：全局 → 项目 → 插件。后者覆盖前者的前提是 id 相同，
     * 而前缀化让这种情况几乎不可能——所以实际是"三份并列"。
     */
    const pluginMcp = scanPluginMcp(this.dataRoot);
    for (const e of pluginMcp.errors) {
      this.log("plugin_mcp_error", { error: e });
      if (!opts.quiet) this.card({ kind: "system", text: `插件 MCP 配置有问题：${e}` });
    }
    for (const s of pluginMcp.servers) merged.set(s.id, s);

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
   * 顾问审一份交付（2026-11-14）：独立一次调用，只看这份交付，不碰任何状态。
   *
   * 失败只记日志——顾问看不见就是没看见，绝不因此阻塞验收，也不落卡制造"审过了"的错觉。
   * 每单只审一次：重派之后再审同一份交付没有新信息，只会多烧一次 token。
   */
  private async consultAdvisorFor(taskId: string, threadId: string, report: string, artifacts: string[]): Promise<void> {
    if (!this.settings.getPrefs().advisorEnabled) return;
    // 额度熔断期不派顾问（实机 19 次顾问调用全部 abort，白烧一次完整调用）
    if (this.quotaCoolingDown()) return;
    if (this.advisorReviewed.has(taskId)) return;
    const rec = this.taskStore.get(taskId);
    if (!rec) return;
    if (this.isThreadHalted(threadId)) return;
    const model = this.modelForRole("advisor");
    if (!model) {
      this.log("advisor_skipped", { taskId, why: "no_model" });
      return;
    }
    this.advisorReviewed.add(taskId);
    const taskText = [
      rec.title,
      rec.brief ? `【简报】\n${rec.brief}` : "",
      rec.acceptance?.length ? `【验收标准】\n${rec.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const notes = filterNotes(
        await consultAdvisor({ model, task: taskText, report, artifacts }, this.advisorChatFn ?? undefined),
        this.advisorSeen,
      );
      if (!notes.length) return;
      const body = notes
        .map((n) => {
          const ev = n.evidence ? `\n依据：${n.evidence}` : "";
          const sg = n.suggest ? `\n建议：${n.suggest}` : "";
          return `**${severityLabel(n.severity)}** · ${n.title}${ev}${sg}`;
        })
        .join("\n\n");
      // 本轮顾问意见回来时这个群可能已经被终止：不再往停住的群里丢卡
      if (this.isThreadHalted(threadId)) return;
      this.cardTo(threadId, {
        kind: "tool",
        badge: "顾问",
        title: `顾问意见 · ${rec.title}`,
        body: `${body}\n\n（独立模型看的，只提会返工的问题；采不采纳由你定。）`,
        jobId: taskId,
      });
    } catch (err) {
      this.log("advisor_failed", {
        taskId,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
    }
  }

  /**
   * 阶段账推进（2026-11-15）：阶段进度由代码持有，不放在模型上下文里。
   *
   * 实机教训：7 阶段长任务里顺序全靠模型自己记，两次上下文压缩后它开始复述摘要、
   * 查 246 次进度、重派 24 次。**阶段这类"事实"必须落在工单上**——压缩、换会话、
   * 重开单都抹不掉，模型每轮从 check_progress 读到的才是真的。
   * 失败只记日志：阶段账是辅助事实，不能反过来打断回报/验收主流程。
   */
  private advanceStage(taskId: string, ids: string | string[], evidence: string[]): string {
    const plan = this.taskStore.get(taskId)?.stagePlan;
    if (!plan) return "";
    let next = plan;
    const moved: string[] = [];
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const s = next.stages.find((x) => x.id === id);
      if (!s || s.status !== "active") continue;
      const r = tryCompleteStage(next, id, evidence);
      if (!r) continue;
      next = r;
      moved.push(s.title);
    }
    if (!moved.length) return "";
    try {
      this.taskStore.setStagePlan(taskId, next);
      this.taskCase.append(taskId, { kind: "note", text: `阶段：${moved.join("、")} → 完成` });
    } catch (err) {
      this.log("stage_write_failed", {
        taskId,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
      return "";
    }
    return stageLine(next);
  }

  /** 工单上的阶段进度（查进度/详情/提示词共用；没有阶段账就返回空串） */
  private stageSummaryOf(taskId: string): string {
    const plan = this.taskStore.get(taskId)?.stagePlan;
    return plan ? stageLine(plan) : "";
  }

  /**
   * 全部阶段结束 → 由代码生成最终验收表（2026-11-15）。
   * 实机里"收尾"一直靠模型自觉，于是它交完一半就宣布完成；这里把收尾变成一次闸。
   */
  private finalizeStagesIfReady(taskId: string): string {
    const plan = this.taskStore.get(taskId)?.stagePlan;
    if (!plan || !shouldFinalize(plan)) return "";
    try {
      const done = finalizeStagePlan(plan);
      this.taskStore.setStagePlan(taskId, done);
      this.taskCase.append(taskId, { kind: "note", text: "阶段：全部结束，已生成最终验收表" });
      return stageLine(done);
    } catch (err) {
      this.log("stage_finalize_failed", {
        taskId,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
      return "";
    }
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
    /**
     * 只有落在这个根里的证据才复制进 artifacts；
     * 只读根里的文件只登记引用（不把用户项目整份拷走，2026-11-10）。
     */
    copyRoot?: string,
    /**
     * 是不是"成员真交回报"（2026-11-12）。
     * 成员自己跑完交上来的 → 要立刻叫醒风铃去验收；
     * 风铃自己调 review_result 登记的 → 不用叫（她自己就在这一轮里）。
     */
    notifyLynn = false,
    /**
     * 要不要由这里落「回报」卡（2026-11-13）。
     * 成员自己跑完交上来的路径会在外面再落一张信息更全的卡（轮次/耗时/产物可点），
     * 这里再落一张就是同一份回报画两遍——实机截图里两张一模一样的回报卡。
     */
    announce = true,
  ): string {
    this.tools.reviewResult(teamId, taskId, { member, text, evidence, sessionId: sessionId ?? this.host?.sessionId });
    this.taskCase.append(taskId, { kind: "report", member, text, meta: { evidence } });
    this.taskCase.appendSummary(taskId, `${member} 回报：${text.slice(0, 60)}`);
    // 新回报 = 新产物：上一轮的"已读"不算数，验收前要重读
    this.artifactsInspected.delete(taskId);

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
        // 只有关键任务（evidencePolicy=required）才会走到这里；普通任务证据可选，不拦。
        this.cardTo(threadId, {
          kind: "tool",
          badge: "回报",
          title: `交付待补充 · ${member} · ${taskId}`,
          body: `本单要求核验记录，目前可核验 ${verified} 项。补齐后即可进入验收。`,
        });
        return `回报已登记；本单要求核验记录，目前可核验 ${verified} 项（要求 ≥1）：补齐后再验收，或确认按普通任务放行。`;
      }
    }

    /**
     * 阶段账（2026-11-15）：成员交回回报 = 本单"产出/勘察"这一段做完了。
     * 探索型任务没有产出阶段，交回报等于勘察结论到手——别拿 execute 的阶段名硬套。
     */
    const stageDone = this.advanceStage(
      taskId,
      this.taskStore.get(taskId)?.mode === "explore" ? "survey" : "produce",
      evidence.length ? evidence.slice(0, 5) : [`回报：${text.slice(0, 40)}`],
    );

    if (announce) {
      const jobTitle = (this.taskStore.get(taskId)?.title ?? taskId).replace(/\s+/g, " ").slice(0, 24);
      const gist = String(text ?? "")
        .replace(/^\s*【[^】]*】\s*/u, "")
        .replace(/\s+/g, " ")
        .split(/[。！？\n]/)[0]
        .slice(0, 36);
      this.cardTo(threadId, {
        kind: "tool",
        badge: "回报",
        title: `${member} · ${taskId}`,
        // 用户只看结果：回报卡就是成员交回的那段结论，不附证据清单与核验计数
        body: text,
        // 语音必须说清"哪件事、交回什么"——只念名字等于没播（2026-11-16）
        speak: `${member}交回「${jobTitle}」${gist ? `：${gist}` : "的结果"}。`,
        // 群聊：成员第一次以自己的身份在群里发言（带头像、岗位、名字）
        author: this.memberAuthor(teamId, member),
      });
    }
    /**
     * 成员交回结果：评估一次心跳（有闸）并叫醒风铃去验收。
     *
     * 2026-11-13 修顺序：这两个动作原本就地执行，于是风铃的卡**先于**调用方那张
     * 带「轮次/耗时」的回报卡落地——实机看到的就是"她的结论夹在成员回报中间"。
     * 挪到微任务里：调用方的卡先写完（cardTo 是同步的），再叫醒她。
     */
    // 成员自己交的（notifyLynn）记一笔：风铃再 review_result 同名单据就不许重复登记。
    // 2026-11-15：按「成员」记，不再只按单——同一张单上验收员（另一名成员）也要回报，
    // 不能因为执行成员先报过就把验收员的回报拦掉。
    if (notifyLynn) this.selfReported.add(`${taskId}::${member}`);
    const kickReview = () => {
      this.requestHeartbeat("report");
      if (!notifyLynn) return;
      const reporterIsAcceptor = this.isAcceptor(teamId, member);
      // 执行成员回报 → 交给本队验收员验收（不叫醒风铃读全文）；验收员回报 → 才叫醒风铃看结论。
      // 队里没设验收员时回落老行为：直接叫醒风铃。
      if (!reporterIsAcceptor && this.teamHasAcceptor(teamId)) {
        this.engageAcceptor(teamId, taskId, member, text, verified);
      } else {
        this.wakeLynnForReview(taskId, member, text);
      }
    };
    queueMicrotask(kickReview);
    const stageTail = stageDone ? `\n阶段：${stageDone}` : "";
    return (
      moved
        ? evidence.length
          ? `回报已登记，${verified} 项证据已验证并收入卷宗，工单进入待审查。`
          : "回报已登记（未附证据，本单证据可选），工单进入待审查。"
        : "回报已登记（含证据索引）。"
    ) + stageTail;
  }

  /**
   * 成员交回报 = 闭环的关键节点：立刻叫醒风铃去验收（2026-11-12 用户实测发现）。
   * 此前只有心跳巡检（默认 5 分钟一闸）或用户主动问，风铃才知道有人交了活——闭环断了。
   * 忙的时候先挂着，别打断正在跑的活。
   */
  private wakeLynnForReview(taskId: string, member: string, text: string): void {
    // 本群被用户终止：不叫醒（成员都已停机，这条只是迟到的事件）
    if (this.isThreadHalted(this.taskStore.get(taskId)?.threadId)) return;
    this.reviewPending.push({ taskId, member, text: text.slice(0, 300) });
    this.drainReviewPending();
  }

  /** 忙、或用户正在拍板契约时先挂着：这轮收尾再叫 */
  private drainReviewPending(): void {
    if (!this.reviewPending.length) return;
    if (this.isThreadHalted()) return; // 本群已终止：叫醒也不叫（发新消息才恢复）
    if (this.busy) return; // 别打断正在跑的活
    if (this.turn.phase === "awaiting_plan") return; // 用户正在拍板，别插队
    const item = this.reviewPending.shift();
    if (!item) return;
    const stageNow = this.stageSummaryOf(item.taskId);
    this.submitTurn(
      `【成员回报】${item.member} 交了 ${item.taskId}：${item.text}\n` +
        (stageNow ? `当前阶段：${stageNow}\n` : "") +
        "现在验收：先 read_artifact 读产物正文（没读过正文不许点头），再逐条对完成标准 → " +
        "合格就 accept_or_reject 验收，不合格就打回并写清改什么、期望什么；缺材料就如实说缺什么。\n" +
        // 2026-11-13 实机：她验收完就收轮，用户只看到一堆过程卡，最后一份汇报都没有
        "**验收完必须用 report_to_user 给用户一句结论**（做了什么 / 结论是什么 / 还剩什么），" +
        "她只对那一份汇报拍板——不写汇报等于这件事没交接给她。",
      undefined,
      { internal: true, ephemeral: true },
    );
  }

  /**
   * 成员在群里说了一句话（2026-11-16）。
   *
   * 取的是"消息总线 + 打断级别"，不是自由聊天（参考 MetaGPT 的 cause_by/watch、
   * openspawn 的"沉默即成功"与 AutoGen 的群聊终止条件）：
   *  - 一律落群时间线（作者=成员、带头像），用户看得见成员干到哪、想到哪；
   *  - update / finding 只落群，**不唤醒任何人**——每条进展都叫一次会烧掉大量预算；
   *  - question / risk 才进待答队列，她空闲时叫醒（同单合并、每单最多 3 次）。
   * 返回值是给成员的回执：它据此决定继续做、还是按假设继续并标注。
   */
  private memberSaid(
    threadId: string,
    teamId: string,
    taskId: string,
    member: string,
    post: MemberPost,
  ): string {
    const badge = POST_BADGE[post.kind] ?? "进展";
    const text = post.text.trim();
    const rec = this.taskStore.get(taskId);
    const jobTitle = String(rec?.title ?? taskId).replace(/\s+/g, " ").slice(0, 24);
    // 1) 群时间线：一次人类式发言（不折叠、带头像）。进展类不写 speak——语音只念需要人接的事
    const needVoice = post.kind === "question" || post.kind === "risk";
    this.cardTo(threadId, {
      kind: "tool",
      badge,
      jobId: taskId,
      title: `${member} · ${taskId}`,
      body: text,
      meta: post.needAnswer ? "等你答复" : undefined,
      author: this.memberAuthor(teamId, member),
      ...(needVoice
        ? {
            speak: `${member}在「${jobTitle}」里${post.kind === "question" ? "问了一句" : "报了个风险"}：${text.slice(0, 40)}`,
          }
        : {}),
    });
    // 2) 卷宗：发言是过程事实，验收与复盘都要看得到
    this.taskCase.append(taskId, { kind: "note", member, text: `[${badge}] ${text}` });
    // 3) 路由：只有提问与风险值得打断她
    if (post.kind !== "question" && post.kind !== "risk") {
      return "已经发到群里（进展类不会打断任何人）。继续干活；有结论或卡住了再说。";
    }
    this.queueMemberQuestion(threadId, teamId, taskId, member, post);
    if (post.kind === "risk") {
      return (
        "已经发到群里并通知风铃。若她没回，就按简报里最合理的做法继续，" +
        "并在回报里写明这条风险与你选的处置——不要停在原地等。"
      );
    }
    return post.needAnswer
      ? "已经发到群里，风铃会在你下一轮前答复。先把不依赖它的部分做完；仍没答复就在回报里标【受阻】写清缺什么。"
      : "已经发到群里，风铃会在下一轮前答复。不用停在这等——继续做不依赖它的部分。";
  }

  /** 把一条疑问/风险挂进待答队列（同单合并；本群被终止就不叫醒） */
  private queueMemberQuestion(
    threadId: string,
    teamId: string,
    taskId: string,
    member: string,
    post: MemberPost,
  ): void {
    if (this.isThreadHalted(threadId)) return;
    const item = {
      id: `mq-${++this.questionSeq}`,
      kind: post.kind,
      text: post.text.trim().slice(0, 400),
      ...(post.needAnswer ? { needAnswer: true } : {}),
    };
    const prev = this.questionPending.get(taskId);
    if (prev) {
      // 同一单已经在等答复：合并进同一段，不重复叫醒（她一轮就能一起回）
      prev.items.push(item);
      this.requestHeartbeat("member_question");
      return;
    }
    this.questionPending.set(taskId, { taskId, teamId, member, threadId, items: [item] });
    // 事件心跳是兜底（有合并窗口/冷却/配额）；正常路径是 drainQuestionPending 立刻叫醒
    this.requestHeartbeat("member_question");
    this.drainQuestionPending();
  }

  /**
   * 叫醒风铃答复成员（2026-11-16）。
   * 与验收队列同一套纪律：忙 / 用户在拍板契约时先挂着，收轮后再叫；
   * 每单最多 MEMBER_QUESTION_WAKES 次。超过只停止"单独叫醒"，问题仍留在队列里——
   * 每轮事实段会继续提醒她，不能因为降噪把成员的问题静默吞掉。
   */
  private drainQuestionPending(): void {
    if (this.questionPending.size === 0) return;
    if (this.isThreadHalted()) return;
    if (this.busy) return;
    if (this.turn.phase === "awaiting_plan") return;
    // 只挑第一张「还没停叫」的单：超过上限的单留在队列里（每轮事实段会继续提醒她），
    // 但不能堵住后面还能答的单
    let picked: [string, PendingMemberQuestion] | null = null;
    for (const entry of this.questionPending) {
      if (this.questionMuted.has(entry[0])) continue;
      picked = entry;
      break;
    }
    if (!picked) return;
    const [taskId, q] = picked;
    const wakes = this.questionWakes.get(taskId) ?? 0;
    if (wakes >= MEMBER_QUESTION_WAKES) {
      /**
       * 已经为这张单叫过 3 次：不再单独唤醒，但**问题不丢**——
       * 留在 questionPending 里由每轮事实段持续提醒（她有空时会看到），
       * 只落一条说明让群里知道为什么不再打断。否则成员的问题会静默消失，
       * 而用户看到的只是"它问了没人理"。
       */
      this.questionMuted.add(taskId);
      this.cardTo(q.threadId, {
        kind: "system",
        badge: "进度",
        jobId: taskId,
        text: `${q.member} 又在 ${taskId} 里提了 ${q.items.length} 个问题，但这单已回答过 ${MEMBER_QUESTION_WAKES} 次：不再单独叫醒风铃，问题会留在待办里随每轮提醒她。`,
      });
      return;
    }
    this.questionPending.delete(taskId);
    this.questionWakes.set(taskId, wakes + 1);
    const rec = this.taskStore.get(taskId);
    const steps = this.memberTrail.get(taskId)?.slice(-3) ?? [];
    const blocked = [...(this.memberBlockedCmds.get(taskId) ?? [])].slice(-3);
    this.submitTurn(
      [
        `【成员在群里说话】${q.member}（${taskId}「${String(rec?.title ?? taskId).slice(0, 24)}」）说了：`,
        ...q.items.map((i) => `- [${i.kind === "question" ? "疑问" : "风险"}] ${i.text}`),
        steps.length ? `\n它最近几步：${steps.join(" / ")}` : "",
        blocked.length ? `\n最近被拦下的命令：${blocked.join(" / ")}（可能是权限问题，不是它不会做）` : "",
        "\n作为指挥者处理：",
        "①提问 → 能一句话答就直接 reply_member（下一轮生效，不重派、不丢已写文件）；答不了就让它按简报最合理做法继续，并要求在回报里标注；",
        "②风险 → 先判断它说的对不对：对就 reply_member 给新做法或补授权建议；不对就当场纠正错在哪；",
        "③如果它是在为猜着做找借口（简报其实写清了）→ reply_member 要求它按简报执行，不要再问；",
        "④只有牵涉花钱/删数据/对用户口径这类你决定不了的事，才 ask_user 转呈用户。",
        "不要重复派单，也不要把成员的问题原样甩给用户。",
      ]
        .filter(Boolean)
        .join("\n"),
      undefined,
      {
        internal: true,
        ephemeral: true,
        mentions: [{ kind: "member", name: q.member, memberId: q.member }],
      },
    );
  }

  /**
   * 风铃回答 / 纠正成员（2026-11-16）：落到群里 + 送进成员收件箱，下一轮生效。
   * 与 nudge_member 的区别：nudge 是催办，reply 是"回答疑问 / 纠正错误"，群里的措辞也该看得出。
   */
  replyMember(taskId: string, text: string): string {
    const note = text.trim();
    if (!note) return "回答不能为空：直接说结论或该怎么做。";
    const rec = this.taskStore.get(taskId);
    if (!rec) return `没有这张单：${taskId}（ID 由系统生成，别自己编）。`;
    const running = this.memberRuns.has(taskId);
    const owner = rec.threadId ?? this.currentThreadId;
    // 这条回答覆盖到这一单的待答疑问：从队列里摘掉（不靠模型传问题 id，按单匹配）
    this.questionPending.delete(taskId);
    if (!running) {
      // 成员已经跑完：回答仍要进群（用户要看她的判断），但成员看不到，必须说清怎么让成员继续
      const at = this.atMember(rec.member ?? "", `（这单已经没人在跑）${note.slice(0, 500)}`);
      this.cardTo(owner, {
        kind: "lynn",
        jobId: taskId,
        text: at.body,
        author: { kind: "lynn", name: "风铃" },
        mentions: at.mentions,
      });
      return `${taskId} 已经没人在跑：这句已发到群里，但成员看不到。要它继续改，就用 assign_task 带 reworkTaskId=${taskId} 在原单上重做。`;
    }
    return this.nudgeMember(taskId, note, false, "reply");
  }

  /** 这名成员是不是本队的常驻验收员（2026-11-15） */
  private isAcceptor(teamId: string, member: string): boolean {
    try {
      return !!this.teamStore.readMember(teamId, member)?.acceptor;
    } catch {
      return false;
    }
  }

  /** 本队有没有常驻验收员 */
  private teamHasAcceptor(teamId: string): boolean {
    try {
      return this.teamStore.listMembers(teamId).some((m) => m.acceptor);
    } catch {
      return false;
    }
  }

  /**
   * 执行成员回报后，交给本队验收员做最终验收（2026-11-15）。
   * 验收在验收员自己的 runMemberTask 上下文里跑——风铃不必逐一读所有执行成员的全文汇报，
   * 只等验收员那张紧凑的【验收结论】。验收员只读不写（工具面收窄到 read_file/list_dir/submit_report）。
   * 队里没验收员、或派不动时回落：直接叫醒风铃去验。
   */
  private engageAcceptor(
    teamId: string,
    taskId: string,
    workerMember: string,
    workerReport: string,
    /** 已验证的证据数（registerReport 里核验过的）：未核验的路径不算"有产物" */
    verifiedEvidence = 0,
  ): void {
    const acc = this.teamStore.listMembers(teamId).find((m) => m.acceptor);
    if (!acc) {
      this.wakeLynnForReview(taskId, workerMember, workerReport);
      return;
    }
    const task = this.taskStore.get(taskId);
    /**
     * 小任务不另起验收员（2026-11-15）：判据 ≤2 条的单，单独跑一次完整执行来验收
     * 比产出本身还贵，用户看到的就是"一篇散文架了三支队"。风铃看成员交的核对清单拍板即可。
     */
    if (task?.scale === "small") {
      this.wakeLynnForReview(taskId, workerMember, workerReport);
      return;
    }
    /**
     * 零产物不派验收员（2026-11-16 实机）：执行成员一个文件没交，验收员照样跑满 15 轮 100s
     * 只为了得出「docs/perf-audit-output-path.md 不存在」。这种情况不是"待验收"，是"没做出来"，
     * 直接交回风铃按失败处理（换人 / 换法 / 关单并如实汇报）。
     * 探索型（explore）不适用——它的交付本来就是结论，没有文件是正常的。
     */
    // 只认"核验通过"的证据（2026-11-16）：成员在 evidence 里写一个不存在的路径，以前也算
    // "有产物" → 派验收员跑 15 轮、100s，只为得出「docs/perf-audit-output-path.md 不存在」。
    const hasOutput = (task?.deliverables?.length ?? 0) + Math.max(0, verifiedEvidence) > 0;
    if (task?.mode !== "explore" && !hasOutput) {
      this.wakeLynnForReview(
        taskId,
        workerMember,
        `${workerReport}\n\n（系统注：这张单**没有任何交付物与证据**，属于没做出来，不要当验收通过；` +
          `要么换人/换法重做，要么关单并如实说明卡在哪。）`,
      );
      return;
    }
    const acceptance = task?.acceptance && task.acceptance.length ? task.acceptance : ["完成标准全部满足"];
    const brief =
      `你是本队的常驻验收员，现在验收 ${taskId}（执行成员：${workerMember}）。\n` +
      `执行成员的回报如下：\n"""\n${workerReport.slice(0, 2000)}\n"""\n` +
      `对照完成标准逐条核对：\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n` +
      `做法：用 list_dir 看工作区产物是否齐全，用 read_file 把关键交付物正文读一遍——` +
      `「文件存在 + 成员说齐全」不是验收，骨架稿 / 占位符 / 空章节只有读了正文才看得见。\n` +
      // 预算纪律（2026-11-16 实机）：验收员每轮读 5 个大文件，6 轮就超时 error，
      // 一张单挂了 4 分钟还没结论。核对是"找证据"，不是把相关源码全读一遍。
      `预算纪律：**每次最多读 2 个文件**，优先读交付物本身（不要通读源码库）；` +
      `对照每条标准找到能落地的证据就够了，凑齐判据就 submit_report，不要在验收阶段继续做勘察。\n` +
      `核实后用 submit_report 给结论，正文务必以【验收结论】开头：通过 / 打回 + 逐项核对结果 + 证据（哪个文件 / 哪一段）+ ` +
      `打回时写清改什么与期望什么。你只验收并汇报，不要替执行成员重做——风铃会按你的结论决定下一步。`;
    // 执行成员的 run 还没走完 .finally()（memberRuns 要等它清）——宏任务里再派，
    // 否则 dispatchMember 会撞上"已有成员在执行中"把验收误挡掉。
    setTimeout(() => {
      // 验收员在「同一张单」上跑验收：它不参与执行，只做验收；工具面收窄到只读 + 回报。
      const res = this.dispatchMember(teamId, taskId, acc.name, brief, "", [
        "read_file",
        "list_dir",
        "submit_report",
      ]);
      if (!res.ok) {
        this.wakeLynnForReview(taskId, workerMember, workerReport);
        return;
      }
      this.cardTo(this.currentThreadId, {
        kind: "tool",
        badge: "验收",
        title: `验收 · ${acc.name} · ${taskId}`,
        body: `验收员开始核对 ${workerMember} 的交付物，结论出来后会汇报给你。`,
        // 说清"哪件事在验收、谁验的"，不要只念一个成员名
        speak: `${acc.name}开始核对「${(task?.title ?? taskId).replace(/\s+/g, " ").slice(0, 20)}」，${workerMember}交的东西我让他逐条验。`,
      });
    }, 0);
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
      threadId: this.currentThreadId,
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
          evidencePolicy: p.evidencePolicy,
          ...(this.projectRoot ? { projectName: this.currentProject()?.name ?? defaultProjectName(this.projectRoot) } : {}),
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
    // 开工 = 这份只读授权生效（写仍限工作区，成员不能自我扩权）。
    // 自动/放手档：风铃已经判断过风险，她授予即生效；询问/计划档：这一步就是用户那次点头。
    if (p.readRoots?.length) {
      const prev = this.taskStore.get(p.taskId)?.readRoots ?? [];
      this.taskStore.setReadRoots(p.taskId, [...new Set([...prev, ...p.readRoots])]);
      const by = this.permission === "auto" || this.permission === "full" ? "风铃授予" : "用户批准";
      this.taskCase.append(p.taskId, {
        kind: "note",
        text: `${by}只读授权：${p.readRoots.join("、")}（写仍限工作区）`,
      });
    }
    const kickoff = this.dispatchMember(p.teamId, p.taskId, p.member, p.brief, p.deadline, p.tools, p.draftId, p.maxTurns);
    if (kickoff.ok) {
      try {
        this.taskStore.transition(p.taskId, "in_progress", { member: p.member, threadId: this.currentThreadId });
      } catch {
        /* 已是 in_progress */
      }
      /**
       * 契约阶段到此为止（2026-11-15）：用户点了「开始」= 判据/材料/工作区都定了。
       * 证据写的是可回查的事实（哪张契约、几条判据、授权目录），不是"确认过了"这句空话。
       */
      this.advanceStage(p.taskId, "contract", [
        `契约 ${p.taskId} · 判据 ${p.acceptance?.length ?? 1} 条`,
        `工作区 ${p.workspace ?? "（继承会话主根）"}`,
        ...(p.readRoots?.length ? [`只读授权 ${p.readRoots.join("、")}`] : []),
      ]);
    } else {
      // 停在 todo：没有假"进行中"；原因写进会话与卷宗，用户知道下一步该做什么
      this.taskCase.append(p.taskId, { kind: "note", text: `未开工：${kickoff.message}` });
      this.card({ kind: "system", text: `${p.taskId} 没开工（停在待办）：${kickoff.message}` });
    }
    this.setTurn({ phase: "working", taskId: p.taskId, busy: this.busy });
    return kickoff.message;
  }

  /**
   * 这个岗位过去踩过的坑（L2），按「同域 + 简报关键词」挑。
   *
   * 失败一律吞掉返回空：老档案没有 memberId、池子里没这个人、或文件坏了，
   * 都只是"这次没有经验可注入"，绝不能因此把单派不出去。
   */
  private memberLessonsFor(profile: MemberProfile, brief: string): Lesson[] {
    const memberId = profile.memberId;
    if (!memberId) return [];
    try {
      const domain = roleSpec(profile.roleId ?? "")?.domains[0] ?? "general";
      return this.memberPool.pickLessons(memberId, { domain, brief });
    } catch {
      return [];
    }
  }

  /**
   * 一单收尾后给池子记账（08 章 §3 硬规则 1：**任务结束提取教训只写 L2**）。
   *
   * 这里不碰 L1。L1 是进 system prompt 的岗位说明，只有 promoteLesson（人工确认）
   * 才能改——否则任务 A 的教训会跟着成员进任务 B，前缀哈希每次都变。
   */
  private noteMemberOutcomeToPool(profile: MemberProfile, taskId: string, result: MemberRunResult, maxTurns: number): void {
    const memberId = profile.memberId;
    if (!memberId) return;
    try {
      const domain = roleSpec(profile.roleId ?? "")?.domains[0] ?? "general";
      const ok = result.status === "reported";
      const reworkFocus = this.taskStore.get(taskId)?.reworkFocus?.items;
      const meta = this.memberPool.recordOutcome(memberId, {
        ok,
        turns: result.turns,
        tokens: result.promptTokens + result.completionTokens,
        rejectReason: ok ? undefined : (reworkFocus?.[0] ?? result.status),
      });
      for (const l of lessonsFromOutcome({
        memberId,
        taskId,
        domain,
        ok,
        exitStatus: result.status,
        turns: result.turns,
        maxTurns,
        reworkFocus,
      })) {
        this.memberPool.appendLesson(memberId, { ...l, evidenceTaskId: taskId });
      }
      if (meta.status === "probation") {
        this.log("member_probation", { memberId, member: profile.name, taskId, failures: meta.consecutiveFailures });
      }
    } catch {
      /* 记账失败不该影响这张单的收尾 */
    }
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
    /**
     * 额度熔断（2026-11-16）：实机 429 之后仍在继续派单，新单第一轮就撞 429，
     * 立刻 error 退出 → 风铃再派 → 雪球。熔断期内直接拒派，一次请求都不发。
     */
    if (this.quotaCoolingDown()) {
      const mins = Math.max(1, Math.round((this.quotaBlockedUntil - Date.now()) / 60_000));
      return {
        ok: false,
        message: `额度已用尽（429）：自动派单已暂停 ${mins} 分钟。不要重试派单，等用户充值后发消息或冷却结束再继续。`,
      };
    }
    const repickBlocked = this.taskRepickBlocked(taskId);
    if (repickBlocked) return { ok: false, message: repickBlocked };
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
    // 重派 = 新一轮：清掉"成员已自交回报"的标记，这一轮可以重新登记
    this.selfReported.delete(`${taskId}::${member}`);
    // 上一轮的疑问与唤醒计数也一并作废：旧问题的答复已经不适用新简报
    this.questionPending.delete(taskId);
    this.questionWakes.delete(taskId);
    this.questionMuted.delete(taskId);
    // 后台执行可能跨会话：出发时的线程记下来，回报要写回那一个，不能落到用户当前看的会话里
    const runThreadId = this.currentThreadId;
    // 同一个成员同时跟两张单 = 工具层互相堵死（真实事故：13:24 与 13:26 各派一张，然后两边都不动了）
    const memberKey = `${teamId}::${member}`;
    const busyTask = this.memberActive.get(memberKey);
    if (busyTask && busyTask !== taskId) {
      return { ok: false, message: `成员「${member}」正在跑 ${busyTask}，同一成员同时只能跟一张单。等它回报后再派，或换一个成员。` };
    }
    // 执行工具 = 本次分配 ∩ 内置执行工具；submit_report / post_message 是回报与发言通道，不占白名单
    const assigned = toolsArg ?? profile.tools;
    const allowed = assigned.filter((t) => (MEMBER_EXEC_TOOLS as readonly string[]).includes(t));
    // 名字写错/工具已下架时，以前是静默过滤 → 成员带着缺件的工具集开工，谁都不知道少了一件。
    // 不阻断派单（少一件往往还能干），但必须留痕，便于回查"为什么它没读到文件"。
    // 2026-11-16：通道类工具不再计为"被裁掉"——它们本来就不在白名单里，记进去只会让日志骗人
    // （实机 10 条 assign_tools_dropped 全是 submit_report，看着像"成员交不了活"）。
    const channelTools = new Set(["submit_report", "post_message"]);
    const droppedTools = assigned.filter(
      (t) => !(MEMBER_EXEC_TOOLS as readonly string[]).includes(t) && !channelTools.has(t),
    );
    if (droppedTools.length) this.log("assign_tools_dropped", { taskId, member, dropped: droppedTools.join(",") });
    // 一件可执行工具都没有的成员等于派出去空转：宁可当场拒，也别让它跑一轮再说"做不了"
    if (!allowed.length) {
      return {
        ok: false,
        message: `本次给 ${member} 的工具里没有一件可执行（${assigned.join("、") || "空"}）：改工具清单，或这张单不需要成员。`,
      };
    }
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

    // 跟踪输出跟着进度走：每次新进展追加到会话底部，不再汇总在顶部那张开工卡里。
    // 必须带 jobId 且写回出发会话：否则图纸「往来」里只有"派单·契约"一条，
    // 用户看到的就是"跑了二十分钟什么都没发生"（实报）。
    const controller = new AbortController();
    const steps: string[] = [];
    const startedAt = Date.now();
    const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
    this.appendProgress(runThreadId, taskId, member, "（等他第一步）", "刚开工");
    let lastStepAt = Date.now();
    const pushStep = (text: string) => {
      steps.push(text);
      lastStepAt = Date.now();
      this.memberLastStep.set(memberKey, text);
      this.memberStepAt.set(taskId, Date.now());
      // 每单一张进度卡（滚动 8 行）。里程碑卡已取消：它只是把同一批步骤再贴一遍，
      // 实机 148/200 条都是这类卡，结论被彻底埋掉。
      this.appendProgress(runThreadId, taskId, member, text, `第 ${steps.length} 步 · ${elapsedSec()}s`);
    };
    // 卡死可见：长时间没有任何动作就报一次（不自动杀，让人决定）
    // 但"正在跑的命令"不算没动作：tool-start 会刷新 lastStepAt，并在这里显示执行了多久。
    let stalledNotified = false;
    const stallTimer = setInterval(() => {
      const quiet = Date.now() - lastStepAt;
      // 工具真在执行就不算卡住（长构建/大文件/浏览器）；超过上限 toolBusy 会自己失效，恢复检查
      if (this.toolBusy(taskId)) return;
      // 有工具在跑：tool-start 已经在会话底部留了「正在执行」，定时器不再重复刷同一句
      if (quiet < MEMBER_STALL_MS) return;
      if (stalledNotified) return;
      stalledNotified = true;
      const body = `已经 ${Math.round(quiet / 1000)}s 没有任何动作。可以点台账/右键「停」，或再等等。\n\n最后动作：\n${steps.slice(-3).join("\n") || "（一步都没做）"}`;
      this.appendProgress(runThreadId, taskId, member, body, `第 ${steps.length} 步 · 可能卡住`);
      this.cardTo(runThreadId, { kind: "system", jobId: taskId, text: `${member} · ${taskId}：${body}` });
    }, 15_000);
    stallTimer.unref?.();

    // 禁区与取舍口径随单走（2026-11-12）：派单时定的法，成员第一眼就要看见
    const recNow = this.taskStore.get(taskId);
    /**
     * G2 编译闸（2026-11-17 P3-1b / 07 章 §4）：这个成员这次能不能拿到岗位专门纪律。
     * **失败不拒单**——成员明明能干，只是拿不到该岗位的模板，拒掉是最差的选择。
     * 但要记下来：悄悄 fallback 等于让风铃以为成员带着岗位纪律在干活。
     */
    const compileGate = gateMemberCompile(
      {
        roleId: profile.roleId,
        domain: roleSpec(profile.roleId ?? "")?.domains[0],
        body: profile.body,
        tools: allowed,
        limits: {
          maxTurns: maxTurns ?? profile.limits?.maxTurns,
          budgetTokens: profile.limits?.budgetTokens,
          wallClockMin: profile.limits?.wallClockMin,
        },
      },
      path.join(__dirname, "..", "prompts"),
    );
    this.log("member_compile", {
      taskId,
      member,
      roleId: compileGate.roleId,
      domain: compileGate.domain,
      templateSource: compileGate.templateSource,
      templatePath: compileGate.templatePath,
      promptFallback: compileGate.promptFallback,
      maxTurns: compileGate.limits.maxTurns,
      reasons: compileGate.reasons.join(" | "),
    });
    if (compileGate.promptFallback) {
      this.cardTo(runThreadId, {
        kind: "system",
        jobId: taskId,
        text: `${member}（${compileGate.roleId}）这次没有岗位模板，用的是通用纪律（promptFallback）。原因：${compileGate.reasons[0] ?? "未知"}。`,
      });
    }
    const run: Promise<MemberRunResult> = runMemberTask({
      profile,
      brief,
      deadline,
      tools: allowed,
      // G2 夹层后的轮次（07 章「限额合规」）：超出 8–40 的值在这里被夹住，而不是让成员带着离谱的轮次开跑
      maxTurns: compileGate.limits.maxTurns,
      // 墙钟预算进成员：轮次之外的另一道约束，用来在 50% / 75% 时提醒"先落盘"
      budgetMinutes: compileGate.limits.wallClockMin,
      forbidden: recNow?.forbidden,
      priority: recNow?.priority,
      mode: recNow?.mode,
      /**
       * L2 经验注入（2026-11-17 P3-2 / 08 章 §4）：按「同域 + 简报关键词」挑，最多 5 条 ≤600 字。
       * 异域任务**不注入**（08 章 §7）——把 coding 的坑塞给写文档的成员，是用一条错误经验污染它的判断。
       * 只进首条 user，绝不进 system（system 是每轮都付的固定成本）。
       */
      lessons: this.memberLessonsFor(profile, brief),
      // 打回后的重派：只重做这几条（2026-11-15），别把已通过的部分推翻
      focus: recNow?.reworkFocus?.items,
      signal: controller.signal,
      workdir,
      // 项目名：成员要知道自己在哪个项目里干活，回报里也要说得出来
      projectName:
        recNow?.projectName ??
        this.currentProject()?.name ??
        (this.projectRoot ? defaultProjectName(this.projectRoot) : undefined),
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
      // 删除类命令必须过闸：工具层已经先放过"本单开工后新造的文件"（自清理），到这里的是真有风险的删除。
      // 谁批由风铃的档位决定（见 awaitCommandApproval）：放手档她代批留痕，其余档问你。
      onBeforeCommand: (cmd) => this.awaitCommandApproval(member, taskId, cmd),
      runStartedAt: startedAt,
      /**
       * 成员**不继承放手级**（2026-11-15 拍板）：这一档意味着"删除免审批"，
       * 属于用户交给风铃的那一档，不能再往下传。成员的删除永远过闸，
       * 放手档下改由风铃代批（内核代她执行并写卷宗），不打扰你，也不再是静默放行。
       */
      autoDeleteInWorkspace: () => false,
      // 出站闸（审计 #2，2026-11-17 P5-1 改为**按单**放行）：
      // 默认不给网；这张单在派单时拿了 network 授权才允许 curl/wget/http。
      // 为什么不再看全局权限档：一张单要抓数据不代表下一张也要，按单授权才有分寸。
      outboundAllowed: () => this.taskStore.get(taskId)?.network?.granted === true,
      // 收件箱：风铃/巡检中途补的指示，成员每轮开头取（催办不杀进程、不重派）
      inbox: (() => {
        const box = this.memberInbox.get(taskId) ?? [];
        this.memberInbox.set(taskId, box);
        return box;
      })(),
      onAudit: (ev) => this.auditTool(teamId, taskId, member, ev, runThreadId),
      // 工具调用审计（tool 类，默认每分钟 120 条上限，字段自动截断）。
      // 实机「成员跑完未交付」只能看到没交回报，看不到它是否调过工具、调成什么样。
      onToolCall: (ev) =>
        this.log("member_tool", {
          taskId,
          member,
          tool: ev.name,
          ok: ev.ok,
          ms: ev.ms,
          args: ev.args,
          outcome: ev.outcome,
        }),
      onBeforeWrite: (rel, full, existed) => this.checkpoints.beforeWrite(rel, full, existed),
      // 写作规则（2026-11-15 重做）：成员写文档/回报之前就把规则给它，
      // 而不是等它写完再改稿（改稿会破坏校验、也会让落盘与交付物不一致）。
      // 2026-11-17：只给「交付物是文档」的角色——coding/ops 成员不背这 1,200 字（约 750 tokens/轮）。
      writingRules: writesProseDocs(profile.role, allowed) ? this.rulesSection("prose", 1200) : "",
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
      // 外部应用（能力中心 · 连接器）：成员只给 app id + 路径/命令，凭据与主机白名单都在这里
      apps: {
        request: (input) => this.connectorRequest(input),
        ssh: (input) => this.connectorSsh(input),
      },
      onEvent: (ev) => {
        // 工具开始就刷新心跳与卡面：一条递归命令跑 100s 时，此前界面与看门狗都当它死了
        if (ev.kind === "tool-start") {
          lastStepAt = Date.now();
          this.memberStepAt.set(taskId, Date.now());
          // 命令在跑的这段时间不算"没动作"：长构建/大文件/浏览器会跑几分钟，
          // 光靠 tool-start 刷一次时间戳不够，得让看门狗知道"它现在正在干活"。
          this.memberToolSince.set(taskId, Date.now());
          this.memberLastStep.set(memberKey, ev.text);
          // 只更新"执行中"的状态标记，不往正文里加行：开始/结束各一条曾让每个动作刷两行
          this.appendProgress(
            runThreadId,
            taskId,
            member,
            "",
            `第 ${steps.length + 1} 步 · 执行中 · ${elapsedSec()}s`,
            "进度",
            "meta",
          );
          return;
        }
        if (ev.kind === "tool") {
          this.memberToolSince.delete(taskId);
          pushStep(ev.text);
        }
        if (ev.kind === "turn") {
          this.memberToolSince.delete(taskId);
          const progress = ev.progress ?? 0;
          this.memberProgress.set(member, progress);
          // 只推回合状态（不刷卡片），编制表的进度条据此实时走
          this.setTurn({ phase: "working", taskId, member, progress });
        }
      },
      /**
       * 群内中途发言（2026-11-16）：成员自己开口说进展/结论/疑问/风险。
       * 落卡与"要不要叫醒风铃"的判定都在内核，成员侧只管说。
       */
      onMessage: (post) => this.memberSaid(runThreadId, teamId, taskId, member, post),
    });
    this.log("member_start", {
      taskId,
      member,
      teamId,
      turns: maxTurns ?? profile.limits?.maxTurns ?? 0,
      tools: allowed.join(","),
    });
    void run
      .then((result) => {
        this.memberProgress.set(member, 100);
        // 已经写出的文件（2026-11-16）：轮次用尽/中止也算产出，别让它们随失败一起消失
        const produced = (result.producedFiles ?? []).slice();
        if (produced.length) this.memberProduced.set(taskId, produced);
        // 预算读数：按真实 token 累计（此前编制表恒显示 0）
        this.memberUsage.set(memberKey, (this.memberUsage.get(memberKey) ?? 0) + result.promptTokens + result.completionTokens);
        // 看板：成员缓存命中率（2026-11-13）——cacheRead / 输入总量，多单累计
        this.memberCacheRead.set(memberKey, (this.memberCacheRead.get(memberKey) ?? 0) + result.cacheReadTokens);
        const used = Math.round((Date.now() - startedAt) / 1000);
        // 成员侧此前在日志里完全不可见（只有命令审计），排查"为什么没交回报"只能猜。
        // 一条收尾摘要即可定位：几轮跑完、交没交、交了几件产物。
        this.log("member_exit", {
          taskId,
          member,
          status: result.status,
          turns: result.turns,
          seconds: used,
          reportChars: result.report.length,
          evidence: result.evidence.length,
          deliverables: result.deliverables.length,
          // 缓存可观测（2026-11-13）：成员侧此前只有总量，命中率是黑盒。
          // hitRate = 命中 / 全部输入（promptTokens 已含命中部分，与 usage_round 同口径）。
          inTokens: result.promptTokens,
          outTokens: result.completionTokens,
          cacheRead: result.cacheReadTokens,
          cacheWrite: result.cacheWriteTokens,
          hitRate:
            result.promptTokens > 0
              ? Math.round((result.cacheReadTokens / result.promptTokens) * 1000) / 10
              : null,
          error: result.error,
        });
        /**
         * 池子记账（2026-11-17 P3-2）：战绩进 record.json，教训只进 L2。
         * 放在 member_exit 之后、任何"报成功"之前——记账失败不该改变这单的结论。
         */
        this.noteMemberOutcomeToPool(profile, taskId, result, maxTurns ?? profile.limits?.maxTurns ?? 0);
        // 失败计数（重派雪球熔断）+ 额度熔断：成员侧撞 429 时不再让风铃接着派
        this.noteTaskFailure(taskId, result.status);
        if (result.status === "error" && result.error && isQuotaMessage(result.error)) {
          this.noteQuotaExhausted(result.error);
        }
        // 成员侧用量落台账（2026-11-14）：以前只有 member_exit 日志，按次台账查不到成员跑单的命中率。
        // cacheFieldsReported 拿不到（成员 runner 未透传端点字段），明确记 null，不假装有。
        appendUsage(this.dataRoot, {
          at: new Date().toISOString(),
          kind: "member",
          in: result.promptTokens,
          out: result.completionTokens,
          model: this.activeModelId() ?? "member",
          cacheRead: result.cacheReadTokens,
          cacheWrite: result.cacheWriteTokens,
          source: "member",
          cacheFieldsReported: null,
        });
        // 只要成员交了回报就登记——**证据可选**（2026-11-11 起普通任务不再强制）。
        // 旧条件要求 evidence.length > 0：交了回报但没附证据的单被当成「没交出回报」，
        // 直接掉进 blocked → 巡检催重做 → 同一件事反复重派（2026-11-12 实机两轮空转）。
        if (result.status === "reported") {
          // 成员交的证据是相对**工作区**的（"report.md"），卷宗校验只认卷宗目录 / cwd / dataRoot；
          // 不先解析到工作区，真文件也会被判成"验不了"，工单停在执行中（C1 实机验暴露的真 bug）。
          const rootsForEvidence = this.effectiveReadRoots(taskId, teamId);
          const evidence = result.evidence.map((e) => this.resolveMemberPath(e, workdir, rootsForEvidence));
          // announce=false：下面那张带「轮次/耗时/产物可点」的回报卡才是要露给用户的，
          // 让 registerReport 再落一张就是同一份回报画两遍（2026-11-13 实机截图）。
          this.registerReport(teamId, taskId, member, result.report, evidence, undefined, runThreadId, result.evidence, workdir, true, false);
          // 顾问（2026-11-14）：独立模型审一遍"这份交付会不会返工"。旁路调用，不 await、不影响验收。
          void this.consultAdvisorFor(taskId, runThreadId, result.report, [...result.deliverables, ...result.evidence]);
          // 交付物与证据分开：交付物永久固化，过程证据只登记
          if (result.deliverables.length) {
            this.solidifyDeliverables(
              taskId,
              result.deliverables.map((e) => this.resolveMemberPath(e, workdir, rootsForEvidence)),
              workdir,
              runThreadId,
            );
          }
          // 产物在回报卡上也做成可点：用户不用等风铃汇总就能先看一眼
          const delivered = (this.taskStore.get(taskId)?.deliverables ?? []).map((d) => ({
            label: d.path.split(/[\\/]/).filter(Boolean).pop() ?? d.path,
            ref: d.ref,
            ...(d.bytes ? { bytes: d.bytes } : {}),
          }));
          /**
           * 播报要带"哪件事 + 交回了什么"（2026-11-16 用户：「播报还是只报成员名称」）。
           * 只念「阿计交回了结果」等于没说——耳朵里得听到任务名与结论要点。
           */
          const jobTitle = (recNow?.title ?? taskId).replace(/\s+/g, " ").slice(0, 24);
          const gist = String(result.report ?? "")
            .replace(/^\s*【[^】]*】\s*/u, "")
            .replace(/\s+/g, " ")
            .split(/[。！？\n]/)[0]
            .slice(0, 36);
          this.cardTo(runThreadId, {
            kind: "tool", badge: "回报", jobId: taskId,
            title: `${member} 回报 · ${taskId}`,
            meta: `${result.turns} 轮 · ${used}s`,
            body: result.report.slice(0, 1500),
            author: this.memberAuthor(teamId, member),
            /**
             * 验收对象必须说对（2026-11-16 用户：「成员回报指向非正确的验收对象」）：
             * 队里有常驻验收员时，先验的是他，不是风铃；验收员自己交回的是**结论**，
             * 不能说成"交回了结果"。
             */
            speak: (() => {
              if (this.isAcceptor(teamId, member)) {
                return `验收结论出来了「${jobTitle}」${gist ? `：${gist}` : ""}。`;
              }
              const receiver = this.teamHasAcceptor(teamId) ? "等验收员逐条核对" : "等我验收";
              return (
                `${member}交回「${jobTitle}」${gist ? `：${gist}` : "的结果"}` +
                (delivered.length ? `，附 ${delivered.length} 个产物` : "") +
                `，${receiver}。`
              );
            })(),
            ...(delivered.length ? { artifacts: delivered } : {}),
          });
          return;
        }
        if (result.status === "aborted") {
          this.cardTo(runThreadId, {
            kind: "tool", badge: "已停止", jobId: taskId,
            title: `${member} 已停止 · ${taskId}`,
            meta: `${used}s${produced.length ? ` · 已写 ${produced.length} 个文件` : ""}`,
            body:
              "用户中止。已写出的文件留在工作区。" +
              (produced.length ? `\n\n已写出：${produced.join("、")}` : "\n\n（这一轮还没写出任何文件）"),
            speak:
              `${member}这一轮停下了` +
              (produced.length ? `，已写出的 ${produced.length} 个文件都在工作区。` : "，还没写出文件。"),
          });
          return;
        }
        /**
         * 没回报：不能只说「没交出回报」（2026-11-16 实机「无回报这类模糊反馈」）。
         * 用户要能判断"它到底干到哪了、为什么停、我该做什么"：
         * 成因（轮次用尽 / 跑完没交 / 模型出错）+ 做了几步 + 最后动作 + 下一步选项，全摆出来。
         */
        const why =
          result.status === "turn_limit"
            ? `轮次用尽（${result.turns}/${maxTurns} 轮）——不是做不了，是给的时间不够`
            : result.status === "error"
              ? `执行出错：${result.error ?? "模型调用失败"}`
              : "跑完了但没有调用回报通道（可能它以为说一句就算交差）";
        const nextHint =
          result.status === "turn_limit"
            ? "可以给这名成员补一句指示让它接着做（nudge），或提高轮次上限重派剩余部分"
            : "可以先 nudge 让它补交结论；实在交不出来就在原单上重派";
        this.cardTo(runThreadId, {
          kind: "tool", badge: "未完成", jobId: taskId,
          title: `${member} 没交出回报 · ${taskId}`,
          meta: `${result.turns} 轮 · ${used}s · 做了 ${steps.length} 步`,
          body:
            `**为什么没有回报**：${why}\n` +
            `${result.report ? `\n**它自己的说法**：${result.report}\n` : ""}` +
            (produced.length
              ? `\n**已经写出的文件（${produced.length} 个，都在工作区）**：\n${produced.map((f) => `- ${f}`).join("\n")}\n`
              : "\n**已经写出的文件**：一个都没有——下一轮必须先落盘，别再从头读一遍。\n") +
            `\n**最后 ${Math.min(steps.length, 3)} 步**：\n${steps.slice(-3).join("\n") || "（一步都没做）"}\n` +
            `\n**下一步**：${nextHint}。已写出的文件留在工作区，不会丢。`,
          // 播报说清"哪件事、为什么没交、写出了什么"，不是只念名字
          speak:
            `${member}没交出「${(recNow?.title ?? taskId).replace(/\s+/g, " ").slice(0, 20)}」：` +
            (result.status === "turn_limit" ? "轮次用尽还没收尾" : result.status === "error" ? "执行出错了" : "跑完没交回报") +
            (produced.length ? `，已写出 ${produced.length} 个文件` : "，一个文件都没写出") +
            "。",
        });
        try {
          this.taskStore.transition(taskId, "blocked", {
            blockedReason: "no_report",
            note:
              result.status === "turn_limit"
                ? `轮次用尽（${result.turns} 轮）仍未交出回报`
                : "成员跑完但没有交出带证据的回报",
          });
        } catch {
          /* 状态已经不在可迁移范围内就不强改 */
        }
        this.escalateBlockedToLynn(
          taskId,
          result.status === "turn_limit" ? `轮次用尽（${result.turns} 轮）未交回报` : "成员跑完但没交出带证据的回报",
          runThreadId,
        );
        /**
         * 验收员自己没验完（2026-11-16 实机：验收员跑到第 6 轮 error，那张单就一直挂在待审，
         * 用户看到的是"回报指向了不该指向的人、还迟迟没人验"）。这里明确交回风铃。
         */
        if (this.isAcceptor(teamId, member)) {
          this.cardTo(runThreadId, {
            kind: "system",
            badge: "进度",
            jobId: taskId,
            text:
              `验收员没验完（${result.status === "turn_limit" ? "轮次用尽" : "执行出错"}）：${taskId} 仍停在「待审查」，` +
              "需要风铃自己验或换人验——这张单不会自己往前走。",
            speak: `验收没做完，「${String(recNow?.title ?? taskId).replace(/\s+/g, " ").slice(0, 20)}」还等你处理。`,
          });
        }
      })
      .catch((err: unknown) => {
        this.cardTo(runThreadId, {
          kind: "tool", badge: "崩溃", jobId: taskId,
          title: `${member} 执行崩溃 · ${taskId}`,
          meta: `${steps.length} 步`,
          body: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        clearInterval(stallTimer);
        this.memberRuns.delete(taskId);
        // 成员结束/崩溃：立即评估一次心跳（不用等 5 分钟定时器）；是否叫醒模型由闸决定
        this.requestHeartbeat("member_exit");
        this.memberAborts.delete(taskId);
        this.memberInbox.delete(taskId);
        this.memberStepAt.delete(taskId);
        this.memberBlocked.delete(taskId);
        this.memberBlockedCmds.delete(taskId);
        this.memberToolSince.delete(taskId);
        // 交接给下一轮：它最后几步做了什么（重派时塞进简报，别让它从零再查一遍）
        if (steps.length) this.memberTrail.set(taskId, steps.slice(-6));
        if (this.memberActive.get(memberKey) === taskId) this.memberActive.delete(memberKey);
      });
    this.memberRuns.set(taskId, run);
    this.memberAborts.set(taskId, controller);
    this.memberActive.set(memberKey, taskId);
    // 自动开工不再单独发系统卡：工作区、工具、只读授权全部并进这一张派单卡（实机刷两张是冗余）。
    const readRoots = this.effectiveReadRoots(taskId, teamId);
    // 群里"谁对谁做了什么"必须看得见：派单一律点名 @成员（工具层强制，模型忘了也补上）
    /**
     * 开工卡必须一次把「授权与要求」写全（2026-11-16 实机「启动阶段没交代权限，后面返工」）：
     * 写哪里、只能读哪里、用哪些工具、多少轮、产物放哪、什么情况必须停手回报——
     * 这些话既给成员看（契约），也给用户看（他一眼知道这次授权了什么）。
     */
    const turnCap = Math.max(1, Math.min(maxTurns ?? profile.limits?.maxTurns ?? 12, 40));
    const at = this.atMember(
      member,
      [
        `能不能写：只能写工作区 ${workdir}（可读可写；删除类命令要你点头；.git/ 与 .lynn/ 不可写）`,
        `能不能读：${readRoots.length ? readRoots.join("、") : "只有工作区（没有额外只读授权）"}`,
        `用什么做：${allowed.join("、") || "（本次未分配执行工具）"}；最多 ${turnCap} 轮`,
        `产物落哪：${recForWork?.workspace?.scratchDir ? `交付物写工作区 deliverables/，过程文件写 ${scratchDir}` : "交付物写工作区 deliverables/"}；回报后自动进审查台`,
        "缺材料/缺权限：第一轮就停手回报【缺上下文】，写明「需要授权：<绝对路径>」——不要换路径硬试。",
      ].join("\n"),
    );
    // 语音只需要一句人话："谁 + 做什么"。卡片标题留给眼睛（工单号 + 工具清单），
    // 按字段推导只会念成「阿计 开工 · task-mf3k9x2a-1」——那是噪音，不是进度。
    const what = String(recForWork?.title ?? "").trim();
    this.emit({
      type: "tool",
      badge: "派单",
      title: `${member} 开工 · ${taskId}`,
      meta: `工具：${allowed.join("、") || "无"}`,
      body: at.body,
      /**
       * 派单播报（2026-11-16 用户：「分配任务后错误地播报成员姓名」）：
       * 先说**做什么**，名字放后面；重派说"接着做"，不要听起来像又开了一件新事。
       */
      speak: (() => {
        const rework = this.memberTrail.has(taskId) || (recForWork?.rejectRounds ?? 0) > 0;
        if (!what) return `有活开工了，交给${member}做。`;
        return rework ? `「${what}」接着做，还是${member}。` : `「${what}」开工了，交给${member}。`;
      })(),
      author: { kind: "lynn", name: "风铃" },
      mentions: at.mentions,
    });
    // 注意：这条 message 会被 startAssignment 直接落成"计划已确认。<message>" 的系统卡，
    // 是给用户看的，别往这里塞给模型的指令（公告提醒走 turnFacts，那才是模型的上下文）。
    return { ok: true, message: "成员已开工（后台执行），回报后会自动进待审查。" };
  }

  /**
   * 停掉一张正在跑的成员单（§4.10.4 缺的那一半）。
   * 之前想止损只有"解散整队"一条路，会连带停掉同队其他成员。
   *
   * 幂等：已经停过/已经结束的单再来一次不算失败——那正是用户想要的结果。
   * 之前第二次点「停掉这张单」会回"停不下来：没有在跑的 …"（实机报障），
   * 因为它把"已经没有在跑"当成了错误，而界面上的卡在成功停机后并没有换掉按钮。
   */
  cancelMemberTask(taskId: string, opts: { quiet?: boolean } = {}): { ok: boolean; error?: string } {
    const controller = this.memberAborts.get(taskId);
    // 已经在停（信号已发、成员还没交出收手回执）：幂等返回，不重复收口也不重复计数
    if (controller?.signal.aborted) return { ok: true };
    const rec0 = this.taskStore.get(taskId);
    if (!controller) {
      if (!rec0) return { ok: false, error: `没有这张单：${taskId}` };
      // 已经停在终态/卡住：静默成功（界面 refresh 后按钮会跟着状态变）
      if (rec0.status === "blocked" || rec0.status === "canceled" || rec0.status === "done") return { ok: true };
      // 台账还挂着 in_progress 却没人在跑（进程异常退出、对账前）：顺手收口，不留"假进行中"
      let fixed = false;
      try {
        this.taskStore.transition(taskId, "blocked", {
          member: rec0.member,
          blockedReason: "crash",
          note: "成员已不在运行（用户点停收口）",
        });
        this.taskCase.append(taskId, { kind: "transition", text: "→ blocked（成员已不在运行）" });
        fixed = true;
      } catch {
        /* 迁移不允许就保持原样 */
      }
      const note = fixed
        ? `${taskId} 本来就没人在跑，已把状态收口为「卡住」。`
        : `${taskId} 现在没有成员在跑（可能已经结束），不需要再停。`;
      // quiet：整群终止时逐张报一遍就是刷屏，由调用方出一条汇总卡
      if (!opts.quiet) {
        if (rec0.threadId) this.cardTo(rec0.threadId, { kind: "system", jobId: taskId, text: note });
        else this.card({ kind: "system", text: note });
      }
      return { ok: true };
    }
    controller.abort();
    // 停了就必须有可见变化：原来只 abort，工单永远停在 in_progress，台账上看着"还在跑"
    let moved = false;
    try {
      const rec = this.taskStore.get(taskId);
      if (rec && rec.status === "in_progress") {
        this.taskStore.transition(taskId, "blocked", {
          member: rec.member,
          blockedReason: "user_stop",
          note: "用户手动停机",
        });
        this.taskCase.append(taskId, { kind: "transition", text: "→ blocked（用户手动停机）" });
        moved = true;
      }
    } catch {
      /* 状态已不在可迁移范围就不强改 */
    }
    const text = moved
      ? `已停 ${taskId}：成员收手，工单转入「卡住」。风铃会自己判断重做 / 换策略 / 关单，不用你来点取消。`
      : `已停 ${taskId}：成员在本轮模型调用结束后收手，已写出的文件留在工作区。`;
    if (moved) this.escalateBlockedToLynn(taskId, "成员已停机");
    // C2 原则：工单相关卡片归出发会话——在别的会话点「停」不该把过程噪音写进当前会话
    if (!opts.quiet) {
      const owner = this.taskStore.get(taskId)?.threadId;
      if (owner) this.cardTo(owner, { kind: "system", text });
      else this.card({ kind: "system", text });
    }
    return { ok: true };
  }

  /**
   * 语音合成失败/被限流（2026-11-16 壳层回调）：只写日志，不落卡、不弹窗。
   * Edge Read Aloud 是非官方接口，403/429 是常态；排查时这条是唯一线索。
   */
  noteVoiceFailure(message: string, reason: string): void {
    this.log("voice_failed", { message: String(message ?? "").slice(0, 200), reason });
  }

  /** 这个群现在是不是被终止了（内存副本，O(1)） */
  isThreadHalted(id = this.currentThreadId): boolean {
    return Boolean(id) && this.haltedThreads.has(id);
  }

  /**
   * 用户点「终止任务」（2026-11-15）：本群所有进行中的工作全部停手。
   *
   * 停到哪一层：
   *  1) 本群在跑的成员单逐张 abort（别的群的单不碰）；
   *  2) 当前回合就地中断 + 清空排队输入；
   *  3) 待验收叫醒队列里本群的条目丢掉；
   *  4) 之后心跳 / 指挥者巡检 / 秒级探针 / 定时任务注入 / 卡住升级全部对本群静默；
   *  5) 状态落盘（haltedAt），重启也仍然停手。
   * 恢复条件只有一个：用户在这个群发出新消息（feed.send 里 resumeThread）。
   */
  haltThread(id?: string): { ok: boolean; stopped: number; threadId: string; error?: string } {
    const tid = String(id ?? this.currentThreadId ?? "").trim();
    if (!tid) return { ok: false, stopped: 0, threadId: "", error: "没有可终止的群" };
    this.haltedThreads.add(tid);
    try {
      this.threads.setHalted(tid, true);
    } catch {
      /* 群已被删：内存标记照生效，别再抛 */
    }
    // 1) 本群在跑的成员单
    const stoppedIds: string[] = [];
    for (const taskId of [...this.memberRuns.keys()]) {
      const rec = this.taskStore.get(taskId);
      if (rec?.threadId !== tid) continue;
      // 已经在停 / 已经收口的不重复计数（连点两次「终止任务」不该报停了两张）
      if (rec.status !== "in_progress") continue;
      if (this.memberAborts.get(taskId)?.signal.aborted) continue;
      if (this.cancelMemberTask(taskId, { quiet: true }).ok) stoppedIds.push(taskId);
    }
    // 2) 待验收的回报：本群的丢掉（恢复后靠台账与卷宗继续，不靠这半条队列）
    this.reviewPending = this.reviewPending.filter((p) => this.taskStore.get(p.taskId)?.threadId !== tid);
    // 成员的问题同理：群已终止，答了也没人接；唤醒计数一起清，恢复后能重新答
    for (const [qTaskId, q] of [...this.questionPending]) {
      if (q.threadId !== tid) continue;
      this.questionPending.delete(qTaskId);
      this.questionWakes.delete(qTaskId);
      this.questionMuted.delete(qTaskId);
    }
    /**
     * 3) 挂着等用户拍板的东西一起作废（2026-11-15）。
     * 终止之后没人会来点，留着就是一张骗人的「等你拍板」——实机截图里那枚验收印章
     * 就是在按了「终止任务」之后还赖在右栏不走的。审批按拒绝收口（成员已停机，
     * 再等 5 分钟超时没有意义），契约与提问一并撤掉；这些记录都能从台账与卷宗重建。
     */
    for (const d of this.decisions.filter((x) => x.threadId === tid && x.kind === "approval")) {
      const pa = this.pendingApprovals.get(d.id);
      this.pendingApprovals.delete(d.id);
      pa?.resolve(false);
    }
    // 审批卡绑的是"正在等你的那个成员动作"，成员已经停机 → 卡必须撤（留着点了也没人接）。
    // 契约与提问不撤：它们是"接下来要做什么"，恢复后原样回来。
    this.decisions = this.decisions.filter((d) => !(d.threadId === tid && d.kind === "approval"));
    this.persistPending();
    // 4) 当前回合属于这个群：就地中断
    if (tid === this.currentThreadId) {
      this.abortRequested = true;
      this.queue = [];
      this.voice?.stop();
      this.setTurn({ pending: 0 });
      this.chatAbort?.abort();
      if (this.host?.isRunning()) void this.host!.abort().catch(() => undefined);
      if (this.liveCard) {
        this.liveCard.streaming = false;
        this.patchCard(this.liveCard, { streaming: false });
        this.liveCard = null;
      }
    }
    // 5) 一条汇总卡说清"停的是什么、怎么恢复"，不给每张单都留一张
    const head = stoppedIds.length
      ? `已终止本群：${stoppedIds.length} 张在跑的单已停机（${stoppedIds.join("、")}）`
      : "已终止本群：没有成员在跑";
    this.cardTo(tid, {
      kind: "system",
      systemTone: "notice",
      text:
        `${head}。心跳巡检、自动跟进、验收叫醒与排队输入全部暂停——` +
        `在这个群发一条消息即可恢复。`,
    });
    this.log("thread_halt", { threadId: tid, stopped: stoppedIds.length });
    return { ok: true, stopped: stoppedIds.length, threadId: tid };
  }

  /** 用户在这个群发出新消息 = 恢复：只清状态，不主动叫醒（这一轮本身就是新需求） */
  private resumeThread(id: string): void {
    if (!id || !this.haltedThreads.delete(id)) return;
    try {
      this.threads.setHalted(id, false);
    } catch {
      /* 群不在了也无所谓 */
    }
    this.log("thread_resume", { threadId: id });
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
   * 删除类命令的审批闸。**谁批取决于用户的档位**（2026-11-15 起）：
   *
   *  - auto / full：风铃代批，写卷宗留痕，不打扰用户——"用户只出需求"之后，
   *    逐次点删除显然违背它；而真正拦住风险的是工具层的路径守卫与自清理分级。
   *  - ask：唯一的"逐步确认"档，仍然挂卡问用户（用户自己选的细粒度控制）。
   *  - plan：只读，删除到不了这里。
   *
   * 走到这里的都是工作区里的既有文件/目录（本单自己造的临时文件工具层已自动放行）。
   * 审批结果一律写进工单卷宗：风铃下一轮 check_progress 能看到批/拒了哪条、谁批的。
   */
  private awaitCommandApproval(member: string, taskId: string, command: string): Promise<{ ok: boolean; reason?: string }> {
    /**
     * 自动 / 放手档：这一刀由风铃判断（用户只管档位），不打扰用户。
     * 成员不继承放手级——她代批的每一笔都写进卷宗，能在任务详情里回溯；
     * 需要逐步确认的话，把档位切到「询问」即可（那一档仍逐次问用户）。
     */
    if (this.permission === "auto" || this.permission === "full") {
      this.taskCase.append(taskId, {
        kind: "note",
        text: `${this.permission === "full" ? "放手档" : "自动档"}：风铃代批删除（成员不继承放手级）：${command.slice(0, 200)}`,
      });
      this.log("command_owner_auto", { taskId, member, mode: this.permission });
      return Promise.resolve({ ok: true });
    }
    // 「这类以后都允许」（2026-11-14）：用户在审批卡上放行过的族不再逐次弹卡。
    // 放宽的只是"打扰"：命令照样过 destructiveReason / 自清理分级 / 路径守卫。
    const family = destructiveFamily(command);
    if (family && (this.settings.getPrefs().allowCommandFamilies ?? []).includes(family)) {
      this.taskCase.append(taskId, {
        kind: "note",
        text: `删除族「${family}」已获长期放行（设置里），自动批准：${command.slice(0, 200)}`,
      });
      this.log("command_family_auto", { family, taskId });
      return Promise.resolve({ ok: true });
    }
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const owner = this.taskStore.get(taskId)?.threadId ?? this.currentThreadId;
    const root = this.taskStore.get(taskId)?.workspaceRoot ? `工作区：${this.taskStore.get(taskId)?.workspaceRoot}` : "";
    return new Promise((resolve) => {
      // 等人点头期间成员是"合法静默"：不刷心跳的话 2 分钟后巡检会把它当卡死，风铃可能直接停掉它
      const heartbeat = setInterval(() => this.memberStepAt.set(taskId, Date.now()), 30_000);
      heartbeat.unref?.();
      const timer = setTimeout(() => {
        clearInterval(heartbeat);
        this.pendingApprovals.delete(id);
        this.decisions = this.decisions.filter((d) => d.id !== id);
        this.taskCase.append(taskId, { kind: "note", text: `删除审批超时自动拒绝：${command.slice(0, 200)}` });
        resolve({ ok: false, reason: "等了 5 分钟没人点头，按拒绝处理" });
      }, 300_000);
      timer.unref?.();
      this.pendingApprovals.set(id, {
        kind: "delete",
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          this.pendingApprovals.delete(id);
          this.decisions = this.decisions.filter((d) => d.id !== id);
          this.taskCase.append(taskId, {
            kind: "note",
            text: ok ? `用户批准删除：${command.slice(0, 200)}` : `用户拒绝删除：${command.slice(0, 200)}`,
          });
          resolve(ok ? { ok: true } : { ok: false, reason: "用户拒绝了这次删除" });
        },
      });
      this.decisions.push({
        id,
        from: member,
        title: `${member} 要删除文件（${taskId}）`,
        detail: `命令：${command}\n${root}\n删除不可撤销；本单新造的临时文件已由系统自动放行，走到这里的都算既有文件。`,
        kind: "approval",
        jobId: taskId,
        // 后台成员可能在别群跑：审批归工单的群，不归用户当下正看的群
        threadId: owner,
        ...(family ? { family } : {}),
        at: new Date().toISOString(),
      });
      this.cardTo(owner, {
        kind: "system",
        jobId: taskId,
        text: `${member} 申请执行删除类命令，等你点头（5 分钟内不答复按拒绝）：\n${command}`,
      });
    });
  }

  /** 并行上限（settings.prefs.maxParallelMembers，1–8；非法值回退默认 4） */
  private maxParallelMembers(): number {
    const raw = Number(this.settings.getPrefs().maxParallelMembers);
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PARALLEL_MEMBERS;
    return Math.min(Math.floor(raw), 8);
  }

  /**
   * 风铃单轮工具轮次上限（settings.prefs.maxAgentRounds，4–80；非法值回退默认 24）。
   * 旧值写死 8，审查→派单→激活技能→验收→汇报一条龙轻松超 8 轮，会把她中途掐断；
   * 给足后极少触顶，且触顶只总结不硬停（见 runChatDirect：跑满后补一次「只总结」，工具面不变）。
   */
  private agentRounds(): number {
    const raw = Number(this.settings.getPrefs().maxAgentRounds);
    if (!Number.isFinite(raw) || raw < 4) return 24;
    return Math.min(Math.floor(raw), 80);
  }

  /**
   * 巡检轮（心跳/验收叫醒）的工具轮次上限（2026-11-16 实测）。
   * 43 个巡检回合跑了 491 次模型调用（11.4 次/回合）——"看一眼就走"实际上是一条工具链，
   * 而每次调用都要重放本回合前面所有工具输出。10 轮足够清 3–5 张单；
   * 触顶走「补一次只总结」（工具面不变，避免换掉工具段白付一次前缀），剩下的下一轮心跳继续。
   * 实机调参用 LYNN_PATROL_ROUNDS（4–24）。
   */
  private patrolRounds(): number {
    const raw = Number(process.env.LYNN_PATROL_ROUNDS);
    const cap = Number.isFinite(raw) && raw >= 4 ? Math.min(Math.floor(raw), 24) : 10;
    return Math.min(cap, this.agentRounds());
  }

  /**
   * 工单卡住 → 交回风铃自己处置，不把「要不要取消」推给用户。
   * 每单只注入一次（重做时清掉），正在生成时不叠加新回合。
   */
  private escalateBlockedToLynn(taskId: string, reason: string, owner?: string): void {
    if (this.blockedHandled.has(taskId)) return;
    this.blockedHandled.add(taskId);
    // 本群已终止：卡住也不许把她叫回来（2026-11-15）
    const ownerThread = owner ?? this.taskStore.get(taskId)?.threadId ?? this.currentThreadId;
    if (this.isThreadHalted(ownerThread)) return;
    const note = `${taskId} 卡住了（${reason}）。风铃会自己判断：重做 / 换策略 / 关单 / 汇报，不需要你来点取消。`;
    const card = { kind: "system" as const, badge: "进度" as const, jobId: taskId, text: note };
    if (owner) this.cardTo(owner, card);
    else this.card(card);
    if (this.busy) return;
    this.submitTurn(
      `【卡住处置】${taskId} 现在没有成员在跑（${reason}）。判断与处置由你做主，不要问用户要不要取消：` +
        `目标仍成立 → assign_task 带 reworkTaskId=${taskId} 在原单上重做（状态与卷宗都留在这张单里，不要新建工单）；` +
        `方向已错或做不了 → stop_task 带 dismiss=true 关单，再用 report_to_user 如实汇报；` +
        `已有回报 → review_result / accept_or_reject 验收。`,
      undefined,
      { internal: true, ephemeral: true },
    );
  }

  /**
   * 这个目录里有什么是"被信任才生效"的（2026-11-13）。
   *
   * 信任闸门只管两样：项目级 MCP 配置（.lynn/mcp.json）与项目级技能（.lynn/skills/）。
   * 两样都没有 → 信任与否毫无区别 → 不该报"不会加载"（此前对空目录也照报，纯属吓人）。
   */
  private gatedByTrust(root: string): { mcp: boolean; skills: boolean } {
    if (!root) return { mcp: false, skills: false };
    const mcp = fs.existsSync(path.join(root, ".lynn", "mcp.json"));
    const skillsDir = path.join(root, ".lynn", "skills");
    let skills = false;
    try {
      skills =
        fs.existsSync(skillsDir) &&
        fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .some((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")));
    } catch {
      skills = false;
    }
    return { mcp, skills };
  }

  /** 取消一张单（→ canceled，进归档带）：在跑的会先停下成员；by 区分是风铃判定还是用户手动 */
  dismissTask(taskId: string, by: "user" | "lynn" = "user"): { ok: boolean; error?: string } {
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
    this.taskCase.append(taskId, {
      kind: "note",
      text: by === "lynn" ? "风铃判定不再继续，取消这张单" : "用户取消这张单",
    });
    const text = by === "lynn"
      ? `风铃判定 ${taskId} 不再继续，已取消归档（目录与卷宗保留，可搜可查）。`
      : `已取消 ${taskId}：从台账移到归档带（目录与卷宗保留，可搜可查）。`;
    if (rec.threadId) this.cardTo(rec.threadId, { kind: "system", text });
    else this.card({ kind: "system", text });
    if (this.decisions.some((d) => d.jobId === taskId)) {
      this.decisions = this.decisions.filter((d) => d.jobId !== taskId);
      for (const [id, p] of this.pendingPlans) if (p.taskId === taskId) this.pendingPlans.delete(id);
      this.persistPending();
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
      for (const [id, p] of this.pendingPlans) if (p.taskId === rec.id) this.pendingPlans.delete(id);
      this.persistPending();
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
    /**
     * 群没了，挂在它名下的裁决一起撤（2026-11-15）：
     * 没有群可跳、或指向的工单已经被删的「等你拍板」就是一条死链——
     * 点了没反应，还占着右栏最显眼的位置。顺手把死链一起清掉。
     */
    const before = this.decisions.length;
    this.decisions = this.decisions.filter(
      (d) => d.threadId !== threadId && (!d.jobId || this.taskStore.get(d.jobId)),
    );
    for (const [id, p] of [...this.pendingPlans]) {
      if (p.threadId === threadId || !this.taskStore.get(p.taskId)) this.pendingPlans.delete(id);
    }
    if (this.decisions.length !== before) {
      this.persistPending();
      this.setTurn({});
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
    this.queueRemovalCard({
      taskId,
      kept,
      shared: kept.length > 0 && isInside(this.dataRoot, kept[0]),
      threadId: rec.threadId,
    });
    return { ok: true, removed, kept };
  }

  /**
   * 删除消息合并（2026-11-12）：批量删归档单时，5 条「已删除」刷满一屏，
   * 而且每条都在重复「工单、卷宗与临时文件已移除」。400ms 内连续删除合成一条汇总卡。
   */
  private queueRemovalCard(item: { taskId: string; kept: string[]; shared: boolean; threadId?: string }): void {
    this.pendingRemovals.push(item);
    if (this.removalTimer) return;
    this.removalTimer = setTimeout(() => this.flushRemovalCards(), 400);
    this.removalTimer.unref?.();
  }

  private flushRemovalCards(): void {
    const batch = this.pendingRemovals;
    this.pendingRemovals = [];
    if (this.removalTimer) {
      clearTimeout(this.removalTimer);
      this.removalTimer = null;
    }
    if (!batch.length) return;
    const ids = batch.map((b) => b.taskId);
    const kept = [...new Set(batch.flatMap((b) => b.kept))];
    const tail = kept.length
      ? `；${batch.every((b) => b.shared) ? "共享工作区" : "用户项目目录"} ${kept.join("、")} 未改动`
      : "；工作区一并移除，不可恢复";
    const text =
      batch.length === 1
        ? `已删除 ${ids[0]}（工单/卷宗/临时文件已清${tail}）`
        : `已删除 ${batch.length} 张单：${ids.join("、")}（工单/卷宗/临时文件已清${tail}）`;
    const card = { kind: "system" as const, title: "清理", systemTone: "cleanup" as const, text };
    const threadId = batch[0].threadId;
    if (threadId) this.cardTo(threadId, card);
    else this.card(card);
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
  nudgeMember(taskId: string, note: string, byUser = false, mode: "nudge" | "reply" = "nudge"): string {
    const text = note.trim();
    if (!text) return "补充指示不能为空：要它改什么、先交什么，写清楚。";
    if (!this.memberRuns.has(taskId)) {
      return `${taskId} 没有在跑（可能已结束/已停）：要改要求就用 assign_task 带 reworkTaskId=${taskId} 在原单上重做，不要新开单；或 check_progress 看它交了什么。`;
    }
    const box = this.memberInbox.get(taskId) ?? [];
    box.push(text);
    this.memberInbox.set(taskId, box);
    const rec = this.taskStore.get(taskId);
    const owner = rec?.threadId ?? this.currentThreadId;
    // 催促是风铃对某个成员说的话：走"她的话"而不是系统提示，并点名 @他
    const at = this.atMember(
      rec?.member ?? "",
      byUser
        ? `用户催了：${text.slice(0, 200)}（已转达，下一轮生效）`
        : mode === "reply"
          ? // 回答成员的提问 / 纠正他的做法：群里的措辞要让人看得出这是"回答"，不是催办
            `答你刚才那句（下一轮生效）：${text.slice(0, 200)}`
          : `补了一句（下一轮生效）：${text.slice(0, 200)}`,
    );
    this.cardTo(owner, {
      kind: "lynn",
      jobId: taskId,
      text: at.body,
      author: { kind: "lynn", name: "风铃" },
      mentions: at.mentions,
    });
    return `已送达 ${taskId}：成员下一轮会看到，不用重派。`;
  }

  /**
   * 指挥者巡检（每分钟 tick，但真正触发受 5 分钟全局 / 10 分钟每单节流）：
   * 成员长时间没动作、或反复撞边界时，风铃自己起一轮跟进——她不再"派完就睡"。
   */
  private supervisorTick(): void {
    if (!this.settings.getPrefs().supervisor) return;
    // 本群被用户终止：自动跟进也停手（2026-11-15）
    if (this.isThreadHalted()) return;
    if (this.busy || this.memberRuns.size === 0) return;
    const now = Date.now();
    if (now - this.lastSupervisorAt < 5 * 60_000) return;
    const runs = [...this.memberRuns.keys()].map((id) => {
      const rec = this.taskStore.get(id);
      const key = `${rec?.teamId ?? ""}::${rec?.member ?? ""}`;
      return {
        taskId: id,
        member: rec?.member ?? "成员",
        // 工具正在跑（且没超上限）就不算静默：否则一次 3 分钟的构建就被判"卡住"
        quietMs: this.toolBusy(id, now) ? 0 : now - (this.memberStepAt.get(id) ?? now),
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
      { internal: true, ephemeral: true },
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

  /** 真正注入模型的巡检轮次（被闸拦下的不算；测试与诊断用） */
  private heartbeatRuns = 0;

  /** 已注入的巡检轮次数：巡检轮是 ephemeral，不进 history，测试不能用 history 数 */
  heartbeatRunCount(): number {
    return this.heartbeatRuns;
  }

  private heartbeatTick(trigger: "timer" | "event" = "timer"): void {
    const prefs = this.settings.getPrefs();
    if (!prefs.heartbeat) return;
    // 本群被用户终止：心跳是"她主动找事做"，必须先停（2026-11-15）
    if (this.isThreadHalted()) return;
    // 额度熔断：心跳是这里最大的空转源（实机 429 后仍每 5 分钟叫醒一次，一路空转 100 分钟）
    if (this.quotaCoolingDown()) return;
    if (this.busy) return;
    const now = Date.now();
    const minutes = Math.max(1, Math.round(prefs.heartbeatMinutes || 5));
    // 定时器按分钟节流；事件触发已过唤醒闸（合并窗口/同批冷却/每小时配额），这里不再拦。
    if (trigger === "timer" && now - this.lastHeartbeatAt < minutes * 60_000) return;
    // 卡住老化：一张单卡住超过 30 分钟还没人处置，就把她叫回来重新判断。
    // 不走 escalateBlockedToLynn 的「每单只注入一次」——那一次若正忙就永久丢了，
    // 单子会安静地烂在台账里，界面上只剩一个"卡住"标签。放在堆积闸之前，避免卡得越多越不管。
    const aged = this.taskStore.list().filter((t) => {
      if (t.status !== "blocked" || this.memberRuns.has(t.id)) return false;
      const since = Date.parse(t.updatedAt);
      if (!Number.isFinite(since) || now - since < BLOCKED_AGE_MS) return false;
      return now - (this.blockedAgedNoted.get(t.id) ?? 0) >= BLOCKED_AGE_MS;
    });
    if (aged.length > 0) {
      for (const t of aged) this.blockedAgedNoted.set(t.id, now);
      const mins = Math.round(BLOCKED_AGE_MS / 60_000);
      this.lastHeartbeatAt = now;
      this.card({
        kind: "system",
        badge: "进度",
        text: `${aged.length} 张单卡住超过 ${mins} 分钟没有处置：${aged.map((t) => t.id).join("、")}。已让她重新判断下一步。`,
      });
      this.heartbeatRuns += 1;
      this.submitTurn(
        `【卡住久未处置】${aged.map((t) => `${t.id}「${t.title}」`).join("、")} 卡住超过 ${mins} 分钟且没人跟进。` +
          `判断与处置由你做主，不要问用户要不要取消：方向仍成立就 assign_task 带 reworkTaskId 在原单重做；` +
          `做不了就 stop_task 带 dismiss=true 关单并如实汇报；已有回报就 review_result 验收。`,
        undefined,
        { internal: true, ephemeral: true },
      );
      return;
    }
    const tickTasks = this.taskStore.list();
    const tickById = new Map(tickTasks.map((t) => [t.id, t]));
    const facts: HeartbeatFacts = collectHeartbeatFacts({
      tasks: tickTasks,
      runningTaskIds: [...this.memberRuns.keys()],
      pendingPlanTaskIds: [...this.pendingPlans.values()].map((p) => p.taskId),
      schedules: this.scheduler.list(),
      pendingMentions: this.pendingMentions(),
      detailOf: (id) => this.taskFactNote(id, tickById.get(id) ?? null),
    });
    if (heartbeatIsEmpty(facts)) return;
    // 堆积闸：堆到 7 张以上说明她已经处理不过来了。整轮跳过会把堆积冻在原处——没人清就
    // 永远堆着，界面上只剩每 5 分钟一条一模一样的提示（用户视角就是白烧时间）；全量注入又
    // 会把 15+ 张塞进上下文（实测模型随后在思考里复读 237 次）。折中：一轮只交最靠前的几张
    // 让她清，其余只报数，下一轮接着清；对话流里同一堆积量 30 分钟只说一次。
    const backlog = facts.awaitingReview.length + facts.orphanTasks.length + facts.stalledTasks.length;
    if (backlog > 6) {
      // 自适应节流：上一批没清掉就别每 5 分钟烧一轮——间隔逐级翻倍到 1 小时，清动了立刻恢复常速。
      const gate = this.backlogGate;
      if (gate.at > 0) {
        if (now - gate.at < (gate.waitMin || minutes) * 60_000) return;
        gate.waitMin = backlog >= gate.count ? Math.min(60, (gate.waitMin || minutes) * 2) : 0;
      }
      gate.count = backlog;
      gate.at = now;
      const capped = capHeartbeatFacts(facts, BACKLOG_BATCH);
      const batch = [...capped.facts.awaitingReview, ...capped.facts.orphanTasks, ...capped.facts.stalledTasks].map(
        (t) => t.taskId,
      );
      const key = `backlog:${backlog}`;
      const notedAt = this.heartbeatNoted.get(key);
      this.lastHeartbeatAt = now;
      if (notedAt === undefined || now - notedAt >= 30 * 60_000) {
        this.heartbeatNoted.set(key, now);
        // 去重表瘦身：2 小时前的记录清掉，防长驻增长
        for (const [k, at] of this.heartbeatNoted) {
          if (now - at > 2 * 60 * 60_000) this.heartbeatNoted.delete(k);
        }
        this.card({
          kind: "system",
          badge: "心跳",
          title: "巡检",
          systemTone: "patrol",
          text:
            `有 ${backlog} 张单堆着（待审 ${facts.awaitingReview.length} / 停滞 ${facts.stalledTasks.length}）。` +
            `已让她先清这一批：${batch.join("、")}` +
            `${capped.dropped > 0 ? `，其余 ${capped.dropped} 张下一轮接着清` : ""}。你不用逐张处理。`,
        });
      }
      this.heartbeatRuns += 1;
      this.submitTurn(
        heartbeatPrompt(capped.facts) + BACKLOG_ORDER,
        undefined,
        { internal: true, ephemeral: true },
      );
      this.log("heartbeat_backlog", { backlog, batch: batch.length, dropped: capped.dropped });
      return;
    }
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
    this.card({
      kind: "system",
      badge: "心跳",
      title: "巡检",
      systemTone: "patrol",
      text: `心跳巡检（${brief}）。机器事实已摆到桌面上，由风铃判断处置：停/催/捡/问/汇报。`,
    });
    this.heartbeatRuns += 1;
    this.submitTurn(heartbeatPrompt(facts), undefined, { internal: true, ephemeral: true });
    this.log("heartbeat_fired", {
      awaitingReview: facts.awaitingReview.length,
      stalled: facts.stalledTasks.length,
      schedules: facts.scheduleIssues.length,
    });
  }

  /**
   * 事件驱动唤醒（2026-11-11）：成员回报 / 退出 / 工单卡住 / 定时任务异常时立即评估，
   * 不用等 5 分钟定时器。是否真叫醒模型由三道闸决定（合并窗口 / 同批冷却 / 每小时配额），
   * 所以「秒级感知」不会变成「秒级烧 token」。
   */
  /**
   * 工单落盘后的秒级评估（2026-11-11）：500ms 合并窗口。
   * 只在「有成员在跑」时叫醒——纯落库（历史修复/测试）不值得打扰模型；
   * 成员退出与回报另有显式触发，不会漏。
   */
  private onTaskStoreChanged(): void {
    if (this.memberRuns.size === 0) return;
    if (this.taskChangeTimer) return;
    this.taskChangeTimer = setTimeout(() => {
      this.taskChangeTimer = null;
      this.requestHeartbeat("task_state");
    }, 500);
    this.taskChangeTimer.unref?.();
  }

  /**
   * 心跳事实里的"现场摘要"（2026-11-16）：巡检简报只报成员名字时，她无从判断
   * 是等一等还是重派——把最后动作、产物数、打回轮次一起给她。全部来自内存与卷宗，不编。
   */
  private taskFactNote(taskId: string, prefetched?: TaskRecord | null): string | undefined {
    // prefetched 由调用方从同一次 list() 里带过来：否则每张单都要再读一次盘 + JSON.parse
    const rec = prefetched === undefined ? this.taskStore.get(taskId) : prefetched;
    const bits: string[] = [];
    if (this.memberRuns.has(taskId)) bits.push("成员仍在跑");
    const stepAt = this.memberStepAt.get(taskId);
    if (stepAt) bits.push(`上次动作 ${Math.max(1, Math.round((Date.now() - stepAt) / 1000))}s 前`);
    if (rec?.deliverables?.length) bits.push(`产物 ${rec.deliverables.length} 件`);
    if (rec?.evidence?.length) bits.push(`证据 ${rec.evidence.length} 项`);
    if (rec?.rejectRounds) bits.push(`已打回 ${rec.rejectRounds} 轮`);
    if (rec?.statusNote) bits.push(rec.statusNote.slice(0, 60));
    return bits.length ? bits.join(" · ") : undefined;
  }

  private requestHeartbeat(reason: string): void {
    const prefs = this.settings.getPrefs();
    if (!prefs.heartbeat) return;
    // 本群已终止：事件驱动的唤醒同样闭嘴（否则成员退出/工单变化会把她叫回来）
    if (this.isThreadHalted()) return;
    let facts: HeartbeatFacts;
    try {
      const tasks = this.taskStore.list();
      const byId = new Map(tasks.map((t) => [t.id, t]));
      facts = collectHeartbeatFacts({
        tasks,
        runningTaskIds: [...this.memberRuns.keys()],
        pendingPlanTaskIds: [...this.pendingPlans.values()].map((p) => p.taskId),
        schedules: this.scheduler.list(),
        pendingMentions: this.pendingMentions(),
        detailOf: (id) => this.taskFactNote(id, byId.get(id) ?? null),
      });
    } catch {
      return;
    }
    if (heartbeatIsEmpty(facts)) return;
    const decision = heartbeatWakeDecision({
      now: Date.now(),
      busy: this.busy,
      sig: heartbeatSignature(facts),
      state: this.wakeGate,
      minGapMs: prefs.heartbeatWakeMinMs ?? 20_000,
      cooldownMs: 30 * 60_000,
      perHour: prefs.heartbeatWakePerHour ?? 12,
    });
    this.wakeGate = decision.next;
    if (!decision.wake) {
      // busy 时事件会被丢弃；记下来等这一轮结束补评估一次，别让「成员退出」白白蒸发。
      if (decision.reason === "busy") this.heartbeatPending = reason;
      this.log("heartbeat_event_held", { reason, gate: decision.reason });
      return;
    }
    this.log("heartbeat_event", { reason });
    this.heartbeatTick("event");
  }

  /**
   * 秒级探针（零 token、零 I/O）：只看内存里的成员运行态。
   * 有成员在跑按 prefs.heartbeatProbeMs（默认 1s）看，空闲退避到 15s；
   * 发现「沉默超过阈值」的成员才交给事件闸，由 requestHeartbeat 决定要不要叫醒模型。
   */
  private probeTick(): void {
    const prefs = this.settings.getPrefs();
    const base = prefs.heartbeatProbeMs ?? 1000;
    if (prefs.heartbeat && base > 0 && !this.isThreadHalted()) {
      const now = Date.now();
      for (const taskId of this.memberRuns.keys()) {
        if (this.toolBusy(taskId)) {
          this.silentNoted.delete(taskId);
          continue;
        }
        const at = this.memberStepAt.get(taskId) ?? 0;
        if (!at || now - at < MEMBER_STALL_MS) continue;
        const noted = this.silentNoted.get(taskId) ?? 0;
        if (now - noted < 5 * 60_000) continue;
        this.silentNoted.set(taskId, now);
        this.requestHeartbeat("member_silent");
      }
      for (const taskId of [...this.silentNoted.keys()]) {
        if (!this.memberRuns.has(taskId)) this.silentNoted.delete(taskId);
      }
    }
    this.probeTimer = setTimeout(() => this.probeTick(), probeDelayMs(this.memberRuns.size, base));
    this.probeTimer.unref?.();
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
        /**
         * G1 准入闸（2026-11-17 P3-1 / 07 章 §4）：`role` 不再是自由文本。
         * 混合岗位（「全栈兼文档专家」）直接拒并给可照抄的改法；自由文本能读出来就推断成 roleId；
         * 实在读不出来才 fallback 到 implementer，并如实告诉风铃"这次没匹配到模板"。
         * 位置在建队之前：不合格就不该顺手多建一支空队。
         */
        const roleGate = resolveRole({
          roleId: args.roleId as string | undefined,
          role: args.role as string | undefined,
        });
        if (roleGate.mixed) return mixedRoleRejection(String(args.role ?? ""), roleGate.suggestion ?? null);
        const profile: MemberProfile = {
          name: String(args.name ?? ""),
          role: String(args.role ?? ""),
          roleId: roleGate.roleId,
          goal: String(args.goal ?? ""),
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
          // 正文只讲做事风格。以前写「目标：${goal}」，等于把本次任务复写进档案，
          // 实机 31 份档案全部被这样污染，跨任务复用与经验沉淀都无从谈起。
          body: MEMBER_WORK_STYLE_BODY,
          ...(isAvatarId(args.avatarId) ? { avatarId: args.avatarId } : {}),
          ...(args.acceptor === true ? { acceptor: true } : {}),
        };
        // 闸放在建队之前：不合格就不该顺手多建一支空队。
        const issues = validateMemberProfile(profile);
        if (issues.length) return memberProfileRejection(issues);
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
        this.tools.createMember(teamId, profile, args.justification as string | undefined);
        const hired = this.teamStore.readMember(teamId, String(args.name));
        const face = avatarById(hired.avatarId) ?? avatarFor(hired.name);
        this.emit({
          type: "tool",
          badge: "组队",
          title: `招募 ${args.name} · ${args.role}`,
          body: `目标：${args.goal}\n边界：${((args.boundaries as string[]) ?? []).join("；") || "（未写）"}`,
          members: [{ name: String(args.name), role: String(args.role), color: face.color, avatarId: face.id }],
        });
        return `已招募 ${args.name}（岗位档案已落盘，用户可读可改）。团队 ID：${teamId}（**同一条任务线**的后续派单可省略 teamId；换新任务请显式给新团队，不要复用这条任务线的班底）。${roleGateNote(roleGate)}`;
      }
      case "assign_task": {
        const member = String(args.member ?? "").trim();
        let brief = String(args.brief ?? "");
        const deadline = String(args.deadline ?? "");
        if (!member || !brief || !deadline) {
          return "assign_task 缺 member / brief / deadline：先把这三项补齐再派单。";
        }
        // 新会话第一句闸：不让记忆里的旧失败把一句闲聊变成新工单
        if (!this.looksLikeExplicitTaskRequest()) {
          return "这是新会话的第一句，看起来不像明确的委托。不要直接建队派单：先用 ask_user 问清「是不是真要办这件事、交付什么」，用户确认后再派。";
        }
        // 工单 ID 由系统生成：生产环境忽略模型自造的 taskId；NODE_TEST_CONTEXT 保留旧测试的显式 id
        const explicitTaskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        let taskId = explicitTaskId && process.env.NODE_TEST_CONTEXT ? explicitTaskId : this.nextTaskId();
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
          const raw = String(args.workspace).trim();
          // 先验原始字符串，再 resolve；否则相对路径会被 resolve 成绝对路径而混过校验。
          if (!path.isAbsolute(raw)) {
            // 跨平台单测里也会传 C:\\ 形状；仍按既有口径明确报盘符根，而不是误报不存在。
            if (/^[A-Za-z]:[\\/]$/.test(raw)) {
              return `workspace 不能是数据目录或盘符根（${raw}）：成员会拿到整棵树的写权限。选一个具体的项目/任务子目录。`;
            }
            return `workspace 必须是绝对路径（收到：${String(args.workspace)}）。不确定就先 ask_user 问用户材料在哪。`;
          }
          const ws = path.resolve(raw);
          try {
            if (!fs.statSync(ws).isDirectory()) throw new Error("not-directory");
          } catch {
            return `workspace 目录不存在：${ws}。先 ask_user 向用户确认工作目录，不要猜路径。`;
          }
          const dataRootAbs = path.resolve(this.dataRoot);
          const boundaryError = (candidate: string): string | null => {
            if (candidate === dataRootAbs || isDriveRoot(candidate)) {
              return `workspace 不能是数据目录或盘符根（${candidate}）：成员会拿到整棵树的写权限。选一个具体的项目/任务子目录。`;
            }
            const forbidden = forbiddenRootReason(candidate, this.dataRoot);
            return forbidden ? `workspace 不允许：${forbidden}` : null;
          };
          const lexicalError = boundaryError(ws);
          if (lexicalError) return lexicalError;
          // 符号链接指向家目录、数据根、系统目录或盘符根时，同样不能授权整棵树。
          const real = fs.realpathSync(ws);
          const realError = boundaryError(real);
          if (realError) return realError;
          workspace = ws;
        }
        // 只读授权：先登记，开工时才落权（自动/放手档=风铃授予即生效，询问/计划档=用户点「开始」）。
        // 成员永远不能自己扩权；授权最终写在 TaskRecord.readRoots 上。
        let readRoots: string[] | undefined;
        if (Array.isArray(args.readRoots) && args.readRoots.length > 0) {
          const rawRoots = args.readRoots.map((r) => String(r).trim()).filter(Boolean);
          const relative = rawRoots.filter((r) => !path.isAbsolute(r));
          if (relative.length) {
            return `readRoots 必须是绝对路径（收到：${relative.join("、")}）。先 ask_user 向用户确认材料位置。`;
          }
          const roots = rawRoots.map((r) => path.resolve(r));
          const bad = roots.filter((r) => {
            try {
              return !fs.statSync(r).isDirectory();
            } catch {
              return true;
            }
          });
          if (bad.length) {
            return `readRoots 里这些目录不存在或不是目录：${bad.join("、")}。先 ask_user 向用户确认材料位置。`;
          }
          for (const root of roots) {
            const real = fs.realpathSync(root);
            const forbidden = forbiddenRootReason(root, this.dataRoot) ?? forbiddenRootReason(real, this.dataRoot);
            if (forbidden) return `readRoots 目录 ${root} 不允许授权：${forbidden}`;
          }
          readRoots = roots;
        }
        // 授权随任务线继承：重派时模型常忘带 readRoots，新单变「零授权」→ 成员读工作区外
        // 材料被拒 → 回报「需要用户授权」→ 再重派，2026-11-11 长任务里就是这样空转 20+ 次。
        // 只继承**本会话里用户已批准过**的根（历史工单 readRoots），不是给模型开新权限。
        if (!readRoots?.length) {
          const inherited = new Set<string>();
          for (const t of this.taskStore.list()) {
            if (this.currentThreadId && t.threadId && t.threadId !== this.currentThreadId) continue;
            for (const r of t.readRoots ?? []) inherited.add(r);
          }
          const usable = [...inherited].filter((r) => {
            try {
              if (!path.isAbsolute(r) || !fs.statSync(r).isDirectory()) return false;
              const real = fs.realpathSync(r);
              return !forbiddenRootReason(r, this.dataRoot) && !forbiddenRootReason(real, this.dataRoot);
            } catch {
              return false;
            }
          });
          if (usable.length) readRoots = usable;
        }
        let maxTurns: number | undefined;
        let turnHint = "";
        if (args.maxTurns !== undefined) {
          const n = Number(args.maxTurns);
          if (!Number.isFinite(n) || n < 1) {
            return `maxTurns 必须是 ≥1 的数字（收到：${String(args.maxTurns)}）。`;
          }
          maxTurns = Math.min(Math.round(n), 40);
          // 下限 8 轮（2026-11-12 定）：实机给了 3 轮，成员只够写出四章节骨架（每个标题一句话），
          // 随后两轮重做白烧 20 万 token。轮次给少不会省钱，只会多跑几遍。
          if (maxTurns < MIN_TURNS) {
            const asked = maxTurns;
            maxTurns = MIN_TURNS;
            turnHint = `\n提醒：你给的 ${asked} 轮不够跑完一轮「读材料→产出→回报」，已按下限 ${MIN_TURNS} 轮执行。`;
          }
        }
        // 规模与证据策略（2026-11-11）：小任务 8 轮 / 120K、证据可选；关键任务
        // （审计/对账/安全/可复跑）才强制证据。显式参数优先，其余按简报自动判定。
        const acceptanceList = (Array.isArray(args.acceptance) ? args.acceptance : []).map(String);
        // 禁区（法）与取舍口径（2026-11-12 借 leader）：都是可选参数——
        // 不给就不拦退回（简报硬闸维持四段，不打断既有节奏），给了就一路带到成员眼前
        const forbiddenList = (Array.isArray(args.forbidden) ? args.forbidden : [])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 8);
        const priority = String(args.priority ?? "").trim().slice(0, 200);
        const taskMode: "execute" | "explore" = args.mode === "explore" ? "explore" : "execute";
        const scale = estimateTaskScale(brief, acceptanceList);
        const scaleBudget = scaleLimits(scale);
        // 用户要的是结果，不看证据：默认 optional；只有显式 required 才做内部核验闸。
        const evPolicy: EvidencePolicy =
          args.evidencePolicy === "required" || args.evidencePolicy === "optional" ? args.evidencePolicy : "optional";
        if (maxTurns === undefined) maxTurns = scaleBudget.maxTurns;
        // 标题：优先用模型显式给的 title/taskTitle；否则取简报里最像"任务名"的一行。
        // 2026-11-11：必须清洗——简报首行常是「上一单失败：被当成项目的 C:\Users\Ad…」，
        // 硬砍 40 字会把半条 Windows 路径摆成主区大标题。
        const briefLines = brief.split("\n").map((l) => l.trim()).filter(Boolean);
        const plain = briefLines.find((l) => !/^【[^】]*】/.test(l)) ?? briefLines[0]?.replace(/^【[^】]*】\s*/, "") ?? "";
        const explicitTitle =
          (typeof args.title === "string" && args.title.trim()) ||
          (typeof args.taskTitle === "string" && args.taskTitle.trim()) ||
          "";
        let title = cleanTaskTitle(explicitTitle || plain, taskId);
        // 一件事 = 一张工单：重做 / 打回 / 卡住重来都归并到原单，状态与卷宗留在同一条时间线。
        // 2026-11-11 实机：同一成员被重派 24 次，台账出现「（第2轮）」「（workspace模式重派）」
        // 两张进行中 + 归档带 5 张旧单，全是同一件事。
        const reworkParam = typeof args.reworkTaskId === "string" ? args.reworkTaskId.trim() : "";
        let reworkRec: TaskRecord | null = null;
        if (reworkParam) {
          const rec = this.taskStore.get(reworkParam);
          if (!rec) return `reworkTaskId 不存在：${reworkParam}。重做必须指向一张已有工单。`;
          if (rec.status === "done" || rec.status === "canceled") return `${reworkParam} 已经结案，不能重做；要办新事就别传 reworkTaskId。`;
          if (rec.member && rec.member !== member) return `${reworkParam} 原本派给 ${rec.member}，换人要另开一张单，不要覆盖别人的记录。`;
          reworkRec = rec;
        } else if (!process.env.NODE_TEST_CONTEXT) {
          const dup = findDuplicateAssignment(
            this.taskStore.list().map((t) => ({
              taskId: t.id,
              title: t.title,
              member: t.member ?? "",
              teamId: t.teamId,
              status: t.status,
            })),
            { title, member },
          );
          if (dup) reworkRec = this.taskStore.get(dup.taskId);
        }
        let reworkRound = 0;
        if (reworkRec) {
          if (this.memberRuns.has(reworkRec.id)) {
            return `${reworkRec.id} 还有成员在跑：用 nudge_member 补话，不要重复开工，也不要新开单。`;
          }
          reworkRound = this.teamStore.readAssignments(reworkRec.teamId, reworkRec.id).filter((a) => a.kind === "assign").length + 1;
          if (reworkRound > 4) {
            return `${reworkRec.id} 已经重做 ${reworkRound - 1} 轮。先 review_result / accept_or_reject 验收现有回报，` +
              `或用 stop_task 带 dismiss=true 关单，别原地反复重做，也不要新开单。`;
          }
          taskId = reworkRec.id;
          title = reworkRec.title;
          /**
           * 重派必须交接上一轮做过什么（2026-11-16）。实机：同一张单重派 6 次，
           * 每次都从 `list_dir docs → docs/notes → ...` 重新开始，轮次全烧在重复勘察上，
           * 一次产物都没交出来。这里把上一轮最后几步直接塞进简报，并明确禁止重复。
           */
          const trail = this.memberTrail.get(taskId);
          if (trail && trail.length) {
            brief +=
              `\n\n【上一轮交接（这是第 ${reworkRound - 1} 轮，它做了 ${trail.length} 步后没交出结果）】\n` +
              trail.map((s, i) => `${i + 1}. ${String(s).replace(/\s+/g, " ").slice(0, 160)}`).join("\n") +
              `\n要求：上面这些**已经做过**，不要再重复勘察同一批目录/文件；把已经读到的内容直接用来产出` +
              `（写文件 / 给结论）。如果缺的是关键材料，就在回报里点名要哪一份，不要用"再查一遍"代替交付。`;
          }
          // 上一轮已经写出的文件：别从零重写，也别把它们丢掉
          const alreadyWritten = this.memberProduced.get(taskId);
          if (alreadyWritten?.length) {
            brief +=
              `\n\n【上一轮已经写出的文件（${alreadyWritten.length} 个，还在工作区）】\n` +
              alreadyWritten.map((f) => `- ${f}`).join("\n") +
              `\n做法：先 read_file 看现有版本，接着补/改；不要把已有内容推翻重写，也不要漏掉它们。`;
          }
          this.blockedHandled.delete(taskId);
          this.blockedAgedNoted.delete(taskId);
          this.progressPolls.delete(taskId);
          this.artifactsInspected.delete(taskId); // 重做后产物会换，旧的"已读"不算数
          // 旧契约作废：同一张单不该叠两张「等你拍板」卡
          for (const [id, p] of this.pendingPlans) if (p.taskId === taskId) this.pendingPlans.delete(id);
          this.decisions = this.decisions.filter((d) => !(d.kind === "plan" && d.jobId === taskId));
          this.persistPending();
        }
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
          acceptance: acceptanceList.length ? acceptanceList : ["完成标准全部满足"],
          member,
          tools,
          // 按规模给预算：小任务不再照大任务的标准铺开
          budgetTokens: scaleBudget.budgetTokens,
          evidencePolicy: evPolicy,
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
        // 契约卡上写清项目与落点：用户点「开始」之前就知道这单动的是哪个项目、落在哪
        plan.workspaceRoot = wsFinal;
        if (this.projectRoot) plan.projectName = this.currentProject()?.name ?? defaultProjectName(this.projectRoot);
        // 群任务纯净性闸（2026-11-12）：本群已有在办的事时，别群的单不许混进来——
        // 那是另一件事，应该另开一群。群里混着两件，用户看着像一件。
        const groupTeams = this.groupTeamIds();
        if (!reworkRec && groupTeams.length && !groupTeams.includes(teamId)) {
          return (
            `这是另一条任务线：本群（${groupTeams.join("、")}）已有在办的事，` +
            "别群的单请让用户另开一群再派（一个群 = 一件事）。要在这件里加人手，用同一个队。"
          );
        }
        // 本群用到的队显式绑到本群（首次绑定）：本群成员、"其他团队折叠"都靠它
        this.bindGroup(teamId);
        const ctx: PendingPlan = {
          threadId: this.currentThreadId,
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
          evidencePolicy: evPolicy,
          acceptance: acceptanceList.length ? acceptanceList : undefined,
          forbidden: forbiddenList.length ? forbiddenList : undefined,
          priority: priority || undefined,
          mode: taskMode,
          /**
           * 联网授权（P5-1）：待批准的计划也必须带着它。
           * 默认路径就是「先把契约呈给用户」，漏在这里等于这个功能对默认流程完全无效——
           * 批准之后建单时才发现没有这条，成员一跑命令就被出站闸挡。
           */
          ...(args.network === true
            ? { network: { granted: true as const, by: "lynn" as const, at: new Date().toISOString(), reason: String(args.networkReason ?? "").slice(0, 200) } }
            : {}),
        };
        // 重做：复用原单，只改状态 + 追加卷宗；新任务才 create。
        // blocked→todo / in_review→in_progress 都是状态机允许的迁移（task-store LEGAL）。
        if (reworkRec) {
          try {
            if (reworkRec.status === "blocked") this.taskStore.transition(taskId, "todo", { threadId: this.ensureThreadId() });
            else if (reworkRec.status === "in_review") this.taskStore.transition(taskId, "in_progress", { threadId: this.ensureThreadId() });
          } catch {
            /* 状态已就位 */
          }
          this.taskCase.append(taskId, { kind: "note", text: `第 ${reworkRound} 轮重做：沿用原工单，未新建工单` });
        } else if (!this.taskStore.get(taskId)) {
          // 建单时就钉住会话与工作区：任务线判定、往来归属、成员在哪儿干活都靠它
          this.taskStore.create({
            id: taskId,
            title,
            teamId,
            member,
            threadId: this.ensureThreadId(),
            workspaceRoot: wsFinal,
            workspace: wsRec,
            evidencePolicy: evPolicy,
            brief,
            ...(acceptanceList.length ? { acceptance: acceptanceList } : {}),
            ...(forbiddenList.length ? { forbidden: forbiddenList } : {}),
            ...(priority ? { priority } : {}),
            mode: taskMode,
            /**
             * 联网授权（P5-1）：`network: true` 才给网，缺省不给。
             * 落盘而不只是记在参数里——派单之后才跑命令，那时已经看不到 args 了。
             */
            ...(args.network === true
              ? { network: { granted: true, by: "lynn" as const, at: new Date().toISOString(), reason: String(args.networkReason ?? "").slice(0, 200) } }
              : {}),
            scale,
            // 派单时所在的项目（冻结快照）：契约卡上写「项目 · 名字」，
            // 旧单翻出来也知道当初动的是哪个项目
            ...(this.projectRoot ? { projectName: this.currentProject()?.name ?? defaultProjectName(this.projectRoot) } : {}),
          });
          this.taskStore.transition(taskId, "todo");
        }
        /**
         * 阶段账（2026-11-15 接入）：阶段清单落单，顺序不再由模型记忆持有。
         * 阶段数跟规模走——小任务只有「契约 → 产出 → 汇报」，写一篇散文不该架三支队。
         * 重做沿用原单的阶段账（打回时已把产出段拉回执行中），不重新建一份。
         */
        if (!this.taskStore.get(taskId)?.stagePlan) {
          try {
            this.taskStore.setStagePlan(taskId, createStagePlan(`sp-${taskId}`, title, stageDefsFor({ scale, mode: taskMode })));
          } catch (err) {
            this.log("stage_plan_failed", {
              taskId,
              error: String(err instanceof Error ? err.message : err).slice(0, 200),
            });
          }
        }
        const stageTitles = (this.taskStore.get(taskId)?.stagePlan?.stages ?? []).map((s) => s.title);
        const stageNote = stageTitles.length ? `\n\n阶段：${stageTitles.join(" → ")}（进度由系统记，别自己数）` : "";
        const reworkNote = reworkRec
          ? `\n这是 ${taskId} 的第 ${reworkRound} 轮重做：状态与卷宗都记在同一张单里，没有新建工单。`
          : "";
        const scaleLabel = scale === "small" ? "小" : scale === "large" ? "大" : "中";
        const focusNow = this.taskStore.get(taskId)?.reworkFocus;
        const focusNote =
          focusNow?.items.length ? `\n本轮只重做未过项：${focusNow.items.join("；")}（已过的部分不要推翻重做）` : "";
        const scaleNote =
          `\n本单按${scaleLabel}任务配置：${maxTurns ?? scaleBudget.maxTurns} 轮 / ` +
          `${Math.round(scaleBudget.budgetTokens / 1000)}K 预算；按交付结果验收。` +
          stageNote +
          focusNote;
        if (this.settings.getPrefs().autoStart) {
          // 自动开始跳过契约卡；授权状态并进「派单」工具卡统一出，别再刷第二张系统卡。
          return `已按任务契约开工（设置里开启了自动开始）。${this.startAssignment(ctx)}\n任务 ID：${taskId}（系统生成；后续查进度/催办都用它，不要自己编）。${turnHint}${reworkNote}${scaleNote}`;
        }
        const decisionId = `plan-${taskId}-${Date.now().toString(36)}`;
        this.pendingPlans.set(decisionId, { ...ctx, decisionId });
        // 一个群 = 一件事：群名还没定过时，用任务标题命名（用户手动改过就不动）
        try {
          this.threads.autoTitle(this.ensureThreadId(), title);
        } catch {
          /* 命名失败不影响派单 */
        }
        /**
         * 授权归风铃（2026-11-15 拍板的口径）：成员权限由她判断风险后授予，
         * 用户只管她的档位。所以自动/放手档下这份只读授权直接生效（写进契约卡是告知，不是征求）；
         * 询问/计划档才仍走「点开始」那一次点头——那一档用户要管的正是"她能不能动"。
         */
        const selfGrant = this.permission === "auto" || this.permission === "full";
        const permNote = readRoots?.length
          ? selfGrant
            ? `\n\n只读授权（风铃判断风险后授予，可在设置里撤销）：${readRoots.join("、")}`
            : `\n\n只读授权申请（点「开始」即批准）：${readRoots.join("、")}`
          : "";
        // 禁区 / 取舍 / 型态也上契约卡：用户点「开始」前就该看见这次的红线
        const methodNote =
          (forbiddenList.length ? `\n\n禁区（不许做）：${forbiddenList.join("；")}` : "") +
          (priority ? `\n取舍口径：${priority}` : "") +
          (taskMode === "explore" ? `\n型态：探索型（要结论与依据，不硬凑产物）` : "");
        this.decisions.push({
          id: decisionId,
          from: "计划",
          title: `任务契约 · ${title}`,
          detail: `${brief}\n\n工作区（可读写）：${wsFinal}${permNote}${methodNote}${scaleNote}`,
          kind: "plan",
          jobId: taskId,
          threadId: this.currentThreadId,
          at: new Date().toISOString(),
          plan,
          checks: plan.acceptance.map((a) => ({ ok: true, text: a })),
        });
        // 契约必须落盘：重启后靠它把「等用户确认」的单认回来，而不是当成停滞催重做
        this.persistPending();
        this.lastPlanAt = Date.now();
        this.setTurn({ phase: "awaiting_plan", taskId });
        this.emit({
          type: "tool",
          badge: "需要你拍板",
          title: `待你确认 · ${taskId}`,
          meta: `${member} · 截止 ${deadline}`,
          body: `${brief}\n\n验收：${plan.acceptance.join("；")}\n工作区（可读写）：${wsFinal}${permNote}${scaleNote}`,
        });
        return `任务契约已呈给用户，等你确认后才开工。不要重复派单，也不要自己模拟成员执行。任务 ID：${taskId}（系统生成；后续查进度/催办都用它，不要自己编）。${turnHint}${reworkNote}${scaleNote}`;
      }
      case "check_progress": {
        const taskId = String(args.taskId);
        const rec = this.taskStore.get(taskId);
        let sig: string;
        if (!rec) {
          // 单不存在：照实说查不到，但也走同一套轮询计数——
          // 反复查一张不存在的单同样是刷屏（模型会拿编出来的 ID 试）。
          sig = `查不到这张单：${taskId}。ID 由系统生成，别自己编；先看台账或 check_roster。`;
        } else if (rec.status === "canceled") {
          // 已取消的单不该再出现在"要跟进"的清单里（2026-11-13：用户已拍板的事别再问第二遍）
          sig = `${taskId} 已取消（关单时留的记录在卷宗里），不要再跟进、不要再汇报它，除非用户问起。`;
        } else {
          // 团队归属优先按工单认：resolveTeamId 是「按当前任务线猜」，同时有别的任务线的队时
          // 会返回 undefined——2026-11-12 实机因此连报三次「本机还没有任何团队」，
          // 风铃据此误判"成员没在跑"，同一张单被重派了 3 次。
          let teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
          if (!teamId) {
            const owner = rec.teamId;
            if (owner && this.teamStore.teamExists(owner)) teamId = owner;
          }
          if (!teamId) {
            sig = `找不到 ${taskId} 归属的团队（工单记录在，团队可能已被解散）：带上 teamId 再查，或直接 accept_or_reject 结案。`;
          } else {
            const p = {
              ...this.tools.checkProgress(teamId, taskId),
              running: this.memberRuns.has(taskId),
              // 阶段账（2026-11-15）：进度由系统算好给它，别让它自己数——它会数错，也会反复查
              ...(this.stageSummaryOf(taskId) ? { stage: this.stageSummaryOf(taskId) } : {}),
              ...(rec.reworkFocus?.items.length
                ? { reworkFocus: `本轮只重做 ${rec.reworkFocus.items.length} 条未过项` }
                : {}),
            };
            sig = JSON.stringify(p, null, 2);
          }
        }
        // 只读工具，但模型会把它当"等状态变"的轮询器：2026-11-11 长任务查了 246 次，
        // 同一批工单反复查、不验收也不收尾，直到上下文被撑爆。结果没变就明确叫停。
        const prev = this.progressPolls.get(taskId);
        const count = prev?.sig === sig ? prev.count + 1 : 1;
        this.progressPolls.set(taskId, { sig, count });
        if (count >= 3) {
          return `${sig}\n\n[轮询提醒] 第 ${count} 次查同一张单，结果没有任何变化。不要再轮询了：` +
            `有回报就 review_result / accept_or_reject 验收，在跑就等，卡住就 nudge_member 或 stop_task，` +
            `阶段齐了直接 report_to_user 收尾。继续查不会让状态自己变。`;
        }
        return sig;
      }
      case "nudge_member": {
        return this.nudgeMember(String(args.taskId), String(args.note ?? ""));
      }
      case "reply_member": {
        // 回答成员在群里的提问 / 纠正他的错误（2026-11-16）：与催办分开，文案与意图都不同
        return this.replyMember(String(args.taskId), String(args.text ?? ""));
      }
      case "stop_task": {
        const taskId = String(args.taskId);
        const r = this.cancelMemberTask(taskId);
        if (!r.ok) return `停不下来：${r.error ?? "未知原因"}`;
        const why = args.reason ? `原因：${String(args.reason)}。` : "";
        if (args.dismiss === true) {
          const rec = this.taskStore.get(taskId);
          const hasDeliverable = (rec?.deliverables?.length ?? 0) > 0;
          const d = this.dismissTask(taskId, "lynn");
          if (!d.ok) return `已停下，但没能取消：${d.error ?? "未知原因"}`;
          if (!hasDeliverable) {
            // 2026-11-11 实机：成员两次跑完没交付，她直接关单并说「已处理完毕」。
            // 没有交付物就是失败，必须让用户看见失败本身。
            this.card({
              kind: "system",
              badge: "进度",
              jobId: taskId,
              text: `未完成：${taskId} 没有任何交付物，已关单（卷宗保留）。`,
              mentions: rec?.member ? [{ kind: "member", name: rec.member, memberId: rec.member }] : undefined,
            });
            return `已关单，但**这张单没有任何交付物**——不要对用户说「已处理完毕 / 已完成」。` +
              `如实说明：这件事没做出来、成员两次跑完未交付、卡在哪；给出下一步（换人重做 / 换方式 / 请用户决定），` +
              `不要说「如果你还需要就再告诉我」。这张单已关闭，之后的汇报里不要再列它（除非用户问起）。`;
          }
          return `已停并取消 ${taskId}。${why}风铃判定不再继续：工单进归档带、卷宗保留，不需要用户确认。这张单已关闭，之后的汇报里不要再列它（除非用户问起）。`;
        }
        return `已停 ${taskId}。${why}工单转入「卡住」，下一步由你决定并自己执行：` +
          `目标仍成立 → assign_task 带 reworkTaskId=${taskId} 在原单上重做（不会新建工单）；` +
          `方向已错或做不了 → stop_task 带 dismiss=true 关单并如实汇报。不要问用户要不要取消。`;
      }
      case "check_roster": {
        return JSON.stringify(this.tools.roster(args.teamId ? String(args.teamId) : undefined), null, 2);
      }
      case "read_artifact": {
        /**
         * 验收前读产物正文（2026-11-12）。此前风铃只能看到"文件存在 + 成员自述结构齐全"，
         * 实机把一份只有四行章节标题的骨架稿验收通过，用户打开才发现没内容。
         */
        const taskId = String(args.taskId ?? "").trim();
        if (!taskId) return "taskId 必填：要看哪张单的产物。";
        const rec = this.taskStore.get(taskId);
        if (!rec) return `没有这张单：${taskId}（ID 由系统生成，别自己编）。先 check_progress 或看台账。`;
        // 读过就算"看过"（哪怕文件被挪走读不出来）：验收闸只要求她真去读过正文
        this.artifactsInspected.add(taskId);
        const base = path.resolve(this.dataRoot, "tasks", taskId);
        const files: { ref: string; label: string; bytes?: number }[] = [];
        for (const d of rec.deliverables ?? []) files.push({ ref: d.ref, label: d.path, bytes: d.bytes });
        for (const e of rec.evidence ?? []) {
          if (e.ref && !files.some((f) => f.ref === e.ref)) files.push({ ref: e.ref, label: e.label });
        }
        const wanted = String(args.ref ?? "").trim();
        const pick = wanted
          ? files.find((f) => f.ref === wanted || f.label === wanted || f.ref.endsWith(wanted))
          : files[files.length - 1];
        if (!pick) {
          return wanted
            ? `这张单里没有这个产物：${wanted}。用不带 ref 的调用看清单。`
            : `这张单还没有可读产物（交付物 ${rec.deliverables?.length ?? 0} 件、证据 ${rec.evidence?.length ?? 0} 项）：先让成员交回报。`;
        }
        const ext =
          path.extname(pick.ref).slice(1).toLowerCase() || path.extname(pick.label).slice(1).toLowerCase();
        // 路径守卫与 preview.read 一致：只读卷宗内、或已登记为交付物的绝对路径
        let target = path.resolve(base, pick.ref);
        if (!target.startsWith(base + path.sep)) {
          if (!path.isAbsolute(pick.ref) || !this.isTaskDeliverable(taskId, pick.ref)) {
            return `这个产物不在卷宗里，读不了：${pick.ref}`;
          }
          target = path.resolve(pick.ref);
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return `产物文件不存在（可能已被移动）：${pick.ref}`;
        const size = fs.statSync(target).size;
        const kb = size >= 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`;
        const limit = Math.max(1000, Math.min(Number(args.maxChars) || 8000, 20_000));
        let body = "";
        let note = "";
        try {
          if (ext === "docx" || ext === "docm") {
            body = readDocxText(fs.readFileSync(target));
            note = "Word 正文；表格按 | 列分隔";
            if (!body.trim()) body = "（正文是空的：文档里没有段落也没有表格——这就是骨架稿/空稿）";
          } else if (/^(png|jpe?g|gif|webp|bmp|pdf|zip|xlsx|pptx|doc)$/.test(ext)) {
            return `产物 ${pick.ref}（${kb}）是二进制，文本核对读不出内容。看它是否存在、大小是否合理，或让用户点内置预览。`;
          } else {
            body = fs.readFileSync(target, "utf8");
          }
        } catch (err) {
          return `读不出 ${pick.ref}：${err instanceof Error ? err.message : String(err)}`;
        }
        // 分页（2026-11-13 缓存分析）：默认读头一段做验收判定（骨架稿/占位符/空章节一眼可见），
        // 要细读再按 offset 翻页——全文一次性进上下文是验收轮暴涨的主要来源之一。
        const offset = Math.max(0, Math.min(Number(args.offset) || 0, body.length));
        const clipped = body.length > offset + limit;
        const page = body.slice(offset, offset + limit);
        const head = offset > 0 ? `（从第 ${offset} 字起继续读）\n` : "";
        const tail = clipped
          ? `\n……（已截断：原文 ${body.length} 字，这是第 ${offset + 1}~${offset + page.length} 字；要读后续传 offset=${offset + page.length}）`
          : offset > 0
            ? `\n（已到文末，共 ${body.length} 字）`
            : "";
        return [
          `产物：${pick.ref}（${kb}${note ? `，${note}` : ""}）` +
            (files.length > 1 ? `\n这张单共 ${files.length} 件产物，读其它件就传 ref` : ""),
          "-".repeat(48),
          head + page + tail,
        ].join("\n");
      }
      case "ship_plugin": {
        // M3-07（Q6 定稿 C）：只有 L0 技能插件允许她自启用，每次启用记审计并落卡告知用户
        const draftId = String(args.draftId);
        const existing = {
          pluginIds: this.pluginHost.scan().plugins.map((p) => p.id),
          skillNames: this.skillEntries.map((s) => s.name),
        };
        const review = reviewDraft(this.dataRoot, draftId, existing);
        if (!review.ok) {
          return JSON.stringify({ ok: false, verdict: review.verdict, findings: review.findings }, null, 2);
        }
        if (review.tier !== "L0") {
          return `${review.tier} 档插件不能由你启用（她不得给自己的产物提权，Q6 定稿 C）。审查已通过，请如实告知用户：在插件面板点「启用」即可生效。`;
        }
        let enabled;
        try {
          enabled = promoteDraft(this.dataRoot, draftId, false, existing);
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
        const taskId = String(args.taskId ?? "");
        const member = String(args.member ?? "");
        const text = String(args.text ?? "").trim();
        // 成员还在跑就别替它交回报：实机风铃把「成员正在后台执行」当成回报登记，
        // 工单被推进待审查，用户点验收时产物还没生成（2026-11-12 实锤）。
        if (this.memberRuns.has(taskId)) {
          return `${taskId} 的成员还在跑：等它自己回报（回报会自动进待审查），要补话用 nudge_member。不要替成员写回报。`;
        }
        /**
         * 成员已经自己交过回报了 → 不要再登记一次（2026-11-13 实机）：
         * 重复登记会在群里落第二张一模一样的「回报」卡，用户看到"同一份结果两个头"。
         * 这时她该做的是验收，不是再写一遍回报。
         */
        if (this.selfReported.has(`${taskId}::${member}`)) {
          return `${taskId} 的回报已经由成员自己交上来了（群里那张「回报」卡就是），不要重复登记。直接 read_artifact 读正文后 accept_or_reject 验收。`;
        }
        if (!text) return "回报正文不能为空：写清成员交回了什么、证据是什么。";
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) return "本机还没有任何团队，无从登记回报。先 create_team（ID 由系统生成）。";
        return this.registerReport(teamId, taskId, member, text, (args.evidence as string[]) ?? []);
      }
      case "accept_or_reject": {
        /** 阶段账的收尾提示（推进结果回给模型，让它知道还剩哪一段没走完） */
        let stageTail = "";
        // 硬闸：有产物的单，验收前必须 read_artifact 看过正文。实机她只看
        // "文件存在 + 成员说结构齐全"就把四行标题的骨架稿验收通过了（2026-11-12）。
        if (args.verdict === "accept") {
          const rec = this.taskStore.get(String(args.taskId));
          const hasArtifacts = (rec?.deliverables?.length ?? 0) + (rec?.evidence?.length ?? 0) > 0;
          if (hasArtifacts && !this.artifactsInspected.has(String(args.taskId))) {
            return (
              `${args.taskId} 有产物但还没读过正文：先 read_artifact（不带 ref 读最后一件）把内容过一遍再下结论。` +
              "「文件存在」「成员说结构齐全」不是验收——骨架稿、占位符、空章节只有读了正文才看得见。"
            );
          }
        }
        const teamId = this.resolveTeamId(args.teamId ? String(args.teamId) : undefined);
        if (!teamId) return "本机还没有任何团队，无从验收。先 create_team（ID 由系统生成）。";
        /**
         * 打回轮次以**工单为唯一真相**（2026-11-16 修「任务被异常打回」）：
         * 此前 acceptOrReject 自己读派单账本的 reject 条数判上限，而权威工单另有 rejectRounds。
         * 两本账会漂移（工单不在 in_review 时账本记了、工单没记），于是刚打回一次就被告知
         * 「已达上限」并把单停成卡住——用户看到的就是任务被莫名其妙打回。
         * 现在先把轮次落到工单上，再拿着同一个数去判上限，一处口径。
         */
        const rejectReasonFor = {
          what: String(args.what ?? ""),
          expect: String(args.expect ?? ""),
          deadline: String(args.deadline ?? ""),
          member: String(args.member),
        };
        // 先校验再落库：三要素不全就不该把工单打回（顺序反了会出现"单被打了、账本没记"）
        if (
          args.verdict === "reject" &&
          (!rejectReasonFor.what.trim() || !rejectReasonFor.expect.trim() || !rejectReasonFor.deadline.trim())
        ) {
          return "打回必须写清：哪里不合格（what）/ 期望是什么（expect）/ 多久内重交（deadline）。缺一项就是无理由打回，成员拿不到可执行的修改方向。";
        }
        let rejectRounds = 0;
        if (args.verdict === "reject") {
          try {
            rejectRounds = this.taskStore.reject(String(args.taskId), rejectReasonFor).record.rejectRounds;
          } catch {
            // 工单已不在 in_review（旧记录/手工单）：按账本既往条数 + 本次估一轮，只用于判上限
            rejectRounds = this.teamStore.rejectCount(teamId, String(args.taskId)) + 1;
          }
        }
        const r = this.tools.acceptOrReject(teamId, String(args.taskId), args.verdict as "accept" | "reject", {
          member: String(args.member),
          rejectReason:
            args.verdict === "reject"
              ? { what: rejectReasonFor.what, expect: rejectReasonFor.expect, deadline: rejectReasonFor.deadline }
              : undefined,
          evidence: args.evidence as string[] | undefined,
          priorRejects: rejectRounds,
        });
        /**
         * 阶段账（2026-11-15）：
         *  - 通过 → 独立验收段结束，全阶段齐了才生成最终验收表（收尾不再靠模型自觉）；
         *  - 打回 → 只把「产出」这一段拉回执行中（下游自动退回 pending），
         *    并把未过项记在单上，重派时只重做这几条——这才是"打回只重做未过项"。
         */
        const tidForStage = String(args.taskId);
        if (args.verdict === "reject") {
          try {
            const cur = this.taskStore.get(tidForStage);
            if (cur?.stagePlan) {
              const redoId = cur.mode === "explore" ? "survey" : "produce";
              this.taskStore.setStagePlan(
                tidForStage,
                reopenStage(cur.stagePlan, redoId, `打回：${String(args.what ?? "").slice(0, 120)}`),
              );
            }
            const failed = (Array.isArray(args.failedChecks) ? args.failedChecks : []).map(String).filter(Boolean);
            if (failed.length) {
              this.taskStore.setReworkFocus(tidForStage, failed);
              this.taskCase.append(tidForStage, {
                kind: "note",
                text: `本轮只重做未过项（${failed.length} 条）：${failed.join("；")}`,
              });
            }
          } catch (err) {
            this.log("stage_reopen_failed", {
              taskId: tidForStage,
              error: String(err instanceof Error ? err.message : err).slice(0, 200),
            });
          }
        } else {
          const stageRec = this.taskStore.get(tidForStage);
          const verifyTail = this.advanceStage(tidForStage, "verify", [
            `验收结论：${String(args.member ?? "")} · 判据 ${stageRec?.acceptance?.length ?? 0} 条`,
            this.artifactsInspected.has(tidForStage) ? "已读产物正文" : "无产物需读正文",
          ]);
          const finalTail = this.finalizeStagesIfReady(tidForStage);
          if (finalTail || verifyTail) stageTail = finalTail || verifyTail;
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
            // 归档了就要给用户一个交代：整轮没写汇报时，收轮时系统按卷宗补一张
            this.pendingFinalReport = { taskId: String(args.taskId), member: String(args.member ?? "") };
          } catch (err) {
            whyNot = err instanceof Error ? err.message : String(err);
          }
        }
        const atReview = this.atMember(
          String(args.member ?? ""),
          args.verdict === "accept"
            ? undefined
            : `不合格：${args.what}\n期望：${args.expect}\n时限：${args.deadline}`,
        );
        this.emit({
          type: "tool",
          badge: "审查",
          title: `${args.verdict === "accept" ? "验收通过" : "打回"} · ${args.member}`,
          body: atReview.body,
          author: { kind: "lynn", name: "风铃" },
          mentions: atReview.mentions,
        });
        const reply = r.escalated
          ? "打回已达上限：这张单停在「卡住」，停止循环打回，也不再问用户。" +
            "下一步你自己定——换人重做 / 换一种做法 / 拆小 / 关单（stop_task dismiss=true），" +
            "处置完在汇报里写清「没做成 + 卡在哪 + 建议怎么做」，不要把选择推回给用户。"
          : args.verdict === "accept"
            ? archived
              ? "已代验归档：这张单结案，不再占用用户。整件事做完后用 report_to_user 把最终结果汇报给她，她只对那一份拍板。"
              : `验收结论已记录，但没能归档（${whyNot}）。先补齐可说清的证据，或确认这张单确实在待验状态。`
            : `已打回，并写清了改什么、期望什么、时限。让 ${args.taskId ?? "这张单"} 的原成员重做时，用 assign_task 带 reworkTaskId=${String(args.taskId ?? "")} 在同一张单上重派（状态与卷宗都留在这张单里），不要新开工单。` +
              ((Array.isArray(args.failedChecks) ? args.failedChecks : []).length
                ? "已记下未过项：重派时成员只重做这几条，已通过的部分不推翻。"
                : "没填 failedChecks：成员拿不到「只改哪几条」，会整段重做——下次填上。");
        return stageTail ? `${reply}\n阶段：${stageTail}` : reply;
      }
      case "set_group_notice": {
        // 群公告（全局段）：只有风铃能写。落一张她的话的卡，让群里看得见是谁写的。
        const text = String(args.text ?? "").trim();
        if (!text) return "群公告不能空：写清整体干什么、谁管哪段、接缝在哪。";
        if (!this.currentThreadId) return "现在没有群（会话）：先开一个群再写公告。";
        this.threads.setAnnouncement(this.currentThreadId, text);
        this.card({
          kind: "lynn",
          text: `群公告写好了：\n${text}`,
          author: { kind: "lynn", name: "风铃" },
        });
        return "群公告已写好（群里每个人都能看见，我每轮也看得见）。";
      }
      case "report_to_user": {
        // 汇报里也不许反问产出细节（放哪/叫什么/什么格式/让用户自己存）——那会把活推回用户
        const reportText = `${String(args.conclusion ?? "")} ${String(args.unfinished ?? "")} ${String(args.decisionsNeeded ?? "")}`;
        if (isAskingUserForOutputDetails(reportText)) return REPLY_GUARD_HINT;
        // 没有交付物却宣称「已完成 / 已处理完毕」= 把失败包装成完成（2026-11-11 实机）
        const doneTaskId = String(args.taskId ?? "");
        const doneRec = doneTaskId ? this.taskStore.get(doneTaskId) : null;
        if (doneRec && (doneRec.deliverables?.length ?? 0) === 0 && claimsDone(reportText)) {
          return NO_DELIVERABLE_HINT;
        }
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
        // 阶段账：汇报是最后一段；全阶段齐了由代码收尾（不再靠模型自觉说"做完了"）
        const reportTaskId = String(args.taskId);
        this.advanceStage(reportTaskId, "report", [`汇报：${String(args.conclusion).slice(0, 60)}`]);
        this.finalizeStagesIfReady(reportTaskId);
        // 产物做成可点的清单：报告里只给绝对路径字符串，用户还得自己去资源管理器里翻
        // （实机：汇报写完 "C:\Users\...\漏洞文档测试-续.docx"，用户只能自己去打开）
        const artifacts = (doneRec?.deliverables ?? []).map((d) => ({
          label: d.path.split(/[\\/]/).filter(Boolean).pop() ?? d.path,
          ref: d.ref,
          ...(d.bytes ? { bytes: d.bytes } : {}),
        }));
        // 她已经自己汇报过了 → 收轮时不要再补系统汇总
        this.reportedThisTurn = true;
        this.pendingFinalReport = null;
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
          ...(artifacts.length ? { artifacts } : {}),
          body: [
            `结论：${args.conclusion}`,
            artifacts.length ? `产物（${artifacts.length} 件，卡片上可直接点开）：${artifacts.map((a) => a.label).join("、")}` : null,
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
        // 问「文件放哪/叫什么/什么格式/发我」= 把产出细节推回用户，直接拒发并纠正。
        if (isAskingUserForOutputDetails(String(args.question ?? ""))) return REPLY_GUARD_HINT;
        // 刚呈上任务契约又问"是否确认开工"= 重复确认：契约卡自己带「开始/修改/驳回」，
        // 再来一问只会把用户的回答变成一轮新对话（真实事故：一次派单问了两遍）
        // 只挡"本群"刚呈上的契约：别群在等拍板，不该堵住这个群问别的问题
        if (this.decisionsForCurrentThread().some((d) => d.kind === "plan") && Date.now() - this.lastPlanAt < 120_000) {
          return "任务契约已经在等用户确认（卡片上有「开始 / 修改 / 驳回」三个按钮），不要再用 ask_user 重复问是否开工。把需要补充的说明写进下一次回复即可。";
        }
        const q = this.tools.askUser(String(args.question), String(args.context ?? ""));
        this.decisions.push({
          id: q.id,
          from: "升级",
          title: String(args.question).slice(0, 60),
          detail: String(args.context ?? ""),
          kind: "question",
          threadId: this.currentThreadId,
          at: new Date().toISOString(),
        });
        this.persistPending();
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
        // 项目记忆（2026-11-14）：跟着项目走，换个项目看不到；没有项目就如实拒，不写进全局
        if (args.scope === "project") {
          const proj = this.currentProject();
          if (!proj) return "当前没有项目目录，写不了项目记忆。先选项目，或者用 scope=memory 写助理记忆。";
          const r = this.memory.learnProject(proj.id, entry);
          if (!r.ok) return `没写成项目记忆：${r.error ?? "未知原因"}`;
          /**
           * 2026-11-17 缓存修复 B3：**不再热同步 system prompt**。
           * 记忆段在 system 里，一改就把「人设+记忆+全部历史」的前缀整体作废
           * （实测每天 13 次记忆变更 = 13 次整段重算）。改为当轮尾部提示：
           * 本会话即时可见，下个会话/切项目时进快照。
           */
          if (r.added) this.pendingMemoryNote = `【记忆更新·项目】${entry}`;
          this.card({
            kind: "system",
            badge: "记忆",
            text: r.added ? `已记到项目「${proj.name}」：${entry.slice(0, 120)}` : `项目「${proj.name}」里已有这条，没重复记。`,
          });
          this.log("project_memory_saved", { projectId: proj.id, added: Boolean(r.added), hot: false });
          return r.added
            ? `已记进项目「${proj.name}」的项目记忆（本会话即时可见，下个会话起进入系统提示）。`
            : `项目「${proj.name}」里已经有这条事实了，没有重复写。`;
        }
        const kind: MemoryKind = args.scope === "user" ? "user" : "memory";
        const label = kind === "user" ? "用户记忆" : "助理记忆";
        const current = this.memory.load(kind).replace(/\s+$/, "");
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        this.memory.save(kind, `${current}\n- ${stamp} ${entry}\n`);
        // 缓存修复 B3：不动 system 前缀；当轮尾部提示保证"刚记的立刻知道"
        this.pendingMemoryNote = `【记忆更新】${entry}`;
        this.card({ kind: "system", badge: "记忆", text: `已沉淀到${label}：${entry.slice(0, 120)}` });
        this.log("memory_saved_by_agent", { scope: kind, chars: entry.length, hot: false });
        return `已写入${label}（本会话即时可见，下个会话起进入系统提示）。同类任务再遇到时你会直接想起来。`;
      }
      case "read_memory": {
        // 项目记忆（2026-11-14）：读之前先确认有项目，别拿全局记忆冒充
        if (args.scope === "project") {
          const proj = this.currentProject();
          if (!proj) return "当前没有项目目录，没有项目记忆可读。";
          const pe = parseEntries(this.memory.loadProject(proj.id));
          if (!pe.length) return `项目「${proj.name}」还没有记过东西。`;
          return (
            `项目「${proj.name}」的记忆（共 ${pe.length} 条）：\n` +
            pe.map((e, i) => `- 第${i + 1}条${e.at ? ` ${e.at}` : ""}：${e.text.slice(0, 160)}`).join("\n") +
            "\n\n项目记忆要改/删就直接编辑文件里对应那条（或者在设置里看）；它只在这个项目里可见。"
          );
        }
        const kind: MemoryKind = args.scope === "user" ? "user" : "memory";
        const label = kind === "user" ? "用户记忆" : "助理记忆";
        const entries = parseEntries(this.memory.load(kind));
        if (!entries.length) return `${label}现在是空的。`;
        const lines = entries.map((e) => `- 第${e.line}行${e.at ? ` ${e.at}` : ""}：${e.text.slice(0, 120)}`);
        return `${label}（共 ${entries.length} 条）：\n${lines.join("\n")}\n\n要删哪条就用 forget_memory 带上能唯一定位的原文片段。`;
      }
      case "forget_memory": {
        const keyword = String(args.keyword ?? "").trim();
        if (!keyword) return "keyword 不能为空：写记忆里那段能唯一定位的原文片段（如 HERMIX-4471）。";
        const kind: MemoryKind = args.scope === "user" ? "user" : "memory";
        const label = kind === "user" ? "用户记忆" : "助理记忆";
        const r = this.memory.forget(kind, keyword);
        if (!r.ok) {
          const cands = (r.candidates ?? []).map((c) => `- 第${c.line}行：${c.text}`).join("\n");
          return `${r.error}${cands ? `\n候选：\n${cands}` : ""}`;
        }
        const removed = r.removed?.text ?? "";
        // 缓存修复 B3：不动 system；当轮告诉它别再引用已删的事实
        this.pendingMemoryNote = `【记忆已删除】${removed}（后续不要再引用这一条）`;
        this.card({ kind: "system", badge: "记忆", text: `已从${label}删除一条记忆：${removed.slice(0, 120)}` });
        this.log("memory_forgotten_by_agent", { scope: kind, keyword, hot: false });
        return `已从${label}删掉这一条：「${removed.slice(0, 120)}」。旧版本已存档（版本 ${r.versionId}），删错了可以回滚；本会话起不再引用。`;
      }
      /**
       * 插件自举三件套（2026-11-17 P8-2 / 24 章第 6 节）。
       *
       * 为什么需要：自举闭环里「起草 → 审查 → 启用」已经齐了，但**缺三件她自己的操作**——
       * 看不见装了什么、关不掉装错的、删不掉装错的。没有这三件，"随意增删改插件"
       * 只能靠用户在面板里点，她没法自己收拾。
       *
       * 三件都**只做用户也能做的事**，不越过 Q6 那条线：
       *  - `list_plugins`：只读，看得到才管得了；
       *  - `set_plugin_enabled`：停用/启用**已装**的插件（停用永远允许，启用受档位约束）；
       *  - `uninstall_plugin`：删掉已装的插件（进回收目录，可人工恢复）。
       *
       * **注意：这三个都不提供"改已装插件的代码"**。改代码走 `create_plugin_draft`
       * + 新的 id 重装——因为 `promoteDraft` 明确"冲突即拒"，覆盖式更新会丢掉回滚能力。
       * 可回滚的 update 是 24 章第 6 节列的缺口，还没做。
       */
      case "list_plugins": {
        const scanned = this.pluginHost.scan();
        // PluginView 是扁平结构（name/version/tier 直接挂在顶层），不是嵌套 manifest
        const rows = scanned.plugins.map((p) => ({
          id: p.id,
          tier: p.tier,
          enabled: p.enabled,
          name: p.name || p.id,
          version: p.version ?? "",
          slots: p.slots ?? [],
          loadable: p.loadable,
        }));
        if (!rows.length) return "还没有安装任何插件。";
        return [
          `已装插件 ${rows.length} 个：`,
          ...rows.map(
            (r) =>
              `- ${r.id}（${r.tier}${r.enabled ? "" : " · 已停用"}）${r.name} v${r.version}` +
              (r.slots.length ? ` · 卡槽 ${r.slots.join("、")}` : "") +
              (r.loadable ? "" : " · ⚠ 该档加载器还没接"),
          ),
          scanned.errors.length ? `\n加载错误：${scanned.errors.join("；")}` : "",
          "\n要关掉某个：set_plugin_enabled；要删掉：uninstall_plugin。",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "set_plugin_enabled": {
        const id = String(args.id ?? "").trim();
        const enabled = args.enabled === true;
        if (!id) return "要指定插件 id（先 list_plugins 看一眼）。";
        const mf = this.pluginHost.manifestOf(id);
        if (!mf) return `没有这个插件：${id}`;
        /**
         * 停用永远允许；启用受档位约束。
         *
         * 为什么停用不受限：停用只会**减少**能力，不可能提权。
         * 启用则不同——L1 会重新在主进程/隔离进程里加载代码，那是能力扩张。
         * Q6 的约束是"她不得给自己的产物提权"，而"启用别人装的插件"不是给自己提权，
         * 但仍然要留痕：谁在什么时候打开了什么。
         */
        this.pluginSet.snapshot(enabled ? "enable-by-agent" : "disable-by-agent");
        this.pluginHost.setEnabled(id, enabled);
        if (mf.manifest.tier === "L1") {
          if (!enabled) this.l1.deactivate(id);
          else if (!this.pluginSet.isSafeMode()) {
            void this.l1
              .requestReload(id)
              .then((msg) => this.emit({ type: "tool", badge: "工具", title: `L1 插件 · ${id}`, body: msg }));
            void this.resetAgentHost();
          }
        }
        this.log("plugin_toggled_by_agent", { id, enabled, tier: mf.manifest.tier });
        this.card({
          kind: "system",
          badge: "工具",
          text: `${enabled ? "启用" : "停用"}了插件 ${id}（${mf.manifest.tier}）。`,
        });
        return `已${enabled ? "启用" : "停用"} ${id}。${enabled ? "新工具面下一轮生效。" : "它的工具已不可用。"}`;
      }
      case "uninstall_plugin": {
        const id = String(args.id ?? "").trim();
        if (!id) return "要指定插件 id（先 list_plugins 看一眼）。";
        const dir = this.pluginHost.dirOf(id);
        if (!dir) return `没有这个插件：${id}`;
        /**
         * 删除是**移到回收目录**而不是 rm：装错的插件可能是她自己写的，
         * 直接删掉就再也找不回来了。移走 = 用户随时能手工恢复，也留了审计线索。
         */
        const trash = path.join(this.dataRoot, "plugins-trash");
        fs.mkdirSync(trash, { recursive: true });
        const dest = path.join(trash, `${id}-${Date.now()}`);
        this.pluginSet.snapshot("uninstall-by-agent");
        this.pluginHost.setEnabled(id, false);
        if (this.pluginHost.manifestOf(id)?.manifest.tier === "L1") this.l1.deactivate(id);
        try {
          fs.renameSync(dir, dest);
        } catch (err) {
          return `删除失败（可能正被占用）：${err instanceof Error ? err.message : String(err)}`;
        }
        this.log("plugin_uninstalled_by_agent", { id, movedTo: dest });
        this.card({
          kind: "system",
          badge: "工具",
          text: `卸载了插件 ${id}。它的文件移到了 plugins-trash/，需要的话可以手工恢复。`,
        });
        return `已卸载 ${id}（文件移到 ${path.relative(this.dataRoot, dest)}，不是永久删除）。`;
      }
      case "list_plugin_versions": {
        const pid = String(args.id ?? "").trim();
        if (!pid) return "要指定插件 id（list_plugins 可查）。";
        const list = listVersions(this.dataRoot, pid);
        if (!list.length) return `${pid} 还没有历史版本（第一次更新之后才会出现）。`;
        return [
          `${pid} 有 ${list.length} 个历史版本（最多保留 ${KEEP_VERSIONS} 个，新的在前）：`,
          ...list.map((v) => `- ${v.dir} · v${v.version} · ${(v.bytes / 1024).toFixed(1)}KB · ${v.at}`),
          "",
          "要回滚到某个版本：rollback_plugin（当前版本会先归档，回滚本身也能再回滚）。",
        ].join("\n");
      }
      case "rollback_plugin": {
        const pid = String(args.id ?? "").trim();
        const vdir = String(args.versionDir ?? "").trim();
        if (!pid || !vdir) return "要同时给出插件 id 与历史版本目录名（list_plugin_versions 可查）。";
        const r = rollbackToVersion(this.dataRoot, pid, vdir);
        if (!r.ok) {
          return [`回滚失败。原因：`, ...r.issues.map((i) => `- [${i.stage}] ${i.message}`)].join("\n");
        }
        this.pluginSet.snapshot("rollback-by-agent");
        this.log("plugin_rollback_by_agent", { id: pid, to: r.version });
        this.card({ kind: "system", badge: "工具", text: `把插件 ${pid} 回滚到 v${r.version}。` });
        return `已把 ${pid} 回滚到 v${r.version}${r.archived ? `（原版本归档为 ${r.archived}，还能再换回来）` : ""}。`;
      }
      case "install_plugin": {
        const pkgPath = String(args.path ?? "").trim();
        if (!pkgPath) return "要给出插件包路径（.zip 文件或含 plugin.json 的目录）。";
        const res = importPluginPackage(pkgPath, this.dataRoot, { override: args.override === true });
        if (!res.ok) {
          /**
           * 失败时**逐条**列原因：`stage` 说明卡在哪一步（解包/布局/清单/入口/体积/冲突），
           * `message` 说明具体是什么。只说"导入失败"等于让用户去猜。
           */
          const lines = res.issues.map((i) => `- [${i.stage}] ${i.message}`);
          return [`插件包没有装进去。原因：`, ...lines, "", "按上面改，或把这段贴给插件的作者。"].join("\n");
        }
        this.pluginSet.snapshot("install-by-agent");
        this.log("plugin_installed_by_agent", { id: res.id });
        this.card({ kind: "system", badge: "工具", text: `安装了插件 ${res.id}。` });
        return `已安装 ${res.id}（落点 ${path.relative(this.dataRoot, res.dir ?? "")}）。用 list_plugins 看一眼，需要就 set_plugin_enabled 启用。`;
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
        this.log("draft_created_by_agent", { draftId: meta.draftId, tier: kind });
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

  /** worker stderr / RPC 错误进卡片与渲染事件前，先脱敏再限长，避免凭据落进会话持久层 */
  private reportRuntimeError(message: string): void {
    const safe = redactSecrets(String(message)).slice(0, 2_000);
    this.card({ kind: "system", text: `运行时错误：${safe}` });
    this.emit({ type: "error", message: safe });
  }

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
      model: {
        baseUrl: cfg.baseUrl,
        apiKey,
        model: cfg.model,
        provider: cfg.provider,
        // 真实窗口（2026-11-13 缓存审计）：Pi 按它决定压缩时机——硬编码 128K 会让
        // 百万窗口模型提前压缩（一次 = 前缀缓存全废 + 实测 41 万 token 全价重读）。
        // models.yaml 自定义优先，已知厂商查预设，未知不传（Pi 侧安全默认 128K）。
        contextWindow: this.resolveContextWindow(cfg.provider),
      },
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
      // 运行时错误必须进对话流：只发事件的话界面会一片空白（用户只看到自己那半句）
      onError: (message: string) => this.reportRuntimeError(message),
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
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.taskChangeTimer) {
      clearTimeout(this.taskChangeTimer);
      this.taskChangeTimer = null;
    }
    // 退出前把还没合并的删除消息落掉，别让一条「已删除」凭空消失
    this.flushRemovalCards();
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
    if (host) {
      this.cacheBreakReason = "host_restart";
      await host.stop().catch(() => undefined);
    }
  }

  /**
   * 流式复读熔断：模型退化时会把同一段话连打几百次（2026-11-11 实测 237 次 / 17.5K 字），
   * 正文与思考都必须盯。命中就截掉重复段、落卡说明、主动 abort 本轮，不靠用户点停止。
   */
  private guardRepetition(): void {
    if (this.repetitionAborted || !this.liveCard) return;
    const live = this.liveCard;
    const text = live.text ?? "";
    const thinking = live.thinking ?? "";
    const len = text.length + thinking.length;
    // 每 400 字扫一次尾巴（成本只有 window×maxUnit，实测可忽略）；间隔别放大——
    // 复读止损靠的就是"早发现"，拉长间隔会让它多吐上千字才截断。
    if (len - this.lastRepetitionScan < 400) return;
    this.lastRepetitionScan = len;
    const parts: { kind: string; value: string }[] = [
      { kind: "正文", value: text },
      { kind: "思考", value: thinking },
    ];
    for (const part of parts) {
      const hit = detectTrailingRepetition(part.value);
      if (!hit) continue;
      this.repetitionAborted = true;
      const kept = stripTrailingRepetition(part.value, hit);
      if (part.kind === "正文") live.text = kept;
      else live.thinking = kept;
      this.notify({ type: "delta", text: live.text, thinking: live.thinking, cardId: live.id });
      this.card({
        kind: "system",
        badge: "已拦截",
        text: `模型在${part.kind}里连续重复同一段内容 ${hit.repeats} 次（约 ${hit.chars} 字），已自动停止本轮，前文保留。` +
          `这通常是长上下文或任务卡住后的退化：建议新建会话把任务拆小，或换个模型再试。`,
      });
      this.log("repetition_aborted", { mode: part.kind, repeats: hit.repeats, chars: hit.chars });
      void this.host?.abort().catch(() => undefined);
      this.chatAbort?.abort();
      return;
    }
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
      // 思考封顶（2026-11-16）：实机一条思考 13739 字，每 80ms 全量推给渲染层 → 界面发涩
      if (this.liveCard.thinking.length > 12_000) {
        const t = this.liveCard.thinking;
        this.liveCard.thinking = `${t.slice(0, 3000)}\n…（中间 ${t.length - 9000} 字已折叠）…\n${t.slice(-8000)}`;
      }
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
    if (typeof delta === "string" || typeof thinkingDelta === "string") this.guardRepetition();
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
    return [...COMPACT_TOOL_JSON, ...extra];
  }

  /**
   * 巡检轮的工具面（2026-11-17 P2-1b）：**内容与顺序完全固定**，只去掉组织类工具。
   *
   * 实测量化：全套 20 件序列化 6,781 字符 ≈ 2,211 tokens；巡检 491 次调用光是"带一套用不上的
   * 工具说明"就付了上百万 tokens。巡检回合只做三件事——看工单、看编制、必要时催/停，
   * 从不建队、不招人、不解散、不发插件、不写插件草稿、不删记忆（这几件只在用户主动说起时发生，
   * 那时候走的是普通回合）。
   *
   * 保留名单是白名单而不是黑名单：新增工具默认不进巡检（新工具大概率是给正常回合用的），
   * 要进巡检必须在这里显式加一行，避免悄悄把工具面撑大。
   */
  private patrolTools(): ToolSchema[] {
    const keep = new Set([
      "assign_task",
      "check_progress",
      "check_roster",
      "read_artifact",
      "review_result",
      "accept_or_reject",
      "report_to_user",
      "ask_user",
      "nudge_member",
      "reply_member",
      "stop_task",
      "read_memory",
      "set_group_notice",
    ]);
    const extra = [...this.l1.toolSchemas(), ...this.mcp.schemas()].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
    return [...COMPACT_TOOL_JSON.filter((t) => keep.has(t.function.name)), ...extra];
  }

  /** 工具面里实际有哪些名字（诊断/测试用） */
  toolNames(): string[] {
    return this.allTools().map((t) => t.function.name);
  }

  /**
   * 上一轮 system prompt 的段落构成（诊断/测试用，2026-11-17 P2-1c）。
   * 只读快照：回答"现在多少字、哪一段最贵"，不必再打印整段提示词。
   * 调用一次 systemPrompt() 保证有值（未跑过对话时也不会拿到空）。
   */
  promptSegments(): { name: string; chars: number }[] {
    this.systemPrompt();
    return this.lastPromptSegments.map((s) => ({ name: s.name, chars: s.chars }));
  }

  /** 系统生成工单 ID：不透明、可排序，避免模型把「失败复盘」当 id 自造 */
  private nextTaskId(): string {
    this.taskSeq += 1;
    return `task-${Date.now().toString(36)}-${this.taskSeq.toString(36)}`;
  }

  /**
   * 新会话第一句闸：只有 1 条用户消息，且短到不像明确委托时，不允许直接建队派单。
   * 目的：记忆里的旧失败/旧任务不能把一句「随便聊聊」变成新工单。
   * 模型收到提示后应先用 ask_user 确认，用户确认（第二轮）后自然放行。
   */
  private looksLikeExplicitTaskRequest(): boolean {
    const users = this.history.filter((m) => m.role === "user");
    if (users.length !== 1) return true;
    const text = String(users[0].content ?? "").trim();
    if (!text) return false;
    if (text.length >= 24) return true;
    return /(帮我|请|需要|整理|生成|做|写|查|分析|核对|修复|调研|导出|转|抓|下载|测试|部署|审|对比|总结|翻译|爬|建|改|优化|跑|算)/.test(text);
  }

  /**
   * 团队主键解析（§4.10.3 修正：主键由系统管，不是用户输入项）。
   * 显式给了且存在 → 用它；否则只有一支在职队 → 隐式绑它；都没有 → undefined（交给自动建队）。
   */
  private resolveTeamId(explicit?: string): string | undefined {
    const wanted = (explicit ?? "").trim();
    if (wanted && this.teamStore.teamExists(wanted)) return wanted;
    // 本群优先（2026-11-12 群聊模式）：一个群 = 一支班底。
    // 本群已有工单或已绑队时，就用本群的队——否则同一群里会冒出两支队，
    // 用户在右栏看到"本群"下面挂着两拨人，还以为有两件事在办。
    const groupTeams = this.groupTeamIds();
    if (groupTeams.length) return groupTeams[0];
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
   * 本群的队伍 id（显式绑定 + 本群工单所属）。
   * "本群成员""其他团队折叠"都以它为准——不再靠"最近一张单来自当前会话"猜。
   */
  private groupTeamIds(): string[] {
    const out = new Set<string>();
    for (const t of this.taskStore.list()) {
      if (t.threadId === this.currentThreadId && t.teamId) out.add(t.teamId);
    }
    for (const team of this.teamStore.activeTeams()) {
      if (team.threadId && team.threadId === this.currentThreadId) out.add(team.id);
    }
    return [...out];
  }

  /** 把队绑到当前群（建队时顺手做；已绑的不动） */
  private bindGroup(teamId: string): void {
    if (!this.currentThreadId) return;
    try {
      this.teamStore.bindThread(teamId, this.currentThreadId);
    } catch {
      /* 队读不到就跳过：绑定只是锦上添花，不能因此炸掉派单 */
    }
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
    this.bindGroup(created.id);
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

  /**
   * 直连单次调用的记账（2026-11-17）：主循环与「触顶补总结」共用同一份口径。
   * 口径：sessionIn = 未命中量；cacheRead/cacheWrite 单独累计（DeepSeek 的 miss 已在 promptTokens 里）。
   */
  private recordDirectUsage(
    result: Awaited<ReturnType<typeof streamChatWithRetry>>,
    opts: { patrol: boolean; usedModel: string },
  ): void {
    this.tokensUsed += result.promptTokens + result.completionTokens;
    const hit = Math.max(0, result.cacheRead);
    const write = Math.max(0, result.cacheWrite);
    const unhit = Math.max(0, result.promptTokens - hit - write);
    const turnPrompt = result.promptTokens + write;
    const turnHitRate = turnPrompt > 0 ? Math.round((hit / turnPrompt) * 1000) / 10 : null;
    if (opts.patrol) {
      // 巡检轮：只记单独的累计，不动 Pi 会话的 usage（下一轮 runChatRpc 会合并展示）
      this.patrolUsage.in += unhit;
      this.patrolUsage.out += result.completionTokens;
      this.patrolUsage.read += hit;
      this.patrolUsage.write += write;
      this.setUsage({ turnIn: result.promptTokens, turnOut: result.completionTokens, turnHitRate });
      this.log("usage_patrol", {
        in: result.promptTokens,
        out: result.completionTokens,
        cacheRead: hit,
        cacheWrite: write,
        hitRate: turnHitRate,
      });
    } else {
      this.setUsage({
        turnIn: result.promptTokens,
        turnOut: result.completionTokens,
        sessionIn: this.usage.sessionIn + unhit,
        sessionOut: this.usage.sessionOut + result.completionTokens,
        cacheRead: this.usage.cacheRead + hit,
        cacheWrite: this.usage.cacheWrite + write,
        turnHitRate,
        contextTokens: this.usage.contextTokens + result.promptTokens + result.completionTokens,
      });
      this.log("usage_direct", {
        in: result.promptTokens,
        out: result.completionTokens,
        cacheRead: hit,
        cacheWrite: write,
        cacheMiss: result.cacheMiss,
        hitRate: turnHitRate,
        source: "direct",
        cacheFieldsReported: result.cacheFieldsReported,
        cacheBreakReason: this.cacheBreakReason,
      });
    }
    // 按次记账（M2-11）+ 软上限检查（达限提示/可切备用模型；不静默停机）
    appendUsage(this.dataRoot, {
      at: new Date().toISOString(),
      kind: "turn",
      in: result.promptTokens,
      out: result.completionTokens,
      model: opts.usedModel,
      cacheRead: hit,
      cacheWrite: write,
      source: "direct",
      cacheFieldsReported: result.cacheFieldsReported,
      cacheBreakReason: this.cacheBreakReason,
    });
    this.cacheBreakReason = null;
    this.checkBudget();
  }

  /** 落一轮助手回复（两条路径共用，顺序固定：history → 落盘 → 卡片收尾） */
  private settleAssistant(live: FeedCard, text: string): void {
    if (text.trim()) {
      // 写作规则（2026-11-15 重做）：卡片、history、落盘用同一份原文。
      // 曾经的展示层过滤已删除——三处不一致会让「出问题能复核」这件事失效。
      live.text = text;
      this.history.push({ role: "assistant", content: text });
      // 巡检轮的助手回复也不落时间线：它只服务这一轮，不进长期上下文
      if (this.ephemeralFrom < 0) this.persist("assistant", text);
      this.patchCard(live, { streaming: false });
      // 巡检轮（心跳/卡住处置）不念：那是她自己在盘账，不是给用户的汇报
      this.voice?.sayReply(live.text ?? text, this.ephemeralFrom >= 0);
    } else {
      /**
       * 本轮一个字都没说（2026-11-13 实机）：模型只出了思考就结束，界面上留下
       * 「思考 1186 字」+ 一个空气泡，用户看到的就是"啥也没有"。
       * 就地改写成一行如实状态——不要再新落一张卡把这张空的留在中间。
       */
      live.kind = "system";
      live.systemTone = "notice";
      live.thinking = undefined;
      live.text = "这一轮没有产出文字（只做了动作）。结果见上方卡片。";
      this.patchCard(live, {
        kind: "system",
        systemTone: "notice",
        thinking: undefined,
        text: live.text,
        streaming: false,
      });
    }
    /**
     * 她这一轮的话 = 本轮的结论，必须排在**动作之后**（2026-11-13 实机）：
     * 卡片在回合开始就创建，她自己的验收/派单卡全落在它下面，于是"结论"被夹在中间；
     * 成员一多回报，她的话就被顶到上面看不见了。收轮时把这张卡挪到末尾。
     */
    this.moveCardToEnd(live);
    // 验收归档了却没有汇报 → 用户只看到一堆过程卡。按卷宗事实补一张如实汇总。
    this.flushFinalReport();
  }

  /** 把一张卡挪到 feed 末尾（顺序靠下一次权威快照生效：done/error 会触发整表重拉） */
  private moveCardToEnd(card: FeedCard): void {
    const i = this.feed.indexOf(card);
    if (i < 0 || i === this.feed.length - 1) return;
    this.feed.splice(i, 1);
    this.feed.push(card);
    this.persistThreadSoon();
    this.log("card_moved_to_end", { id: card.id, from: i, to: this.feed.length - 1 });
  }

  /**
   * 兜底汇报（2026-11-13）：她验收通过并归档了，但整轮没调 report_to_user。
   * 这不是"替她说话"——内容全部来自权威工单（标题/成员/交付物/验收结论），
   * 且卡上标明是系统按卷宗汇总，用户可以据此判断要不要打开产物。
   */
  private flushFinalReport(): void {
    const pending = this.pendingFinalReport;
    this.pendingFinalReport = null;
    if (!pending || this.reportedThisTurn) return;
    const rec = this.taskStore.get(pending.taskId);
    if (!rec) return;
    const files = (rec.deliverables ?? []).map((d) => d.path.split(/[\\/]/).filter(Boolean).pop() ?? d.path);
    const bytes = (rec.deliverables ?? []).reduce((sum, d) => sum + (d.bytes ?? 0), 0);
    /**
     * 播报要能追溯（2026-11-16 实机「播报单薄，只报成员名字」）：
     * 一句"XX 交的活已验收"等于没说——用户要的是"做完了什么、交了几件、花了多久、还差什么"。
     * 这里全部取卷宗事实（轮次 / 耗时 / 产物 / 证据），一个数都不编。
     */
    const timeline = this.trackTimeline(rec.id).timeline;
    const first = timeline[0]?.at ? Date.parse(timeline[0].at) : NaN;
    const last = timeline[timeline.length - 1]?.at ? Date.parse(timeline[timeline.length - 1].at) : NaN;
    const spanMin = Number.isFinite(first) && Number.isFinite(last) && last > first ? Math.round((last - first) / 60_000) : 0;
    const rounds = (rec.rejectRounds ?? 0) + 1;
    const evCount = rec.evidence?.length ?? 0;
    const sizeText = bytes > 0 ? ` · 约 ${Math.max(1, Math.round(bytes / 1024))} KB` : "";
    const filesLine = files.length
      ? `**交付物**：${files.join("、")}（${files.length} 件${sizeText}；在交付箱里点开就能看）\n`
      : "**交付物**：（这张单没有留交付物——如果需要文件，让她补一份）\n";
    const statBits = [
      `第 ${rounds} 轮`,
      spanMin > 0 ? `约 ${spanMin} 分钟` : "",
      evCount > 0 ? `证据 ${evCount} 项` : "",
    ].filter(Boolean);
    this.card({
      kind: "tool",
      badge: "汇报",
      jobId: rec.id,
      title: `系统汇总 · ${rec.title.slice(0, 40)}`,
      // 完成播报要说清"哪件事做完了 + 交了几件"，不是「这张单已归档」这种过程话
      speak: `「${rec.title.slice(0, 30)}」做完了，${pending.member}交的活我已验收归档${
        files.length ? `，${files.length} 件产物在交付箱` : ""
      }。`,
      body:
        `**结论**：${pending.member} 交付的「${rec.title.slice(0, 60)}」已验收归档（${statBits.join(" · ")}）。\n` +
        filesLine +
        `**未完成**：${
          pending.member
            ? "（她没有单独写汇报，以上是卷宗里的实据）需要细节直接在群里问她这张单。"
            : "（这张单没有登记成员）"
        }`,
    });
  }

  private async runChatRpc(userText: string): Promise<void> {
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    this.liveCard = live;
    this.lastModelError = null;
    this.turnErrorReported = false;
    this.repetitionAborted = false;
    this.lastRepetitionScan = 0;
    this.progressPolls.clear();
    // 展示值是「Pi 主会话 + 巡检轮」合并后的累计；算单轮增量时要扣掉巡检部分，
    // 否则下一轮 Pi 会把巡检轮的量当成自己这一轮的暴涨（假 turnHitRate）。
    const beforeIn = Math.max(0, this.usage.sessionIn - this.patrolUsage.in);
    const beforeOut = Math.max(0, this.usage.sessionOut - this.patrolUsage.out);
    const beforeCacheRead = Math.max(0, this.usage.cacheRead - this.patrolUsage.read);
    const beforeCacheWrite = Math.max(0, this.usage.cacheWrite - this.patrolUsage.write);
    // 从收到指令那一刻就开始计时：避免冷启动/首 token 期间界面完全静默
    this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
    try {
      const host = await this.ensureHost();
      // 人设/记忆/技能注入每轮现取：官方扩展在 before_agent_start 重读文件，天然热更新
      await host.updateSystemPrompt(this.systemPrompt());
      this.setTurn({ phase: "accepted", busy: true });
      /**
       * 技能正文已在 submitTurn 里拼进 history（缓存修复 B1），这里**不能再拼一次**：
       * 再拼就与历史不一致，下一轮重建时那条 user 消息变短 → 前缀断。
       */
      const outgoing = userText;
      // 官方 prompt 的响应只代表被接受；PiRpcHost.prompt() 会等到官方 agent_settled
      const promptResult = await host.prompt(outgoing);
      this.log("prompt_ok", { disposition: promptResult?.disposition ?? "started" });
      if (this.abortRequested) {
        this.card({ kind: "system", text: "已停止（已产出的内容保留）。" });
      }
      // 模型报错但一个字都没产出时，必须给错误卡，不能留下空气泡当作"不回复"
      // （错误由 onAgentEvent 写入，TS 不跨方法追踪属性 narrowing，这里显式收成局部变量）
      const modelError = this.lastModelError as string | null;
      if (modelError && !(live.text ?? "").trim() && !this.repetitionAborted) {
        const safeModelError = redactSecrets(modelError);
        const fail = this.classifyError(new Error(safeModelError));
        this.failTurn(fail.code, `${fail.message}（端点原文：${safeModelError.slice(0, 160)}）`, fail.action);
        return;
      }
      this.settleAssistant(live, live.text ?? "");
      // 用量以 Pi 的 session stats 为准（含缓存与上下文占比），不自估
      const stats = await host.stats();
      if (stats) {
        // Pi 的 stats 是会话累计值：单轮命中率必须用「本轮增量」算，不能拿累计值冒充
        const dIn = Math.max(0, stats.tokens.input - beforeIn);
        const dRead = Math.max(0, (stats.tokens.cacheRead ?? 0) - beforeCacheRead);
        const dWrite = Math.max(0, (stats.tokens.cacheWrite ?? 0) - beforeCacheWrite);
        const turnPrompt = dIn + dRead + dWrite;
        const turnHitRate = turnPrompt > 0 ? Math.round((dRead / turnPrompt) * 1000) / 10 : null;
        this.setUsage({
          sessionIn: stats.tokens.input + this.patrolUsage.in,
          sessionOut: stats.tokens.output + this.patrolUsage.out,
          turnIn: dIn,
          turnOut: Math.max(0, stats.tokens.output - beforeOut),
          cacheRead: (stats.tokens.cacheRead ?? 0) + this.patrolUsage.read,
          cacheWrite: (stats.tokens.cacheWrite ?? 0) + this.patrolUsage.write,
          turnHitRate,
          cost: stats.cost ?? 0,
          contextTokens: stats.contextTokens,
          contextWindow: stats.contextWindow,
          contextPercent: stats.contextPercent ?? null,
        });
        // 缓存命中可观测：累计与单轮都落一行，命中率掉时能回查到哪一轮
        {
          const prompt = stats.tokens.input + (stats.tokens.cacheRead ?? 0) + (stats.tokens.cacheWrite ?? 0);
          const dOut = Math.max(0, stats.tokens.output - beforeOut);
          // 命中率掉下来时，能分清是切群/重建进程/冷启动，还是"原因不明"
          // 冷启动只在「会话一条输入都没记过」时判定：用 beforeCacheRead===0 会把
          // 第 2 轮（首轮没命中、次轮已 96%）也误标成 cold_start，回查时误导。
          const breakReason =
            this.cacheBreakReason ?? (beforeIn === 0 && beforeOut === 0 && stats.tokens.input > 0 ? "cold_start" : null);
          this.log("usage_round", {
            in: stats.tokens.input,
            out: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead ?? 0,
            cacheWrite: stats.tokens.cacheWrite ?? 0,
            hitRate: prompt > 0 ? Math.round(((stats.tokens.cacheRead ?? 0) / prompt) * 1000) / 10 : null,
            turnHitRate,
            source: "pi",
            // Pi 只给归一化后的 stats，拿不到"端点有没有回报缓存字段"——明确写 null，不假装知道
            cacheFieldsReported: null,
            cacheBreakReason: breakReason,
          });
          // 按次台账（2026-11-14）：以前只有直连路径写 usage.jsonl，生产主力 Pi 路径线上查不到。
          // 这里必须记**本轮增量**（dIn/dRead/dWrite），不能把 stats 的会话累计值逐行再写一遍。
          appendUsage(this.dataRoot, {
            at: new Date().toISOString(),
            kind: "turn",
            in: turnPrompt,
            out: dOut,
            model: this.activeModelId() ?? "pi",
            cacheRead: dRead,
            cacheWrite: dWrite,
            source: "pi",
            cacheFieldsReported: null,
            cacheBreakReason: breakReason,
          });
          this.cacheBreakReason = null;
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

  /**
   * 直连路径：Pi 不可用时仍可用；2026-11-13 起也是**巡检轮专用路径**——
   * 它的 history 归内核管，ephemeral 收尾时 splice 真删；Pi 主会话完全不收巡检轮。
   * patrol=true 时用量记到 patrolUsage，不混入 Pi 的会话累计（否则下一轮被 stats 覆盖丢失）。
   */
  private async runChatDirect(
    cfg: NonNullable<ReturnType<SettingsStore["getModel"]>>,
    apiKey: string,
    /** 当轮真正要发给模型的消息（含群内定向说明）；只改当轮，历史前缀不动 */
    userText?: string,
    patrol = false,
  ): Promise<void> {
    this.repetitionAborted = false;
    this.lastRepetitionScan = 0;
    this.progressPolls.clear();
    // 软上限降级（M2-11）：达软限且有备用模型就换；没有就如实提示继续用（不静默停机）
    const budget = evaluateBudget(this.usage.sessionIn + this.usage.sessionOut, this.settings.getPrefs().softBudgetTokens);
    const picked = pickModel(cfg, this.settings.getPrefs().fallbackModel, budget.mode);
    if (picked.note) this.card({ kind: "system", badge: "工具", title: "预算提示", body: picked.note });
    const usedModel = picked.model;
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    this.liveCard = live;
    this.setTurn({ activity: "model", activityName: undefined, activityAt: Date.now() });
    // 本回合取消器：session.abort 直接 abort()，fetch 与 SSE body 立即断开
    const controller = new AbortController();
    this.chatAbort = controller;
    let attempts = 1;
    let retryNotified = false;
    const patchLive = (text: string, streaming: boolean) => {
      live.text = text;
      live.streaming = streaming;
      const now = Date.now();
      if (streaming && now - this.lastDeltaEmit >= DELTA_FRAME_MS) {
        this.lastDeltaEmit = now;
        // cardId 必须带：渲染层只认带 cardId 的 delta，否则降级路径等于没有流式
        this.notify({ type: "delta", text, cardId: live.id });
      }
      if (streaming) this.guardRepetition();
    };
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt() }, ...this.history];
    // 群内定向说明只改当轮 user 消息（尾部）：历史前缀原样，缓存命中不被 @ 抖动打穿
    if (userText) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "user") {
          messages[i] = { role: "user", content: userText };
          break;
        }
      }
    }
    // 技能正文已在 submitTurn 拼进 history（缓存修复 B1），这里不再二次拼接，
    // 否则发送内容与历史不一致，下一轮重建就会变短、前缀缓存断掉。
    const endpointHost = (() => {
      try {
        return new URL(cfg.baseUrl).host;
      } catch {
        return cfg.baseUrl;
      }
    })();
    try {
      const maxRounds = patrol ? this.patrolRounds() : this.agentRounds();
      /**
       * 本回合固定的工具面（2026-11-17 B5）：循环内外都用同一份，前缀不因末轮而变。
       * 巡检回合用精简面（不建队/不招人/不解散/不发插件/不写草稿/不删记忆），其余用全量。
       */
      const toolList = patrol ? this.patrolTools() : this.allTools();
      /** 本回合消息的起点：折叠只折这之后的工具往返，历史前缀原样（缓存不被折碎） */
      const foldFrom = messages.length;
      for (let round = 0; round < maxRounds; round++) {
        /**
         * 巡检轮折叠（2026-11-16）：实测巡检平均每回合跑 11.4 次模型调用，
         * 每次都要重放本回合前面所有工具输出（单次 in 从 6.6K 涨到 46K）。
         * 只折 patrol 且只折本回合新增：主会话的历史前缀是缓存主体，折它会按全价重算，反而更贵。
         */
        if (patrol && round === Math.floor(maxRounds / 2)) {
          /**
           * 巡检只在**回合中段折一次**（2026-11-17 缓存修复 B2）。
           * 每轮折 = 每轮一个断点；巡检最多 10 轮，折一次就能把前半段的工具输出压掉，
           * 后半个回合的前缀保持稳定。
           */
          const comp = compactToolHistory(messages, { keepRecent: compactKeepRecent(), fromIndex: foldFrom });
          if (comp.folded > 0) messages.splice(0, messages.length, ...comp.messages);
        }
        let roundText = "";
        /**
         * 工具面**全程不变**（2026-11-17 缓存修复 B5）。
         *
         * 此前末轮改成 `tools: []`：工具段在请求最前，一变就让该次请求的前缀全量重算
         * （实测每次 30–40K），而且巡检回合几乎每次都会跑到末轮。
         * 现在收口改由「跑满轮次后补一次只总结」完成（见循环之后），
         * 所有请求的工具面保持一致，缓存不再被自己换掉。
         */
        /**
         * 前缀指纹（P1-5）：命中率掉下来时，日志能直接回答"从哪一轮、因为什么变了"。
         * 只在变化时记一条，不刷屏。
         */
        const fp = prefixFingerprint({ messages, tools: toolList });
        if (this.lastPrefixFp && this.lastPrefixFp !== fp) {
          this.log("cache_prefix_changed", {
            from: this.lastPrefixFp,
            to: fp,
            reason: this.cacheBreakReason ?? "unknown",
            round,
            messages: messages.length,
          });
        }
        this.lastPrefixFp = fp;
        const result = await streamChatWithRetry(
          {
            baseUrl: cfg.baseUrl,
            apiKey,
            model: usedModel,
            messages,
            tools: toolList,
            signal: controller.signal,
            onDelta: (t) => {
              roundText += t;
              patchLive(roundText, true);
            },
          },
          {
            maxAttempts: 3,
            onRetry: ({ attempt, status, delayMs }) => {
              attempts = attempt + 1; // 失败也要如实说「重试过几次」，不能只在成功时更新
              this.log("llm_retry", { attempt, status, delayMs, model: usedModel, endpoint: endpointHost });
              if (!retryNotified) {
                retryNotified = true;
                this.card({
                  kind: "system",
                  text: `模型暂时不可用${status ? `（HTTP ${status}）` : ""}，${Math.round(delayMs)}ms 后自动重试；已产出的内容不会丢。`,
                });
              }
            },
          },
        );
        attempts = result.attempts;
        this.recordDirectUsage(result, { patrol, usedModel });
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
      /**
       * 触顶补一次「只总结」（2026-11-17 缓存修复 B5）。
       *
       * 跑满 maxRounds 仍未落总结时，追加一条"别再调工具"的指示再请求一次。
       * 关键：**这次也带全量工具面**——空工具集会让工具段消失、该次前缀全量重算；
       * 用提示词收口，语义一样，缓存不断。若模型仍返回工具调用，不执行，直接收尾。
       */
      let summaryText = "";
      const summary = await streamChatWithRetry(
        {
          baseUrl: cfg.baseUrl,
          apiKey,
          model: usedModel,
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "工具轮次已用尽：不要再调用工具，直接给出最终答复或总结（写清做到了哪一步、还差什么，需要继续就让用户说「继续」）。",
            },
          ],
          tools: toolList,
          signal: controller.signal,
          onDelta: (t) => {
            summaryText += t;
            patchLive(summaryText, true);
          },
        },
        { maxAttempts: 2 },
      );
      this.recordDirectUsage(summary, { patrol, usedModel });
      const finalText = summary.content?.trim() || summaryText.trim();
      this.settleAssistant(
        live,
        finalText || "（本轮工具轮次已用尽，风铃先总结到这里；需要继续就直接说「继续」。）",
      );
      this.settleCheckpoint();
      this.emit({ type: "done", tokens: summary.promptTokens + summary.completionTokens });
    } catch (err) {
      // 用户主动停止：只收掉流状态，保留已产出文本；session.abort 已经发过 done，不再报错误
      if (controller.signal.aborted || this.abortRequested) {
        this.patchCard(live, { streaming: false });
        return;
      }
      const fail = this.classifyError(err);
      const status = err instanceof LlmError ? err.status : undefined;
      const retryNote = attempts > 1 ? `已自动重试 ${attempts - 1} 次仍未成功` : "未触发自动重试";
      // 错误卡要能行动：状态码、端点、重试情况、下一步动作，不再是泛泛一句「服务端错误」
      const message = `${fail.message}${status ? `（HTTP ${status}）` : ""} 端点：${endpointHost}。${retryNote}；可点「重试」再发一次，或去设置检查端点/Key。`;
      if (!live.text) live.text = message;
      this.patchCard(live, { streaming: false, code: fail.code });
      this.failTurn(fail.code, message, fail.action);
    } finally {
      if (this.chatAbort === controller) this.chatAbort = null;
      if (this.liveCard === live) this.liveCard = null;
      this.setTurn({ activity: undefined, activityName: undefined, activityAt: undefined });
    }
  }

  /**
   * 提交一轮：卡片 + 落史 + 回合状态 + 结束后排水（排队输入）。
   * `internal`：巡检回合——不进「你」的声音、不改会话标题，用户看到的是那张「开始跟进」卡。
   */
  private submitTurn(
    text: string,
    att?: TurnAttachments,
    opts?: { internal?: boolean; ephemeral?: boolean; mentions?: FeedMention[] },
  ): void {
    // 会话可以一条不剩：这时候开口说话，就地开一条再写，不用先点「新建会话」
    this.ensureThreadId();
    // 新一轮：汇报标记归零（收轮时按这两枚标记决定要不要补系统汇总）
    this.reportedThisTurn = false;
    this.pendingFinalReport = null;
    // 技能激活（M2-10）：每轮按输入重算，命中后 allowed-tools 强制到工具门禁。
    // 巡检轮跳过：它的目标是"看一眼就走"的机器事实，不该被技能正文占体积或被 allowed-tools 收窄。
    if (opts?.ephemeral) {
      this.activeSkills = [];
      this.pendingSkillText = "";
    } else {
      this.activateSkillsFor(text);
      // 魔法词（2026-11-14）：`ultrathink` / `chillax` / `orchestrate` 只影响这一轮。
      // 与技能正文走同一通道（当轮消息尾部），不进 system prompt、不落盘。
      const magic = magicWordsNotice(text);
      if (magic) this.pendingSkillText = this.pendingSkillText ? `${this.pendingSkillText}\n\n${magic}` : magic;
    }
    // 群内 @（2026-11-12）：只认本群成员，陌生名字已被 resolveMentions 丢掉
    const mentions = opts?.mentions ?? [];
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
        author: { kind: "user" },
        mentions: mentions.length ? mentions : undefined,
        meta: built.pieces.length ? `随附 ${built.pieces.map((p) => p.label).join("、")}` : undefined,
      });
    } else {
      this.card({
        kind: "user",
        text,
        author: { kind: "user" },
        mentions: mentions.length ? mentions : undefined,
      });
    }
    /**
     * 发送什么就存什么（2026-11-17 缓存修复 B1）。
     *
     * 此前：history 存原话，runChat 里临时拼「技能正文 + 群定向」再发。
     * 下一轮从 history 重建请求时那条 user 变短 → 从它起前缀缓存全部失效。
     * 技能命中率实测 35%，等于每三次对话就人为断一次，成员命中率被压到 81.5%。
     * 现在：落盘前一次拼好，runChat 不再二次装饰。
     */
    // 技能正文与记忆变更提示走同一通道（当轮尾部、进 history，不改 system 前缀）
    const tailNotes = [this.pendingSkillText, this.pendingMemoryNote].filter(Boolean).join("\n\n");
    const finalText = composeTurnText({
      fullText,
      directive: mentions.length ? this.groupDirective(mentions) : undefined,
      skillText: tailNotes,
    });
    this.pendingSkillText = "";
    this.pendingMemoryNote = "";
    // 巡检轮（心跳/卡住处置）：消息只用于这一轮，结束后从 history 摘掉、不写时间线。
    // 否则每 5 分钟一次巡检会把上下文越撑越大（token 与延迟都跟着涨）。
    if (opts?.ephemeral) this.ephemeralFrom = this.history.length;
    this.history.push({ role: "user", content: finalText });
    if (!opts?.ephemeral) this.persist("user", finalText);
    this.busy = true;
    this.l1.setBusy(true);
    this.abortRequested = false;
    this.log("turn_start", { chars: text.length, model: this.activeModelConfig()?.model ?? "", modelId: this.activeModelId() ?? "default", threadId: this.currentThreadId, internal: !!opts?.internal });
    if (!opts?.internal) this.threads.autoTitle(this.currentThreadId, text);
    this.checkpoints.begin(`turn-${Date.now()}`);
    this.setTurn({ phase: "accepted", busy: true, startedAt: new Date().toISOString(), canUndo: false, changedFiles: [] });
    void this.runChat(finalText, opts).finally(() => {
      // 巡检轮收尾：把这轮消息（含工具往返）从 history 摘掉，上下文回到巡检前
      if (this.ephemeralFrom >= 0) {
        this.history.splice(this.ephemeralFrom);
        this.ephemeralFrom = -1;
      }
      this.busy = false;
      this.l1.setBusy(false);
      const phase: TurnPhase = this.turn.phase === "failed" ? "failed" : "idle";
      this.setTurn({ phase, busy: false, startedAt: undefined });
      this.drainQueue();
      // 成员回报后要验收的：这轮收尾了就叫醒风铃（不等心跳闸）
      this.drainReviewPending();
      // 成员在群里提的疑问/风险：同样在收轮后再答，别插进用户正在说的话中间
      this.drainQuestionPending();
      // 忙时被挡下的心跳事件：这一轮（或队列）收尾后再评估一次；闸仍然生效，不会补成刷屏
      if (this.heartbeatPending) {
        const pending = this.heartbeatPending;
        this.heartbeatPending = null;
        this.requestHeartbeat(`resume:${pending}`);
      }
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
    this.submitTurn(next.text, next.attachments, { mentions: next.mentions });
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

  /**
   * 记一次额度用尽并进入熔断。退避 5 → 10 → 20 → 30 分钟；恢复后成功一次即清零。
   * 5 分钟内只落一张卡：熔断期本来就该安静，刷屏只会让人更慌。
   */
  private noteQuotaExhausted(detail: string): void {
    this.quotaStrikes = Math.min(4, this.quotaStrikes + 1);
    const minutes = [5, 10, 20, 30][this.quotaStrikes - 1] ?? 30;
    this.quotaBlockedUntil = Date.now() + minutes * 60_000;
    this.log("quota_cooldown", { minutes, strikes: this.quotaStrikes, detail: detail.slice(0, 200) });
    if (Date.now() - this.quotaCardAt < 5 * 60_000) return;
    this.quotaCardAt = Date.now();
    this.card({
      kind: "system",
      systemTone: "budget",
      title: "额度用尽，已暂停自动巡检",
      text:
        `端点回的是额度上限/欠费类错误（${detail.slice(0, 120)}）。` +
        `已暂停心跳巡检、验收叫醒与自动派单 ${minutes} 分钟——继续重试只会把请求配额也烧掉。` +
        "恢复额度后直接发一条消息即可继续（你的消息不受熔断限制）。",
    });
  }

  /** 额度还在冷却里：后台动作（心跳/叫醒/派单/顾问）一律不发请求 */
  private quotaCoolingDown(): boolean {
    return Date.now() < this.quotaBlockedUntil;
  }

  /**
   * 同一张单的连续失败计数（2026-11-16 日志复盘）。
   * 实机出现过同一 taskId 被跑 6 次（每次中途被超时/中止砍断后整单重来），
   * 单次成本是几十万 prompt tokens。连续失败到阈值就先拦住重派，逼一次人工判断。
   */
  private taskFailStreak = new Map<string, { n: number; at: number }>();

  /** 重派前检查：这张单是不是已经烧了太多次 */
  private taskRepickBlocked(taskId: string): string | null {
    const s = this.taskFailStreak.get(taskId);
    if (!s || s.n < 3) return null;
    if (Date.now() - s.at >= 30 * 60_000) {
      this.taskFailStreak.delete(taskId);
      return null;
    }
    return (
      `这张单最近 30 分钟已连续失败 ${s.n} 次（超时/中止）：先别原地重派。` +
      "看一下卷宗里它做到哪一步、卡在哪（或是把任务拆小 / 换人 / 换法），" +
      "确认要重试就等 30 分钟后再派——重复跑同一份简报只会把同样的钱再烧一遍。"
    );
  }

  private noteTaskFailure(taskId: string, status: string): void {
    if (status === "reported") {
      this.taskFailStreak.delete(taskId);
      return;
    }
    // 用户主动停 / 群终止不算"这张单做不成"——那是外部停止，重派是合理动作
    if (status === "aborted") return;
    const prev = this.taskFailStreak.get(taskId);
    const n = (prev && Date.now() - prev.at < 30 * 60_000 ? prev.n : 0) + 1;
    this.taskFailStreak.set(taskId, { n, at: Date.now() });
    if (n >= 3) this.log("task_fail_streak", { taskId, n });
  }

  /** 一次成功即视为额度恢复（端点能用就说明额度回来了） */
  private noteQuotaOk(): void {
    if (!this.quotaStrikes && !this.quotaBlockedUntil) return;
    const cooled = this.quotaBlockedUntil > 0;
    this.quotaStrikes = 0;
    this.quotaBlockedUntil = 0;
    this.quotaCardAt = 0;
    if (cooled) this.log("quota_recovered", {});
  }

  private failTurn(code: string, message: string, _action: FeedCard["action"]): void {
    // `_action` 保留参数只为不改所有调用方：动作现在由 errorCopy 按 code 重算（F7）
    // 额度用尽（429 + 套餐/余额语义）→ 全局熔断：心跳、叫醒、派单、顾问一起停手
    const quotaExhausted = code === "rate_429" && isQuotaMessage(message);
    if (quotaExhausted) this.noteQuotaExhausted(message);
    /**
     * F7（18 章 §5）：文案与动作按 code 重算，**不再直接信 classifyError 给的 action**。
     *
     * 原来的问题：429 一律给 `retry`，而额度用尽时点重试必然再撞一次 429——
     * 用户点三次、烧三次配额，最后还是得去充值。这就是「必然失败的重试」。
     * 现在 `errorCopy` 按「点了会不会成功」决定给不给按钮：额度用尽给「去设置」，限流才给「重试」。
     */
    const copy = errorCopy(code, message, {
      quotaExhausted,
      cooldownMinutes: this.quotaBlockedUntil > Date.now() ? Math.round((this.quotaBlockedUntil - Date.now()) / 60_000) : undefined,
      hasBackupModel: this.hasBackupModel(),
    });
    this.log("turn_failed", { code, message, action: copy.action, retryable: copy.retryable });
    this.setTurn({ phase: "failed" });
    /**
     * 同一类错误 5 分钟内合并成一张卡（18 章 §5「同 code 连发合并为一张，角标 ×N」）。
     * 键带上 action：429 的两种形态（限流 retry / 额度用尽 settings）不能合并——
     * 否则用户看到「重试」按钮，对应的却是额度用尽，正好是想消灭的那种误导。
     */
    const now = Date.now();
    const prev = this.lastErrorCard;
    if (shouldMergeError(prev, { code, action: copy.action }, now) && prev?.cardId) {
      const card = this.feed.find((c) => c.id === prev.cardId) ?? this.threads.loadState(this.currentThreadId ?? "").feed.find((c) => c.id === prev.cardId);
      if (card) {
        prev.count += 1;
        prev.at = now;
        const bumped = `${copy.title}（同类错误第 ${prev.count} 次；${Math.round(ERROR_MERGE_WINDOW_MS / 60_000)} 分钟内的重复不再单独落卡）`;
        card.text = bumped;
        this.emit({ type: "error", code, message, action: copy.action });
        if (this.liveCard) {
          this.liveCard.streaming = false;
          this.liveCard = null;
        }
        return;
      }
    }
    const card = this.card({
      kind: "system",
      title: copy.title,
      text: copy.detail,
      code,
      action: copy.action,
      // 不给按钮时如实说明为什么——"没有按钮"和"没做完"是两件事
      ...(copy.action === "none" ? { meta: "这类错误重试没有意义，所以不提供重试" } : {}),
    });
    this.lastErrorCard = { code, action: copy.action, at: now, cardId: card.id, count: 1 };
    if (this.liveCard) {
      this.liveCard.streaming = false;
      this.liveCard = null;
    }
    this.emit({ type: "error", code, message, action: copy.action });
  }

  /** 有没有配备用模型（决定 5xx 的文案该说"可以切"还是"没得切"） */
  private hasBackupModel(): boolean {
    try {
      const prefs = this.settings.getPrefs() as { backupModel?: unknown };
      return Boolean(prefs?.backupModel);
    } catch {
      return false;
    }
  }

  private async runChat(
    userText: string,
    opts?: { internal?: boolean; ephemeral?: boolean; mentions?: FeedMention[] },
  ): Promise<void> {
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
    // 本轮开始前的熔断水位：只有"本轮没把熔断推进过"才算真成功（runChatRpc 内部失败不抛，
    // 不能用 try 正常返回来判断成功，否则刚熔断就被自己解除）
    const quotaAtStart = this.quotaBlockedUntil;
    try {
      // 巡检轮（心跳/验收叫醒/卡住处置）走直连（2026-11-13 P1）：
      // Pi 会话里的 ephemeral 是假的——内核只 splice 自己的 history 镜像，Pi 会话把每轮
      // 巡检（含 thinking 回放、工具往返）永久留着，实测占会话 62%，逼出提前压缩。
      // 直连路径的上下文就是内核 history，收尾 splice 真删；主会话因此只留用户对话。
      const patrol = opts?.ephemeral === true;
      // 群事实（公告/成员名单）只进当轮消息尾部；巡检轮是"看一眼就走"的机械事实，不占体积
      const text = patrol ? userText : this.withTurnFacts(userText);
      if (this.piReady && !patrol) {
        try {
          await this.runChatRpc(text);
        } catch (err) {
          if (this.abortRequested || this.repetitionAborted) return; // 用户停止 / 复读熔断：不要再降级重跑同一轮
          // 运行时不可用：明确告知已降级（不静默），本轮仍能答完
          const fail = this.classifyError(err);
          this.card({
            kind: "system",
            text: `${fail.message}本轮已切到直连模式（会少一些工具能力）。`,
            code: fail.code,
            action: "reload",
          });
          await this.runChatDirect(cfg, apiKey, text);
        }
      } else {
        await this.runChatDirect(cfg, apiKey, text, patrol);
      }
      // 能跑完一轮就说明额度可用：解除熔断（不必等冷却到期）
      if (this.quotaBlockedUntil === quotaAtStart) this.noteQuotaOk();
    } catch (err) {
      if (this.repetitionAborted) return; // 熔断已落卡说明，不再叠一张「端点错误」
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

  /**
   * 团队/成员现场（2026-11-16 性能）：
   * `tasks` 由调用方传进来复用——此前这里在**每支团队循环内**各读一遍全量工单，
   * 10 支队伍就是 10 次全量 JSON.parse，主进程被同步 IO 占住（界面「未响应」）。
   */
  private listTeams(tasks?: TaskRecord[]): BoardData["teams"] {
    const allTasks = tasks ?? this.taskStore.list();
    const dir = path.join(this.dataRoot, "team");
    if (!fs.existsSync(dir)) return [];
    const teams: BoardData["teams"] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const tf = path.join(dir, entry.name, "team.json");
      if (!fs.existsSync(tf)) continue;
      const rec = JSON.parse(fs.readFileSync(tf, "utf-8")) as { id: string; name: string; status: string; threadId?: string };
      // 成员卡必须是"现场"而不是"档案"：状态/预算/打回都从真实指派推导，
      // 原先这里写死 status:"idle"、budgetUsed:0、rejections:0，右栏永远显示空闲
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
            // 看板（2026-11-13）：命中率按 prompt 口径（命中 / 输入总量），多单累计；没跑过不给数
            cacheUsed: Math.round((this.memberCacheRead.get(key) ?? 0) / 1000),
            hitRate:
              (this.memberUsage.get(key) ?? 0) > 0
                ? Math.round(((this.memberCacheRead.get(key) ?? 0) / (this.memberUsage.get(key) ?? 1)) * 1000) / 10
                : undefined,
            rejections: activeTask?.rejectRounds ?? 0,
            rejectionLimit: activeTask?.rejectLimit ?? 3,
            toolWhitelist: p.tools,
            effectiveTools,
            color: face.color,
            avatarId: face.id,
            model: p.model,
            turnLimit: p.limits.maxTurns,
            acceptor: p.acceptor ?? false,
          };
        });
      teams.push({
        id: rec.id,
        name: rec.name,
        status: rec.status as "active" | "paused" | "dissolved",
        // 队→群归属：右栏要按群分家并能跳过去（2026-11-12）
        ...(rec.threadId ? { threadId: rec.threadId } : {}),
        members,
      });
    }
    return teams;
  }

  /**
   * 卷宗时间线尾部 → 详情区「第几轮 / 状态时间线」。
   * 只读：不迁移状态、不改写卷宗；全量事件始终留在磁盘 timeline.jsonl。
   * 也是阶段状态机的数据底座——阶段进度由代码持有，不再让模型在压缩后的上下文里自己记。
   */
  /**
   * 卷宗时间线缓存（2026-11-16）：每次快照都对每张单读一遍 timeline.jsonl 全文
   * （append-only，会长到几百行）。按文件 mtime+size 缓存，只有真追加过才重读。
   */
  private timelineCache = new Map<string, { stamp: number; size: number; value: { round: number; timeline: { at: string; kind: string; text: string }[] } }>();

  private trackTimeline(taskId: string): { round: number; timeline: { at: string; kind: string; text: string }[] } {
    let stamp = 0;
    let size = -1;
    try {
      const st = fs.statSync(this.taskCase.timelineFile(taskId));
      stamp = st.mtimeMs;
      size = st.size;
    } catch {
      return { round: 1, timeline: [] };
    }
    const hit = this.timelineCache.get(taskId);
    if (hit && hit.stamp === stamp && hit.size === size) return hit.value;
    let events: TimelineEvent[] = [];
    try {
      events = this.taskCase.readTimeline(taskId);
    } catch {
      return { round: 1, timeline: [] };
    }
    const round = Math.max(1, events.filter((e) => e.kind === "assign").length);
    const timeline = events.slice(-6).map((e) => ({
      at: e.at,
      kind: e.kind,
      text: String(e.text ?? "").replace(/\s+/g, " ").slice(0, 120),
    }));
    const value = { round, timeline };
    // 缓存只服务展示：单条上限，别让长期运行的进程把每张单的时间线都攥在内存里
    if (this.timelineCache.size > 400) this.timelineCache.clear();
    this.timelineCache.set(taskId, { stamp, size, value });
    return value;
  }

  /**
   * 这支队伍绑在哪个群（读 team.json；读不到/没绑定都给 undefined）。
   * 老工单没记 threadId 时用它兜出群归属——没有归属的单会被渲染层当成"本群"，
   * 于是新建的群也会冒出别群的活（2026-11-16）。
   */
  private teamThreadOf(teamId: string): string | undefined {
    try {
      return this.teamStore.readTeam(teamId).threadId;
    } catch {
      return undefined;
    }
  }

  private buildTrack(tasks?: TaskRecord[]): BoardData["track"] {
    const loaded = tasks ?? this.taskStore.list();
    // id → 工单：一次读盘换掉每张单一次 get()（长任务下这是快照最贵的一段同步 IO）
    const byId = new Map(loaded.map((t) => [t.id, t]));
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
        const task = byId.get(taskId);
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
            statusNote: task.statusNote ?? `${task.status} · ${task.member ?? "风铃"} · 证据 ${task.evidence.length}`,
            member: task.member ?? last.member,
            at: task.updatedAt,
            // 老工单可能没记派单时的群：按团队绑定的群兜（否则新群会把它当本群单）
            threadId: task.threadId ?? this.teamThreadOf(task.teamId),
            readRoots: task.readRoots,
            workspaceRoot: task.workspaceRoot,
            evidenceCount: task.evidence.length,
            version: task.version,
            parentId: task.parentId ?? undefined,
            rejectRounds: task.rejectRounds,
            projectName: task.projectName,
            reviewer: task.reviewer ?? "user",
            evidence: task.evidence.map((e) => ({ label: e.label, ref: e.ref ?? "", verified: e.verified, at: e.at })),
            deliverables: task.deliverables?.map((d) => ({ path: d.path, ref: d.ref, bytes: d.bytes, at: d.at })),
            rejectDraft,
            // 阶段账（2026-11-15）：界面直接读，不靠模型描述进展
            ...(task.stagePlan ? { stage: stageBrief(task.stagePlan) } : {}),
          });
          continue;
        }
        /**
         * 只剩派单账本、没有权威工单 = 这张单已经被删掉了（删单/删群/清数据根），
         * 账本只是没来得及跟着清的死记录（2026-11-16）。
         *
         * 此前这里会按最后一条账本记录「派生」一张工单：状态是猜的、标题退回工单号、
         * **没有群归属**——渲染层把"没有 threadId"当本群，于是任务与它的群都消失了，
         * 它还能在每个群（包括刚新建的群）顶一张「等你拍板」，点验收必然失败。
         * 台账的权威来源是任务卷宗（tasks.json），卷宗没了这张单就不存在：不派生。
         */
        continue;
      }
    }
    // 兜底：有权威工单却没有派单账本的（手工建单 / 迁移 / 账本被删）也要出现在台账上，
    // 否则用户看到的是"单不见了"。
    const seen = new Set(track.map((t) => t.id));
    for (const task of loaded) {
      if (seen.has(task.id)) continue;
      track.push({
        id: task.id,
        teamId: task.teamId,
        title: task.title,
        status: task.status,
        statusNote: task.statusNote ?? `${task.status} · ${task.member ?? "风铃"} · 证据 ${task.evidence.length}`,
        member: task.member,
        at: task.updatedAt,
        threadId: task.threadId ?? this.teamThreadOf(task.teamId),
        readRoots: task.readRoots,
        workspaceRoot: task.workspaceRoot,
        evidenceCount: task.evidence.length,
        version: task.version,
        parentId: task.parentId ?? undefined,
        rejectRounds: task.rejectRounds,
        projectName: task.projectName,
        reviewer: task.reviewer ?? "user",
        evidence: task.evidence.map((e) => ({ label: e.label, ref: e.ref ?? "", verified: e.verified, at: e.at })),
        deliverables: task.deliverables?.map((d) => ({ path: d.path, ref: d.ref, bytes: d.bytes, at: d.at })),
        ...(task.stagePlan ? { stage: stageBrief(task.stagePlan) } : {}),
      });
    }
    // 只读派生：轮次与状态时间线供详情区展示；不改变任何工单状态，也不写卷宗。
    return track.reverse().map((t) => ({ ...t, ...this.trackTimeline(t.id) }));
  }

  private buildBoard(tasks?: TaskRecord[]): BoardData {
    // 同一次快照里团队卡与台账共用同一份工单列表（此前各读各的，全量 parse 三遍）
    const loaded = tasks ?? this.taskStore.list();
    return {
      teams: this.listTeams(loaded),
      track: this.buildTrack(loaded),
      // 2026-11-15：待拍板卡只给当前群——新建群/切群不该冒出别群的问题、契约、审批。
      // 内核这一层过滤是唯一真相源，渲染层、待机页、计数都跟着它走。
      decisions: this.decisionsForCurrentThread().map((d) => ({ ...d })),
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

  /**
   * 连接器配套提示词技能（2026-11-15）：连上就写进 ~/.lynn/skills，风铃建团队/派单时按需命中。
   * 缺才写（用户改过不覆盖），写完重发现技能表。
   */
  private ensureConnectorSkill(id: string): void {
    const spec = CONNECTOR_CATALOG.find((s) => s.id === id);
    if (!spec) return;
    const dir = path.join(this.dataRoot, "skills", spec.skill.name);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buildSkillMd(spec.skill), "utf-8");
        this.log("connector_skill_seeded", { id, skill: spec.skill.name });
      } catch (err) {
        this.log("connector_skill_failed", { id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.reloadSkills();
  }

  /** 外部应用真探测（异步；壳层单独 await）：发一次真实请求/连一次端口，结论写回磁盘 */
  async connectorsTest(params: RpcContracts["connectors.test"]["params"]): Promise<RpcContracts["connectors.test"]["result"]> {
    const id = String(params?.id ?? "");
    const spec = CONNECTOR_CATALOG.find((s) => s.id === id);
    if (!spec) return { ok: false, detail: `未知的外部应用：${id}` };
    const it = this.connectorStore.get(id);
    if (!it) return { ok: false, detail: `「${spec.name.zh}」还没配置过，先填凭据再测` };
    const secrets = this.connectorStore.plainSecrets(id, (b) => this.decryptBlob(b));
    const r = await probeConnectorLive(id, it.values ?? {}, secrets);
    this.connectorStore.recordCheck(id, r.ok, r.detail);
    this.log("connector_probe", { id, ok: r.ok, detail: r.detail.slice(0, 120) });
    return r;
  }

  /**
   * 外部应用请求（成员工具 app_api 的执行方，2026-11-15）。
   * 硬约束都在这里，不靠提示词：
   *  - 只认已启用且已配置的连接器；
   *  - 主机钉死在该连接器自己的域（路径必须是相对路径，不能贴外部 URL）；
   *  - 不允许 DELETE 一类破坏性方法；
   *  - 响应截断 8K，令牌永不回显。
   */
  private async connectorRequest(input: { app: string; method: string; path: string; body?: string }): Promise<string> {
    const spec = CONNECTOR_CATALOG.find((s) => s.id === input.app);
    if (!spec) return `没有这个外部应用：${input.app}。可用的连接器见能力中心 → 外部应用。`;
    const item = this.connectorStore.get(spec.id);
    if (!item?.enabled) return `「${spec.name.zh}」还没启用：能力中心 → 外部应用里打开开关并填好凭据。`;
    const method = String(input.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "PROPFIND", "HEAD"].includes(method)) {
      return `不允许的请求方法：${method}（外部应用只读为主；DELETE/OPTIONS 一律拒）。`;
    }
    const p = String(input.path ?? "").trim();
    if (!p) return "路径不能为空（给相对路径，如 /repos/owner/repo）。";
    if (/^https?:/i.test(p)) return "path 只接受相对路径（不带 http:// 或 https://）——主机由连接器决定，不能改。";

    const secrets = this.connectorStore.plainSecrets(spec.id, (b) => this.decryptBlob(b));
    const headers: Record<string, string> = { "user-agent": "lynn" };
    let base = "";
    if (spec.id === "github") {
      base = "https://api.github.com";
      headers.authorization = `Bearer ${secrets.token ?? ""}`;
      headers.accept = "application/vnd.github+json";
    } else if (spec.id === "gitee" || spec.id === "atomgit") {
      base = spec.id === "gitee" ? "https://gitee.com/api/v5" : "https://api.atomgit.com/api/v5";
      // Gitee 系用 access_token 查询参数（官方支持）；不加进 header 免得某些网关丢掉
      const sep = p.includes("?") ? "&" : "?";
      // 路径在下面统一拼，这里先记住要附加的凭据
      headers["x-lynn-token-key"] = `access_token${sep}`;
    } else if (spec.id === "webdav") {
      base = String(item.values.url ?? "").replace(/\/+$/, "");
      if (!base) return "WebDAV 地址还没填（能力中心 → 外部应用）。";
      headers.authorization = `Basic ${Buffer.from(`${item.values.user ?? ""}:${secrets.password ?? ""}`).toString("base64")}`;
    } else {
      return `「${spec.name.zh}」不是 HTTP 服务：邮箱与 SSH 请用各自的工具（ssh_run / 命令行脚本）。`;
    }

    let url = `${base}${p.startsWith("/") ? "" : "/"}${p}`;
    if (headers["x-lynn-token-key"]) {
      const marker = headers["x-lynn-token-key"];
      delete headers["x-lynn-token-key"];
      url += `${marker}${encodeURIComponent(secrets.token ?? "")}`;
    }
    const body = input.body;
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["content-type"] = /^\s*[[{]/.test(body) ? "application/json" : "text/plain; charset=utf-8";
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      const tail = text.length > 8_000 ? `${text.slice(0, 8_000)}\n…（响应超过 8K，已截断；需要更多就缩小查询范围）` : text;
      this.log("connector_request", { app: spec.id, method, path: p.slice(0, 80), status: res.status });
      return `[${spec.id}] ${method} ${p} → HTTP ${res.status}\n${tail || "（无响应正文）"}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `请求失败：${/abort/i.test(msg) ? "30s 超时" : msg}`;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 远程命令（成员工具 ssh_run 的执行方）：主机/端口/账号/私钥都在内核侧，成员只给命令 */
  private async connectorSsh(input: { app: string; command: string }): Promise<string> {
    if (input.app && input.app !== "ssh") return `只支持 ssh 连接器（当前给的是 ${input.app}）`;
    const item = this.connectorStore.get("ssh");
    if (!item?.enabled) return "SSH 连接还没启用：能力中心 → 外部应用 → SSH 服务器。";
    const v = item.values ?? {};
    const keyRaw = String(v.keyPath ?? "");
    const key = keyRaw.replace(/^~(?=$|[\\/])/, os.homedir());
    if (!key || !fs.existsSync(key)) return `私钥文件不在：${key || "（未填）"}——路径要在本机真实存在。`;
    const host = String(v.host ?? "");
    const user = String(v.user ?? "");
    const port = String(v.port ?? "22");
    if (!host || !user) return "SSH 连接缺主机或账号（能力中心 → 外部应用）。";
    const cmd = String(input.command ?? "").trim();
    if (!cmd) return "命令不能为空。";
    // 只读纪律的第二道闸：黑名单漏一个写法就是远端任意执行，改为首命令白名单 + 全串连接符拒绝。
    const commandError = sshReadOnlyCommandError(cmd);
    if (commandError) return commandError;
    const args = [
      "-i", key,
      "-p", port,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `${user}@${host}`,
      cmd,
    ];
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      execFile("ssh", args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number | string }).code as number | undefined) ?? 1 : 0;
        resolve({ code: typeof code === "number" ? code : 1, text: `${stdout ?? ""}${stderr ?? ""}`.trim() });
      });
    });
    this.log("connector_ssh", { host, command: cmd.slice(0, 120), code: out.code });
    const body = out.text.length > 8_000 ? `${out.text.slice(0, 8_000)}\n…（输出超过 8K，已截断）` : out.text;
    return `[ssh ${user}@${host}] ${cmd}\nexit=${out.code}\n${body || "（无输出）"}`;
  }

  /** 本机免费/本地网关探测：只读 /models，不启动任何进程，不向公网发请求 */
  async listGateways(): Promise<RpcContracts["gateway.list"]["result"]> {
    return { gateways: await probeGateways() };
  }

  /**
   * 自定义端点模型发现（异步；handle 是同步路由，壳层单独 await 这两个方法）。
   * 本机/局域网/非 HTTPS 必须显式确认风险，避免把 Key 静默发给本地免费网关。
   */
  async modelDiscover(params: RpcContracts["model.discover"]["params"]): Promise<RpcContracts["model.discover"]["result"]> {
    const baseUrl = params.baseUrl?.trim() ?? "";
    if (!baseUrl) return { ok: false, error: "Base URL 要填。" };
    let apiKey = params.apiKey?.trim() ?? "";
    if (!apiKey && params.id) apiKey = loadApiKey(this.settings, (b) => this.decryptBlob(b), params.id) ?? "";
    if (!apiKey) return { ok: false, error: "请先填写这个端点的 API Key。" };
    // 风险闸收敛到 endpointRiskError（审计 #6）：与壳层 providers.discover 同一道闸
    const riskError = endpointRiskError(baseUrl, params.riskAccepted, "发现模型");
    if (riskError) return { ok: false, error: riskError };
    try {
      const r = await discoverModels(baseUrl, apiKey);
      return { ok: true, models: r.models, latencyMs: r.latencyMs, url: r.url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 端点健康检查：/models 优先（不花 token），端点不实现时退回一次最小 chat 探针 */
  async modelHealth(params: RpcContracts["model.health"]["params"]): Promise<RpcContracts["model.health"]["result"]> {
    let baseUrl = params.baseUrl?.trim() ?? "";
    let model = params.model?.trim() ?? "";
    let apiKey = params.apiKey?.trim() ?? "";
    let riskAccepted = params.riskAccepted === true;
    if (params.id) {
      const cfg = this.settings.getModel(params.id);
      if (!cfg) return { ok: false, error: "模型不存在" };
      const stored = this.settings.getModels().find((e) => e.id === params.id);
      baseUrl = baseUrl || cfg.baseUrl;
      model = model || cfg.model;
      // 同一端点可沿用保存时的确认；id + 新 baseUrl 必须按新端点重新确认。
      if (stored?.riskAcceptedAt && normalizeBaseUrl(stored.baseUrl) === normalizeBaseUrl(baseUrl)) riskAccepted = true;
      if (!apiKey) apiKey = loadApiKey(this.settings, (b) => this.decryptBlob(b), params.id) ?? "";
    }
    if (!baseUrl) return { ok: false, error: "Base URL 要填。" };
    if (!apiKey) return { ok: false, error: "Key 无法读取，请重新填一次。" };
    const riskError = endpointRiskError(baseUrl, riskAccepted, "健康检查");
    if (riskError) return { ok: false, error: riskError };
    try {
      const r = await discoverModels(baseUrl, apiKey, 6000);
      return { ok: true, latencyMs: r.latencyMs, modelCount: r.models.length, via: "models" };
    } catch (modelsErr) {
      if (!model) {
        return {
          ok: false,
          error: `${modelsErr instanceof Error ? modelsErr.message : String(modelsErr)}（该端点没有 /models，且未指定模型，无法做 chat 探针）`,
        };
      }
      const probe = await probeEndpoint({ baseUrl, apiKey, model });
      if (probe.ok) return { ok: true, latencyMs: probe.latencyMs, via: "chat" };
      return { ok: false, error: probe.error };
    }
  }

  /** task.nudge 的实现（2026-11-14 从 handle 的 switch 拆出） */
  private rpcTaskNudge(params: unknown): unknown {
    const { taskId, note } = params as { taskId: string; note?: string };
    const id = String(taskId ?? "").trim();
    const rec = this.taskStore.get(id);
    if (!rec) return { ok: false, error: `没有这张单：${id}` };
    const text = String(note ?? "").trim() || "用户催了一下进度";
    const r = this.nudgeMember(id, text, true);
    if (!r.startsWith("已送达")) {
      return { ok: false, error: r };
    }
    return { ok: true, ...(rec.member ? { member: rec.member } : {}) };
  }

  /** task.decide 的实现（2026-11-14 从 handle 的 switch 拆出） */
  private rpcTaskDecide(params: unknown): unknown {
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
        return { ok: true, status: rec.status };
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
        return { ok: true, status: rec.status };
      }
      if (!p.reason) {
        return { ok: false, error: "打回必须写清：哪里不合格 / 期望是什么 / 多久内重交" };
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
          threadId: this.taskStore.get(p.taskId)?.threadId ?? this.currentThreadId,
          at: new Date().toISOString(),
        });
        this.persistPending();
      }
      return { ok: true, status: r.record.status, escalated: r.escalated };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** task.feed 的实现（2026-11-14 从 handle 的 switch 拆出） */
  private rpcTaskFeed(params: unknown): unknown {
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
    return { cards: [] };
  }

  /**
   * 设置面 RPC（config.prefs + model.*）的依赖入口（2026-11-14）。
   * 懒建：构造函数里 settings/threads 还没就绪时不能提前取，首次调用时它们一定已经赋值。
   */
  private settingsRpcCache: SettingsRpc | null = null;
  private get settingsRpc(): SettingsRpc {
    if (!this.settingsRpcCache) {
      this.settingsRpcCache = createSettingsRpc({
        settings: this.settings,
        threads: this.threads,
        currentThreadId: () => this.currentThreadId,
        activeModelId: () => this.activeModelId(),
        resetAgentHost: () => void this.resetAgentHost(),
        decrypt: (b) => this.decryptBlob(b),
        stopVoice: () => this.voice?.stop(),
      });
    }
    return this.settingsRpcCache;
  }

  /** 对话面 RPC（thread.*）的依赖入口；同样懒建，避开构造函数里的字段初始化顺序 */
  private threadRpcCache: ThreadRpc | null = null;
  private get threadRpc(): ThreadRpc {
    if (!this.threadRpcCache) {
      this.threadRpcCache = createThreadRpc({
        threads: this.threads,
        currentThreadId: () => this.currentThreadId,
        setCurrentThreadId: (id) => {
          this.currentThreadId = id;
        },
        switchThread: (id) => this.switchThread(id),
        persistThread: () => this.persistThread(),
        enterEmptySession: () => this.enterEmptySession(),
        purgeThreadTasks: (id) => this.purgeThreadTasks(id),
      });
    }
    return this.threadRpcCache;
  }

  /** 日历域（第三批）：store 自身不落卡不发通知，到期扫描回到内核 */
  private calendarRpcCache: CalendarRpc | null = null;
  private get calendarRpc(): CalendarRpc {
    if (!this.calendarRpcCache) {
      this.calendarRpcCache = createCalendarRpc({
        calendar: this.calendar,
        scanReminders: () => this.scanReminders(),
      });
    }
    return this.calendarRpcCache;
  }

  /** 定时任务域（第三批）：到期起一轮对话仍在内核 */
  private scheduleRpcCache: ScheduleRpc | null = null;
  private get scheduleRpc(): ScheduleRpc {
    if (!this.scheduleRpcCache) {
      this.scheduleRpcCache = createScheduleRpc({
        scheduler: this.scheduler,
        tickSchedules: () => this.tickSchedules(),
      });
    }
    return this.scheduleRpcCache;
  }

  /** 知识库域（第三批） */
  private kbRpcCache: KbRpc | null = null;
  private get kbRpc(): KbRpc {
    if (!this.kbRpcCache) {
      this.kbRpcCache = createKbRpc({ knowledge: this.knowledge });
    }
    return this.kbRpcCache;
  }

  /**
   * 工单域 RPC（2026-11-18 第六批）。
   *
   * 11 个 `task.*` 搬进 `rpc/task-rpc.ts`；`nudge` / `decide` / `feed` 仍留在 kernel——
   * 它们改 turn 相位、推决策、读别的域，属跨域编排。
   */
  private taskRpcCache: TaskRpc | null = null;
  private get taskRpc(): TaskRpc {
    if (!this.taskRpcCache) {
      this.taskRpcCache = createTaskRpc(this.taskRpcDeps());
    }
    return this.taskRpcCache;
  }

  /**
   * 工单域的类型收口点：域实现返回 unknown，出这里只看到契约类型。
   * 与 calendar/schedule/kb 同一套做法。
   */
  private taskRpcContractDeps(): TaskRpcContractDeps {
    const t = this.taskRpc;
    return {
      cancel: (p) => t.cancel(p) as RpcContracts["task.cancel"]["result"],
      cancelAll: () => t.cancelAll() as RpcContracts["task.cancelAll"]["result"],
      grantRead: (p) => t.grantRead(p) as RpcContracts["task.grantRead"]["result"],
      revokeRead: (p) => t.revokeRead(p) as RpcContracts["task.revokeRead"]["result"],
      dismiss: (p) => t.dismiss(p) as RpcContracts["task.dismiss"]["result"],
      snapshotProject: (p) => t.snapshotProject(p) as RpcContracts["task.snapshotProject"]["result"],
      export: (p) => t.export(p) as RpcContracts["task.export"]["result"],
      remove: (p) => t.remove(p) as RpcContracts["task.remove"]["result"],
      purgeOrphans: () => t.purgeOrphans() as RpcContracts["task.purgeOrphans"]["result"],
      removeDeliverable: (p) => t.removeDeliverable(p) as RpcContracts["task.removeDeliverable"]["result"],
      detail: (p) => t.detail(p) as RpcContracts["task.detail"]["result"],
    };
  }

  private taskRpcDeps(): TaskRpcDeps {
    return {
      taskStore: this.taskStore as unknown as TaskRpcDeps["taskStore"],
      taskCase: this.taskCase as unknown as TaskRpcDeps["taskCase"],
      dataRoot: this.dataRoot,
      currentThreadId: () => this.currentThreadId,
      cardTo: (threadId, card) => this.cardTo(threadId, card),
      log: (event, detail) => this.log(event, detail),
      cancelMemberTask: (taskId) => this.cancelMemberTask(taskId),
      memberRunIds: () => [...this.memberRuns.keys()],
      grantReadRoots: (taskId, dirs, opts) => this.grantReadRoots(taskId, dirs, opts),
      revokeReadRoot: (taskId, dir) => this.revokeReadRoot(taskId, dir),
      dismissTask: (taskId) => this.dismissTask(taskId),
      snapshotProject: (taskId) => this.snapshotProject(taskId),
      exportTask: (taskId) => this.exportTask(taskId),
      removeTask: (taskId) => this.removeTask(taskId),
      purgeOrphanTasks: () => this.purgeOrphanTasks(),
    };
  }

  /** 日历域的类型收口点（第三批）：域实现返回 unknown，出这里只看到契约类型 */
  private calendarRpcDeps(): CalendarRpcDeps {
    const c = this.calendarRpc;
    return {
      add: (p) => c.add(p) as RpcContracts["calendar.add"]["result"],
      list: (p) => c.list(p) as RpcContracts["calendar.list"]["result"],
      finish: (p) => c.finish(p) as RpcContracts["calendar.finish"]["result"],
      todoAdd: (p) => c.todoAdd(p) as RpcContracts["calendar.todo.add"]["result"],
      todoList: () => c.todoList() as RpcContracts["calendar.todo.list"]["result"],
      todoFinish: (p) => c.todoFinish(p) as RpcContracts["calendar.todo.finish"]["result"],
      scan: () => c.scan() as RpcContracts["calendar.scan"]["result"],
    };
  }

  /** 定时任务域的类型收口点（第三批） */
  private scheduleRpcDeps(): ScheduleRpcDeps {
    const s = this.scheduleRpc;
    return {
      tick: () => s.tick() as RpcContracts["schedule.tick"]["result"],
      add: (p) => s.add(p) as RpcContracts["schedule.add"]["result"],
      list: () => s.list() as RpcContracts["schedule.list"]["result"],
      remove: (p) => s.remove(p) as RpcContracts["schedule.remove"]["result"],
      toggle: (p) => s.toggle(p) as RpcContracts["schedule.toggle"]["result"],
    };
  }

  /** 知识库域的类型收口点（第三批） */
  private kbRpcDeps(): KbRpcDeps {
    const k = this.kbRpc;
    return {
      search: (p) => k.search(p) as RpcContracts["kb.search"]["result"],
      list: () => k.list() as RpcContracts["kb.list"]["result"],
      read: (p) => k.read(p) as RpcContracts["kb.read"]["result"],
      reindex: () => k.reindex() as RpcContracts["kb.reindex"]["result"],
    };
  }

  /** 数据维护域（第五批）：用量统计与清理；清理后的落卡属于内核反馈，留在下面的 cleanup 闭包里 */
  private dataRpcDeps(): DataRpcDeps {
    return {
      usage: () => ({
        usage: measureUsage(this.dataRoot),
        retention: this.settings.getPrefs().retention,
      }),
      cleanup: (p) => {
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
        return { ok: true, freedBytes: r.freedBytes, removed: r.removed.length };
      },
    };
  }

  /** 配置杂项域（第五批）：清 Key 与视觉模型；对话模型的保存/测试要过端点风险闸，仍在内核 */
  private configRpcDeps(): ConfigRpcDeps {
    return {
      clearKey: () => ({ ok: this.settings.clearApiKey() }),
      visionGet: () => {
        const v = this.settings.getVisionModel();
        return {
          configured: Boolean(v),
          provider: v?.provider,
          baseUrl: v?.baseUrl,
          model: v?.model,
          updatedAt: v?.updatedAt,
        };
      },
      visionSave: (p) => {
        try {
          this.settings.saveVisionModel({
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey: p.apiKey,
            plaintextOk: p.plaintextOk === true,
            previous: this.settings.getVisionModel(),
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      visionClear: () => ({ ok: this.settings.clearVision() }),
    };
  }

  /** 外观插件域（第五批）：扫描 .lynn/ui 插件，形状转换在这一层收口 */
  private uiRpcDeps(): UiRpcDeps {
    return {
      plugins: () => {
        const r = scanUiPlugins(this.dataRoot);
        return {
          plugins: r.plugins.map((p) => ({ ...p.manifest, html: p.html })),
          errors: r.errors,
        };
      },
    };
  }

  /** 写作规则状态（第五批）：只读入口；开关写入口在 config.prefs */
  private humanizerRpcDeps(): HumanizerRpcDeps {
    return { status: () => humanizerStatus() };
  }

  /** RPC 方法注册表（按域迁移的落点，约定见 rpc-registry.ts 顶部注释） */
  private rpcRegistryCache: RpcRegistry | null = null;
  private get rpcRegistry(): RpcRegistry {
    if (!this.rpcRegistryCache) {
      this.rpcRegistryCache = buildKernelRegistry({
        models: this.modelRpcDeps(),
        threads: this.threadRpcDeps(),
        calendar: this.calendarRpcDeps(),
        schedules: this.scheduleRpcDeps(),
        kb: this.kbRpcDeps(),
        data: this.dataRpcDeps(),
        config: this.configRpcDeps(),
        tasks: this.taskRpcContractDeps(),
        ui: this.uiRpcDeps(),
        humanizer: this.humanizerRpcDeps(),
      });
    }
    return this.rpcRegistryCache;
  }

  /**
   * 对话面域的能力注入（第二批）。ThreadRpc 的方法仍声明 unknown 入参/返回值（既有实现），
   * 这里是唯一的类型收口点：出了这个方法，注册表侧只看到契约类型。
   * thread.halt 不在其中——它要停成员、断回合、清待验收，属跨域编排，留在 handle 里。
   */
  private threadRpcDeps(): ThreadRpcDeps {
    const t = this.threadRpc;
    return {
      list: () => t.list() as RpcContracts["thread.list"]["result"],
      create: (p) => t.create(p) as RpcContracts["thread.new"]["result"],
      switchTo: (p) => t.switchTo(p) as RpcContracts["thread.switch"]["result"],
      rename: (p) => t.rename(p) as RpcContracts["thread.rename"]["result"],
      pin: (p) => t.pin(p) as RpcContracts["thread.pin"]["result"],
      announce: (p) => t.announce(p) as RpcContracts["thread.announcement"]["result"],
      remove: (p) => t.remove(p) as RpcContracts["thread.remove"]["result"],
      search: (p) => t.search(p) as RpcContracts["thread.search"]["result"],
    };
  }

  /**
   * 模型库域的能力注入（2026-11-15）。
   * SettingsRpc 的 model.* 目前仍声明 unknown 入参 / 返回值（既有实现，本批不动），
   * 这里是唯一的类型收口点：出了这个方法，注册表侧只看到契约类型。
   */
  private modelRpcDeps(): ModelRpcDeps {
    const s = this.settingsRpc;
    return {
      list: () => s.modelList() as RpcContracts["model.list"]["result"],
      save: (p) => s.modelSave(p) as RpcContracts["model.save"]["result"],
      remove: (p) => s.modelRemove(p) as RpcContracts["model.remove"]["result"],
      setDefault: (p) => s.modelSetDefault(p) as RpcContracts["model.setDefault"]["result"],
      setThread: (p) => s.modelSetThread(p) as RpcContracts["model.setThread"]["result"],
      test: (p) => s.modelTest(p) as RpcContracts["model.test"]["result"],
    };
  }

  handle<M extends RpcMethod>(method: M, params: unknown): RpcContracts[M]["result"] {
    // 已迁移到注册表的方法先走注册表；未迁移的仍落在下面的 switch（逐批减少）
    if (this.rpcRegistry.has(method)) {
      return this.rpcRegistry.handle(method, params as RpcContracts[M]["params"]);
    }
    switch (method) {
      case "app.info": {
        // 内核构建时间：__filename 是编译产物 dist/main/kernel.js，mtime 就是这次构建的时刻
        let buildAt = "";
        try {
          buildAt = fs.statSync(__filename).mtime.toISOString();
        } catch {
          /* 打包进 asar / 只读介质时拿不到 mtime：返回空串，前端只判断"方法在不在" */
        }
        // 构建号（审计 #19）：与 vite 侧同一算法（git 提交计数），单调可比；
        // 缓存进模块级——app.info 每次握手都会调，别重复 spawn git。
        return { buildAt, buildId: kernelBuildId() } as RpcContracts[M]["result"];
      }

      case "session.snapshot": {
        const cfg = this.activeModelConfig();
        // C3：会话 → 工单归属计数（按 task.threadId 汇总；老单没记 threadId 就不归到任何会话，不猜）
        // 一次性读全量工单：下面的 board（团队 + 台账）复用同一份，别各读一遍
        const snapshotTasks = this.taskStore.list();
        const threadCounts = countTasksByThread(snapshotTasks);
        const curProject = this.currentProject();
        const snap: RpcContracts["session.snapshot"]["result"] = {
          // 项目名优先用项目身份（用户改过的中文名）；没有项目实体时退回目录 basename。
          // 没有主根时如实说「临时」，不拿数据根目录名冒充
          workspace: {
            project: curProject?.name ?? (this.projectRoot ? path.basename(this.projectRoot) : "临时"),
            subdir: this.roots.extras.length ? `可读 ${this.roots.extras.length}` : "工作区",
            ...(this.projectRoot ? { primary: this.projectRoot } : {}),
            ...(curProject ? { projectId: curProject.id, projectName: curProject.name } : {}),
            extras: this.roots.extras.map((r) => ({
              path: r.path,
              mode: r.mode,
              ...(r.label ? { label: r.label } : {}),
            })),
          },
          thread: {
            id: this.currentThreadId,
            title: this.currentThreadId ? (this.threads.get(this.currentThreadId)?.title ?? "新群") : "",
            projectRoot: this.threads.get(this.currentThreadId)?.projectRoot,
            ...(curProject ? { projectId: curProject.id, projectName: curProject.name } : {}),
            // 本群被「终止任务」了（2026-11-15）：界面据此把按钮换成状态
            halted: this.isThreadHalted(this.currentThreadId),
          },
          threads: this.threads
            .list()
            .map((t) => ({
              id: t.id,
              title: t.title,
              updatedAt: t.updatedAt,
              counts: threadCounts.get(t.id),
              pinned: t.pinned,
              lastPreview: t.lastPreview,
              lastAt: t.lastAt,
              unread: t.unread ?? 0,
              announcement: t.announcement,
              halted: this.haltedThreads.has(t.id),
              ...(() => {
                const p = this.projects.resolve(t.projectId);
                return p ? { projectId: p.id, projectName: p.name } : {};
              })(),
            })),
          // 真在跑的成员单：台账"进行中"不等于在跑（卡住/停机也会留在 in_progress 历史里）
          running: this.runningTaskIds(),
          // 无主单计数：会话删了单还在（老版本不级联）。界面据此给一键清理出口
          orphans: this.orphanTasks().length,
          project: {
            root: this.projectRoot,
            trusted: this.projectRoot ? this.trust.isTrusted(this.projectRoot) : false,
            hasMcp: this.projectRoot ? fs.existsSync(path.join(this.projectRoot, ".lynn", "mcp.json")) : false,
            gated: this.gatedByTrust(this.projectRoot),
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
          board: this.buildBoard(snapshotTasks),
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
        const { text, mode = "queue", attachments, mentions: mentionHint } = params as {
          text: string;
          mode?: "steer" | "queue";
          attachments?: TurnAttachments;
          mentions?: { name: string }[];
        };
        const trimmed = text.trim();
        if (!trimmed) return { ok: true, queued: false } as RpcContracts[M]["result"];
        // 用户在这个群开口 = 解除「终止任务」（2026-11-15）：只有他明确的新需求能恢复
        if (this.isThreadHalted()) this.resumeThread(this.currentThreadId);
        const hasAtt = Boolean(attachments && (attachments.files?.length || attachments.images?.length));
        // 群内 @（2026-11-12）：只认本群成员，陌生名字丢弃并如实说清——@ 谁由内核定，不信前端
        const { mentions, unknown } = this.resolveMentions(trimmed, mentionHint);
        if (unknown.length) {
          this.card({
            kind: "system",
            systemTone: "notice",
            text: `群里没有 ${unknown.map((n) => `@${n}`).join("、")}：@ 只能点名本群成员，这句按普通消息处理。`,
          });
        }
        // 用户开口 = 对挂起问询的回答（2026-11-13 实机）：ask_user 的拍板卡不再死等
        // 「提交回答」——用户直接在群里把话说清，卡还悬着只会诱导她再点一次卡造成重复回答。
        // 契约卡（kind=plan）不动：派单必须点「开始」，打字不算拍板。
        // 只撤本群的问询：在新群说句话，不该把别群那个还没人答的问题一起抹掉
        const answered = new Set(this.decisionsForCurrentThread().filter((d) => d.kind === "question").map((d) => d.id));
        if (answered.size) {
          this.decisions = this.decisions.filter((d) => !answered.has(d.id));
          this.persistPending();
          this.setTurn({});
        }
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
            this.card({
              kind: "user",
              text: trimmed,
              meta,
              author: { kind: "user" },
              mentions: mentions.length ? mentions : undefined,
            });
            this.history.push({ role: "user", content: steerText });
            this.persist("user", steerText);
            // 定向说明只进当轮插话，不进历史（历史前缀原样，缓存命中不受影响）
            void this.steerTurn(mentions.length ? `${steerText}\n\n${this.groupDirective(mentions)}` : steerText);
            return { ok: true, queued: false } as RpcContracts[M]["result"];
          }
          const item: QueuedInput = {
            id: `q-${++this.queueSeq}`,
            text: trimmed,
            at: new Date().toISOString(),
            mode: "queue",
            ...(hasAtt ? { attachments } : {}),
            ...(mentions.length ? { mentions } : {}),
          };
          this.queue.push(item);
          this.setTurn({});
          return { ok: true, queued: true, queueId: item.id } as RpcContracts[M]["result"];
        }
        this.submitTurn(trimmed, attachments, { mentions });
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
        this.log("memory_save", { scope: kind, chars: text.length, versionId, hot });
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

      // ---------- 能力中心（2026-11-15）：插件 / MCP / 技能 / 自动化 / 外部应用 ----------
      // 预置清单：读的是真实磁盘与配置（presetInstalled），不记内存标记——重启后状态照样对得上
      case "cap.presets": {
        const skillNames = new Set(this.skillEntries.map((s) => s.name));
        return {
          presets: allPresets().map((p) => ({
            kind: p.kind,
            id: p.id,
            name: p.name,
            summary: p.summary,
            source: p.source,
            license: p.license,
            requires: p.requires,
            icon: p.icon,
            skill: p.skill?.name,
            installed:
              p.kind === "schedule"
                ? this.scheduler.list().some((t) => t.name === p.schedule?.name)
                : presetInstalled(this.dataRoot, p.kind, p.id),
            skillReady: p.skill ? skillNames.has(p.skill.name) : undefined,
          })),
        } as RpcContracts[M]["result"];
      }

      // 一键预装（幂等）：文件类走 installPreset，自动化交给调度器；装完立刻让运行时接上
      case "cap.install": {
        const p = params as { kind: "mcp" | "plugin" | "skill" | "schedule"; id: string };
        if (p.kind === "schedule") {
          const preset = SCHEDULE_PRESETS.find((x) => x.id === p.id);
          if (!preset?.schedule) {
            return { ok: false, detail: `没有这个自动化预置：${p.id}`, id: p.id, created: false } as RpcContracts[M]["result"];
          }
          if (this.scheduler.list().some((t) => t.name === preset.schedule!.name)) {
            return { ok: true, detail: `已经有一条同名定时任务「${preset.schedule.name}」，没动它`, id: p.id, created: false } as RpcContracts[M]["result"];
          }
          try {
            const task = this.scheduler.add({
              name: preset.schedule.name,
              prompt: preset.schedule.prompt,
              kind: preset.schedule.kind,
              time: preset.schedule.time,
              intervalMin: preset.schedule.intervalMin,
            });
            this.log("cap_schedule_installed", { id: p.id, taskId: task.id });
            return {
              ok: true,
              detail: `已排期「${task.name}」，下次触发 ${task.nextRun ? new Date(task.nextRun).toLocaleString("zh-CN") : "待定"}`,
              id: p.id,
              created: true,
            } as RpcContracts[M]["result"];
          } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err), id: p.id, created: false } as RpcContracts[M]["result"];
          }
        }
        const out = installPreset(this.dataRoot, p.kind, p.id);
        if (!out.ok) return out as RpcContracts[M]["result"];
        if (p.kind === "mcp") {
          // 新 server 要重新握手；不阻塞这一帧，完成后再落卡
          this.scheduleMcpReload();
        } else if (p.kind === "plugin") {
          // 官方预置默认启用：立刻把它载进工具面（失败如实记日志，不假装成功）
          void this.l1
            .requestReload(p.id)
            .then((msg) => this.emit({ type: "tool", badge: "工具", title: `插件 · ${p.id}`, body: msg }))
            .catch((err) => this.log("cap_plugin_reload_failed", { id: p.id, error: err instanceof Error ? err.message : String(err) }));
          void this.resetAgentHost();
          this.reloadSkills();
        } else if (p.kind === "skill") {
          this.reloadSkills();
        }
        this.log("cap_installed", { kind: p.kind, id: p.id, created: out.created, skill: out.skill });
        return out as RpcContracts[M]["result"];
      }

      // 外部应用连接：列表只回"有没有填"，明文凭据永不出内核
      case "connectors.list": {
        return {
          items: this.connectorStore.list(CONNECTOR_CATALOG.map((s) => s.id)),
          catalog: CONNECTOR_CATALOG.map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            icon: s.icon,
            summary: s.summary,
            detail: s.detail,
            docUrl: s.docUrl,
            authType: s.authType,
            fields: s.fields,
            skill: s.skill.name,
          })),
          canEncrypt: this.connectorCanEncrypt(),
        } as RpcContracts[M]["result"];
      }

      case "connectors.save": {
        const p = params as { id: string; values?: Record<string, string>; clear?: string[]; plaintextOk?: boolean; enable?: boolean };
        const r = this.connectorStore.save(p);
        if (r.ok) {
          this.ensureConnectorSkill(p.id);
          this.log("connector_saved", { id: p.id, enabled: r.enabled });
        }
        return { ...r } as RpcContracts[M]["result"];
      }

      case "connectors.toggle": {
        const p = params as { id: string; enabled: boolean };
        const r = this.connectorStore.toggle(p.id, p.enabled, (b) => this.decryptBlob(b));
        if (r.ok) {
          // 启用即补技能：连接类技能描述"能做什么、边界在哪"，风铃建团队时按需命中
          if (p.enabled) this.ensureConnectorSkill(p.id);
          this.log("connector_toggled", { id: p.id, enabled: p.enabled });
        }
        return { ...r } as RpcContracts[M]["result"];
      }

      case "connectors.forget": {
        const { id } = params as { id: string };
        const ok = this.connectorStore.forget(id);
        if (ok) this.log("connector_forgotten", { id });
        return { ok } as RpcContracts[M]["result"];
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

      // ---------- 日历 / 定时任务 / 知识库 RPC ----------
      // 已迁移到 rpc-registry.ts 的 calendar / schedules / kb 三个域（2026-11-16 第三批）。
      // 到期扫描与到点起对话仍回内核编排；域文件只做存储与查询。
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

      // 单个 server 启停（能力中心的开关）：改全局 mcp.json 的 enabled，再重连。
      // 项目级配置里同 id 的项不动——那是项目自己的声明，改它等于替用户改仓库文件。
      case "mcp.toggle": {
        const p = params as { id: string; enabled: boolean };
        const file = path.join(this.dataRoot, "mcp.json");
        if (!fs.existsSync(file)) {
          return { ok: false, error: `还没有 mcp.json（${file}），先装一个预置或手写配置` } as RpcContracts[M]["result"];
        }
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { servers?: { id?: string; enabled?: boolean }[] };
          const list = Array.isArray(raw.servers) ? raw.servers : [];
          const hit = list.find((s) => s?.id === p.id);
          if (!hit) {
            return { ok: false, error: `全局 mcp.json 里没有 ${p.id}（可能在项目级配置里，请改项目文件）` } as RpcContracts[M]["result"];
          }
          hit.enabled = p.enabled;
          fs.writeFileSync(file, JSON.stringify({ ...raw, servers: list }, null, 2), { encoding: "utf-8", mode: 0o600 });
          this.scheduleMcpReload();
          this.log("mcp_toggled", { id: p.id, enabled: p.enabled });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: `mcp.json 读写失败：${err instanceof Error ? err.message : String(err)}` } as RpcContracts[M]["result"];
        }
      }

      // 建团队（§4.10.3 修正）：界面上给名字就够，ID 由系统生成
      case "team.create": {
        const { name } = params as { name?: string };
        try {
          const created = this.tools.createTeam(name ? String(name) : undefined);
          this.snapshotTeamRoots(created.id);
          // 手动建的队归当前群（2026-11-12）：否则它既不属本群也不属别群，
          // 在右栏只能躺在"其他团队"里，用户以为建错了。
          this.bindGroup(created.id);
          this.card({ kind: "system", text: `已建团队「${created.name}」（ID ${created.id}）。` });
          return { ok: true, id: created.id, name: created.name } as RpcContracts[M]["result"];
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      // 成员战绩：按需拉，不进每轮快照（快照很频繁，扫 assignments 太贵）
      case "team.member.record": {
        const { teamId, name } = params as { teamId: string; name: string };
        try {
          return this.teamStore.memberRecord(teamId, name) as RpcContracts[M]["result"];
        } catch {
          return { tasks: 0, accepted: 0, rejected: 0, escalations: 0 } as RpcContracts[M]["result"];
        }
      }

      /**
       * 成员档案全量（群聊模式：右键成员看"他是谁"）。
       * 岗位说明书 + 战绩 + 手上那张单——三样都在这里，不必跳去设置页。
       */
      case "team.member.detail": {
        const { teamId, name } = params as { teamId: string; name: string };
        const member = String(name ?? "").trim();
        if (!teamId || !member) {
          return { ok: false, error: "要看谁？给出队与成员名。" } as RpcContracts[M]["result"];
        }
        let profile: MemberProfile;
        try {
          profile = this.teamStore.readMember(teamId, member);
        } catch {
          return { ok: false, error: `没有这个成员：${member}` } as RpcContracts[M]["result"];
        }
        let record: { tasks: number; accepted: number; rejected: number; escalations: number } | undefined;
        try {
          record = this.teamStore.memberRecord(teamId, member);
        } catch {
          record = undefined;
        }
        const job = this.taskStore
          .list()
          .filter((t) => t.member === member)
          .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
        return {
          ok: true,
          profile: {
            name: profile.name,
            role: profile.role,
            goal: profile.goal,
            boundaries: profile.boundaries,
            tools: profile.tools,
            model: profile.model,
            limits: profile.limits,
            outputContract: profile.outputContract,
            escalateWhen: profile.escalateWhen,
            body: profile.body,
            ...(profile.avatarId ? { avatarId: profile.avatarId } : {}),
          },
          ...(record ? { record } : {}),
          ...(job ? { job: { id: job.id, title: job.title, status: job.status } } : {}),
        } as RpcContracts[M]["result"];
      }

      /**
       * 用户催办（群聊模式：右键成员"催一下"）。
       * 催办不越权：话转给成员（下一轮生效），要不要返工/改口径由风铃定。
       */
      case "task.nudge":
        return this.rpcTaskNudge(params) as RpcContracts[M]["result"];

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
          // 手改同样过规范，但只记审计不阻断：历史档案（含任务化名字）要能继续编辑。
          // 新增入口 create_member 是硬闸；这里给的是可回查的偏离记录。
          const profileIssues = validateMemberProfile(updated, { skipName: true });
          if (profileIssues.length) {
            this.log("member_profile_warning", {
              teamId,
              member: updated.name,
              rules: [...new Set(profileIssues.map((i) => i.rule))],
            });
          }
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
        // 用户喊停：嘴也要立刻停，别把上一轮的结论继续念完
        this.voice?.stop();
        this.setTurn({ pending: 0 });
        // 直连路径：立即断开 fetch/SSE；Pi 路径：让 worker 自己中止。
        const directAborted = Boolean(this.chatAbort && !this.chatAbort.signal.aborted);
        this.chatAbort?.abort();
        const aborted = Boolean(this.host?.isRunning()) || directAborted;
        if (this.host?.isRunning()) {
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
        const { id, action, text, always } = params as {
          id: string;
          action: "answer" | "start" | "revise" | "reject";
          text?: string;
          always?: boolean;
        };
        const d = this.decisions.find((x) => x.id === id);
        if (!d) return { ok: false, error: "这个问题已经处理过了" } as RpcContracts[M]["result"];
        // 用户拍板（开始/回答/改一版）= 明确的新需求（2026-11-15）：终止状态下要恢复，
        // 否则点了「开始」成员也不会动、心跳也不会来验收。
        if (action !== "reject" && this.isThreadHalted()) this.resumeThread(this.currentThreadId);
        this.decisions = this.decisions.filter((x) => x.id !== id);
        // 处理掉一条就同步落盘：重启后不该再弹一张已经拍过的问询
        this.persistPending();

        if (d.kind === "approval") {
          const pending = this.pendingApprovals.get(id);
          if (!pending) return { ok: false, error: "这次审批已超时或已处理" } as RpcContracts[M]["result"];
          this.pendingApprovals.delete(id);
          pending.resolve(action === "start");
          // 「这类以后都允许」（2026-11-14）：只对删除族生效，且只关掉"弹卡"，
          // 路径守卫与工作区边界一概不动——放宽的是打扰，不是权限。
          if (action === "start" && always && d.family) {
            const fams = new Set(this.settings.getPrefs().allowCommandFamilies ?? []);
            fams.add(d.family);
            this.settings.savePrefs({ allowCommandFamilies: [...fams] });
            this.log("command_family_allowed", { family: d.family });
          }
          this.setTurn({ phase: "working" });
          this.card({
            kind: "system",
            text: action === "start" ? (always && d.family ? `已批准，以后「${d.family}」这类删除不再逐次问你。` : "已批准。") : "已拒绝。",
          });
          return { ok: true } as RpcContracts[M]["result"];
        }

        if (d.kind === "plan") {
          const plan = this.pendingPlans.get(id);
          this.pendingPlans.delete(id);
          this.persistPending();
          if (action === "start" && plan) {
            const r = this.startAssignment(plan);
            // 契约一确认就从右栏消失，目标/验收/截止不该跟着没：落一张带 jobId 的卡，
            // 图纸「往来」能回看，跨会话的 task.feed 也读得到
            const atPlan = this.atMember(
              plan.member,
              [
                `目标：${d.plan?.goal ?? plan.brief.split("\n")[0] ?? ""}`,
                `验收：${(d.plan?.acceptance ?? []).join("；") || "（未写）"}`,
                // 禁区与取舍也上契约卡：用户点「开始」前就该看见这次的红线
                ...(plan.forbidden?.length ? [`禁区（不许做）：${plan.forbidden.join("；")}`] : []),
                ...(plan.priority ? [`取舍口径：${plan.priority}`] : []),
                ...(plan.mode === "explore" ? ["型态：探索型（要结论与依据，不硬凑产物）"] : []),
                `截止：${d.plan?.deadline ?? plan.deadline}`,
                `团队：${plan.teamId}`,
              ].join("\n"),
            );
            this.card({
              kind: "tool",
              badge: "派单",
              title: `${plan.member} · ${plan.taskId} · 契约`,
              jobId: plan.taskId,
              body: atPlan.body,
              author: { kind: "lynn", name: "风铃" },
              mentions: atPlan.mentions,
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

      case "task.decide":
        return this.rpcTaskDecide(params) as RpcContracts[M]["result"];

      case "plugins.list": {
        const r = this.pluginHost.scan();
        return { plugins: r.plugins, errors: r.errors } as RpcContracts[M]["result"];
      }

      /** 插件历史版本（P12-1）：新的在前 */
      case "plugins.versions": {
        const p = params as { id: string };
        return { versions: listVersions(this.dataRoot, p.id), keep: KEEP_VERSIONS } as RpcContracts[M]["result"];
      }

      /** 回滚到某个历史版本（P12-1）：当前版本会先归档，所以回滚本身也能回滚 */
      case "plugins.rollbackVersion": {
        const p = params as { id: string; versionDir: string };
        const r = rollbackToVersion(this.dataRoot, p.id, p.versionDir);
        if (r.ok) {
          this.pluginSet.snapshot("rollback-version");
          this.log("plugin_rollback", { id: p.id, to: r.version });
        }
        return { ok: r.ok, ...(r.version ? { version: r.version } : {}), issues: r.issues } as RpcContracts[M]["result"];
      }

      /** 插件斜杠命令（P11-1）：扫描 plugins/，收集启用插件的 commands */
      case "plugins.commands": {
        const r = scanPluginCommands(this.dataRoot);
        return { commands: r.commands, errors: r.errors } as RpcContracts[M]["result"];
      }

      /**
       * 导入插件包（P9-2）：`.zip` 文件或插件目录。
       *
       * 这是"手动安装标准插件文件包"的入口。校验失败时把 issues 原样返回，
       * 让界面能显示**具体到字段**的原因——笼统的"导入失败"对用户毫无用处。
       */
      case "plugins.import": {
        const p = params as { path: string; override?: boolean };
        const result = importPluginPackage(String(p.path), this.dataRoot, { override: p.override === true });
        if (result.ok) {
          this.pluginSet.snapshot("import");
          this.log("plugin_imported", { id: result.id });
        }
        return { ok: result.ok, ...(result.id ? { id: result.id } : {}), issues: result.issues } as RpcContracts[M]["result"];
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
          const r = promoteDraft(this.dataRoot, p.draftId, p.byUser, {
            pluginIds: this.pluginHost.scan().plugins.map((x) => x.id),
            skillNames: this.skillEntries.map((s) => s.name),
          });
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
        const p = params as {
          provider: string;
          baseUrl: string;
          model: string;
          apiKey?: string;
          plaintextOk?: boolean;
          riskAccepted?: boolean;
        };
        const models = this.settings.getModels();
        const previousEntry = models.find((e) => e.id === this.settings.getDefaultModelId()) ?? models[0];
        const inheritedRisk = Boolean(
          previousEntry?.riskAcceptedAt && normalizeBaseUrl(previousEntry.baseUrl) === normalizeBaseUrl(p.baseUrl),
        );
        const riskError = endpointRiskError(p.baseUrl, p.riskAccepted === true || inheritedRisk, "保存");
        if (riskError) return { ok: false, error: riskError } as RpcContracts[M]["result"];
        try {
          this.settings.saveModel({
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey: p.apiKey,
            plaintextOk: p.plaintextOk === true,
            riskAcceptedAt: p.riskAccepted === true ? new Date().toISOString() : undefined,
            previous: this.settings.getModel(),
          });
          return { ok: true } as RpcContracts[M]["result"];
        } catch (err) {
          // 主进程的 ipcMain.handle 会把 throw 吞成 {error}，渲染层不会抛；这里显式回 ok:false
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as RpcContracts[M]["result"];
        }
      }

      case "config.test": {
        const p = params as { baseUrl: string; apiKey: string; model: string; riskAccepted?: boolean };
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
        const models = this.settings.getModels();
        const activeId = this.activeModelId() ?? this.settings.getDefaultModelId() ?? models[0]?.id;
        const activeEntry = models.find((e) => e.id === activeId);
        const inheritedRisk = Boolean(
          activeEntry?.riskAcceptedAt && normalizeBaseUrl(activeEntry.baseUrl) === normalizeBaseUrl(p.baseUrl),
        );
        const riskError = endpointRiskError(p.baseUrl, p.riskAccepted === true || inheritedRisk, "测试连接");
        if (riskError) return { ok: false, error: riskError } as RpcContracts[M]["result"];
        return probeEndpoint({ ...p, apiKey }) as unknown as RpcContracts[M]["result"];
      }

      // 模型库（model.*）已迁到 rpc-registry.ts 的 model 域
      case "config.prefs": {
        const savedPrefs = this.settingsRpc.savePrefs(params as Partial<Prefs>);
        // 写作规则开关（2026-11-15）：开=下一轮起系统提示词里带上约束。
        // 已经在跑的 Pi 会话要热同步一次，否则用户点了开关却要等重开会话才生效。
        const hz = (params as { humanizer?: boolean }).humanizer;
        if (typeof hz === "boolean") {
          setHumanizerEnabled(hz);
          this.hotSyncSystemPrompt();
        }
        return savedPrefs as RpcContracts[M]["result"];
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

      // 清 Key / 视觉/OCR 模型（M2-13）已迁到 rpc-registry.ts 的 config 域
      // 消息平台（M2-16）已于 2026-11-18 移除：它只能发不能收（receiveSupported: false），
      // 是半成品。IM 能力改由插件提供（见 docs/plan/30-dsh-im-port-plan.md）。

      case "trust.set": {
        const { trusted } = params as { trusted: boolean };
        if (!this.projectRoot) {
          return { ok: false, error: "当前会话没有工作区：先选一个目录再设信任。" } as RpcContracts[M]["result"];
        }
        this.trust.setTrusted(this.projectRoot, Boolean(trusted));
        // 重新连 MCP 是异步的：先回执，再在后台完成并落一张卡
        this.watchMcpConfig();
        // 信任也管着项目级技能（.lynn/skills/）：2026-11-13 修——
        // 此前只重连 MCP，技能表没重新发现，项目级技能信任后依然不会被激活
        // （skills.list 是现算的，所以表面看像加载了，运行时表里其实没有）。
        this.reloadSkills();
        void this.reloadMcp().then(() =>
          this.card({
            kind: "system",
            text: trusted
              ? "已信任当前项目，项目级 MCP 与技能已按配置加载。"
              : "已取消信任，项目级 MCP 与技能不再加载。",
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

      // ---------- 对话面 RPC：list/new/switch/rename/pin/announcement/remove/search ----------
      // 已迁移到 rpc-registry.ts 的 threads 域（2026-11-16 第二批）。
      // thread.halt 留在下面：它要停成员、断回合、清待验收，属跨域编排，不是域内查询。

      /**
       * 终止本群（2026-11-15）：成员停机 + 当前回合中断 + 心跳/巡检/验收叫醒/定时任务
       * 全部停手，直到用户在这个群发出新消息。整群级动作，不接受"停别群"的越权用法：
       * 不传 id 就停当前群；传了也必须是现有群。
       */
      case "thread.halt": {
        const { id } = (params ?? {}) as { id?: string };
        const target = String(id ?? this.currentThreadId ?? "");
        if (target && !this.threads.get(target)) {
          return { ok: false, stopped: 0, threadId: target, error: `没有这个群：${target}` } as RpcContracts[M]["result"];
        }
        return this.haltThread(target) as RpcContracts[M]["result"];
      }

      case "task.feed":
        return this.rpcTaskFeed(params) as RpcContracts[M]["result"];

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
        // 项目身份：同一个目录永远同一个项目；换目录 = 换项目
        const proj = this.projects.ensureByPath(abs);
        this.bindProject(proj);
        // 这个目录里有没有"被信任才生效"的东西（2026-11-13）：
        // 没有 → 信任与否毫无区别，别报"不会加载"吓人。
        const gated = this.gatedByTrust(abs);
        const trusted = this.trust.isTrusted(abs);
        const withheld: string[] = [];
        if (gated.mcp) withheld.push("项目级 MCP 配置");
        if (gated.skills) withheld.push("项目级技能");
        // 审计 #7：信任确认页要展示"会跑什么命令"——只说"有配置"等于让用户闭眼点头。
        // 未信任且带 MCP 时把 server 清单（命令/参数/env 键名，值不下发）随结果带出。
        const mcpServers =
          gated.mcp && !trusted
            ? loadMcpConfigAt(path.join(abs, ".lynn", "mcp.json")).servers.map((s) => ({
                id: s.id,
                command: s.command,
                args: s.args ?? [],
                envKeys: Object.keys(s.env ?? {}),
              }))
            : undefined;
        this.card({
          kind: "system",
          text: withheld.length
            ? `工作区已换成 ${abs}（原 ${from}）。@ 文件检索、附件与 Pi 的 cwd 都跟着走。` +
                `这个目录里有${withheld.join("与")}，未信任不会加载。`
            : `工作区已换成 ${abs}（原 ${from}）。@ 文件检索、附件与 Pi 的 cwd 都跟着走。`,
        });
        return {
          ok: true,
          root: abs,
          trusted,
          gated,
          ...(mcpServers ? { mcpServers } : {}),
          project: { id: proj.id, name: proj.name },
        } as RpcContracts[M]["result"];
      }

      case "project.clearRoot": {
        this.setSessionRoots(emptyRoots());
        if (this.currentThreadId) {
          try {
            this.threads.setProjectId(this.currentThreadId, null);
          } catch {
            /* 索引写失败不影响本次会话 */
          }
        }
        this.card({
          kind: "system",
          text: "这个会话先不用工作区：接下来的任务产出会落在任务卷宗里（~/.lynn/tasks/<id>/workspace）。随时可以在顶栏再选一个。",
        });
        return { ok: true } as RpcContracts[M]["result"];
      }

      /** 项目列表：跨群的一等实体（同一个目录 = 同一个项目） */
      case "project.list": {
        const current = this.currentProject();
        return {
          projects: this.projects.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
          ...(current ? { current: { id: current.id, name: current.name, path: current.path } } : {}),
        } as RpcContracts[M]["result"];
      }

      /** 改项目显示名：所有绑在它上面的群一起变（改的是项目，不是某一群） */
      case "project.rename": {
        const p = params as { id: string; name: string };
        const rec = this.projects.rename(String(p.id ?? ""), String(p.name ?? ""));
        if (!rec) return { ok: false, error: "项目不存在" } as RpcContracts[M]["result"];
        return { ok: true, id: rec.id, name: rec.name } as RpcContracts[M]["result"];
      }

      /** 当前群切到某个项目：主根跟着项目目录走 */
      case "project.use": {
        const p = params as { id: string };
        const rec = this.projects.resolve(String(p.id ?? ""));
        if (!rec) return { ok: false, error: "项目不存在" } as RpcContracts[M]["result"];
        const dirErr = rootDirError(rec.path);
        if (dirErr) return { ok: false, error: dirErr } as RpcContracts[M]["result"];
        this.setSessionRoots({ ...this.roots, primary: rec.path });
        this.bindProject(rec);
        return { ok: true, id: rec.id, name: rec.name, root: rec.path } as RpcContracts[M]["result"];
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

      // 数据用量与清理（data.*）已迁到 rpc-registry.ts 的 data 域
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
        const meta = this.threads.create("新群", inherited);
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
