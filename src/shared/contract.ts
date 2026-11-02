/**
 * Lynn 类型化 IPC 契约（唯一契约，单一来源）。
 * 渲染层与主进程只通过两个通道通信：
 *   1. `lynn:rpc`     —— JSON-RPC 语义：invoke(method, params) → result
 *   2. `lynn:event`   —— 主进程推送：流式 delta / 工具调用 / 完成 / 错误
 * 内核当前是主进程内的直连实现（OpenAI 兼容协议 + 管理工具 8 件套）；
 * 未来接入 Pi 运行时（JSON-RPC over stdio）时本契约保持不变。
 */

import type { UiSlot } from "./ui-plugin";

// ---------- 基础枚举 ----------

export type PermissionMode = "plan" | "ask" | "auto" | "full";

/** 工单状态（§4.10.4 七态，权威字段；界面阶段全由它驱动） */
export type TaskStatus =
  | "backlog" // 待受理
  | "todo" // 待派单
  | "in_progress" // 执行中
  | "in_review" // 待审查
  | "blocked" // 卡住
  | "done" // 已归档
  | "canceled"; // 已取消

export type MemberStatus = "running" | "delivered" | "idle" | "stuck";

// ---------- 模型配置（用户自配，§4.4） ----------

/** 存储层的模型配置（apiKey 加密落盘，不进渲染层） */
export interface ModelConfigStored {
  provider: string;
  baseUrl: string;
  model: string;
  /** safeStorage 加密后的 base64，或明文（不可用时降级并打标） */
  apiKey: { encrypted: boolean; data: string };
  updatedAt: string;
}

/** 渲染层可见的模型配置（永不含 apiKey 明文） */
export interface ModelConfigView {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
}

// ---------- 成员（书面岗位，§4.10.2） ----------

export interface Member {
  name: string;
  role: string;
  goal: string;
  status: MemberStatus;
  statusNote: string;
  progress: number;
  budgetUsed: number;
  budgetTotal: number;
  rejections: number;
  rejectionLimit: number;
  toolWhitelist: string[];
  color: string;
  /** 成员默认模型（§4.10.2） */
  model?: string;
  /** 轮次上限（§4.10.3，界面必显项） */
  turnLimit?: number;
}

export interface Team {
  id: string;
  name: string;
  status: "active" | "paused" | "dissolved";
  members: Member[];
}

// ---------- 指挥频道卡片（§3.8 证据链卡） ----------

export type CardKind =
  | "user" // 你的指令
  | "lynn" // 她的话（流式组装）
  | "tool" // 工具调用卡（组队/派单/回报/审查/汇报/问询）
  | "system"; // 系统提示（未配置模型等）

/** 回合阶段（唯一真相源：前端只渲染它，不自己推） */
export type TurnPhase =
  | "idle"
  | "accepted" // 已收到，正在拆解
  | "planning" // 正在组队/派单
  | "awaiting_plan" // 计划已给出，等你确认
  | "working" // 成员在跑
  | "review" // 待你裁决
  | "done" // 已归档
  | "failed";

export interface TurnState {
  phase: TurnPhase;
  busy: boolean;
  /** 排队中的输入条数 */
  pending: number;
  taskId?: string;
  startedAt?: string;
  /** 正在跑的成员与进度（0–100），给编制表实时显示 */
  member?: string;
  progress?: number;
  /** 本轮写过哪些文件；canUndo=true 表示可以整体撤销 */
  canUndo?: boolean;
  changedFiles?: string[];
}

/** 用量读数：轮/会话两层 + 上下文占比（都由后端算，前端不估） */
export interface UsageView {
  turnIn: number;
  turnOut: number;
  sessionIn: number;
  sessionOut: number;
  contextTokens: number;
  contextWindow: number;
}

export interface QueueItem {
  id: string;
  text: string;
  at: string;
}

/** 任务契约（派单前给她与你的同一份说明） */
export interface TaskPlan {
  taskId: string;
  title: string;
  goal: string;
  acceptance: string[];
  member?: string;
  tools?: string[];
  budgetTokens?: number;
  deadline?: string;
}

export type ToolCardBadge =
  | "组队"
  | "派单"
  | "回报"
  | "审查"
  | "汇报"
  | "需要你拍板"
  | "工具"
  /** 纵深防御拦下了一条命令 */
  | "已拦截"
  /** 出站命令（已审计） */
  | "出站"
  /** 日程到点提醒（M2-01） */
  | "提醒";

export interface FeedCard {
  id: string;
  kind: CardKind;
  createdAt: string;
  /** user / lynn / system 的文本 */
  text?: string;
  /** 是否正在流式生成（lynn 卡） */
  streaming?: boolean;
  /** tool 卡 */
  badge?: ToolCardBadge;
  title?: string;
  meta?: string;
  body?: string;
  members?: { name: string; role: string; color: string }[];
  /** 归属工单（「往来」页签按它过滤；空 = 频道） */
  jobId?: string;
  /** 错误码：前端按码给动作，不拼后端原文 */
  code?: string;
  /** 错误卡附带的一个可执行动作 */
  action?: "settings" | "retry" | "logs" | "reload" | "none";
  /** 汇报卡的四段（一段不省） */
  report?: { conclusion: string; evidence: string; unfinished: string; decision: string };
}

// ---------- 指挥板（§3.8） ----------

export interface TaskTrackItem {
  id: string;
  teamId: string;
  title: string;
  status: TaskStatus;
  statusNote: string;
  /** 当前承办人（最近一次派单/回报的成员） */
  member?: string;
  /** 最近一次记录时间（ISO） */
  at?: string;
  /** 证据条数（界面证据链读数；无证据 = 0） */
  evidenceCount?: number;
  /** 乐观并发版本（权威工单记录才有） */
  version?: number;
  /** 单亲：拆解产出的子任务挂父工单 */
  parentId?: string;
  /** 打回轮次（权威工单记录才有） */
  rejectRounds?: number;
  /** 真实证据索引（可点开验证）；空数组=还没有证据 */
  evidence?: { label: string; ref: string; verified: boolean; at?: string }[];
  /** 她预填的打回三要素（来自最近一次打回） */
  rejectDraft?: { what: string; expect: string; deadline: string };
}

export interface Decision {
  id: string;
  from: string;
  title: string;
  detail: string;
  /** question=她问你；plan=任务契约待确认；approval=工具调用等你批准 */
  kind?: "question" | "plan" | "approval";
  jobId?: string;
  at?: string;
  checks?: { ok: boolean; text: string }[];
  plan?: TaskPlan;
}

export interface BoardData {
  teams: Team[];
  track: TaskTrackItem[];
  decisions: Decision[];
  /** 本次会话累计 token（来自 API usage；取不到就为 0，不造假数） */
  tokensUsed: number;
}

// ---------- 会话快照 ----------

/** 更新器状态（M1-23） */
export interface UpdateStatusView {
  supported: boolean;
  reason?: string;
  feedUrl?: string;
  version: string;
  latest?: string;
  phase: "idle" | "available" | "downloading" | "downloaded" | "none";
  percent?: number;
  error?: string;
}

export interface SessionSnapshot {
  workspace: { project: string; subdir: string };
  /** 当前项目：项目级扩展只在 trusted 时加载（M1-13） */
  project: { root: string; trusted: boolean; hasMcp: boolean };
  /** 当前会话线程与线程列表（M1-14） */
  thread: { id: string; title: string };
  threads: { id: string; title: string; updatedAt: string }[];
  permission: PermissionMode;
  model: ModelConfigView;
  feed: FeedCard[];
  board: BoardData;
  turn: TurnState;
  usage: UsageView;
  queue: QueueItem[];
  prefs: { autoStart: boolean; trayOnClose: boolean; notify: boolean };
}

// ---------- 事件流（主进程 → 渲染层） ----------

export type KernelEvent =
  | { type: "delta"; text: string; cardId?: string }
  | {
      type: "card";
      card: FeedCard;
      /** 只在增量事件里出现的对账序号；前端按 id upsert */
      replaced?: boolean;
    }
  | {
      type: "tool";
      badge: ToolCardBadge;
      title: string;
      meta?: string;
      body?: string;
      members?: FeedCard["members"];
      jobId?: string;
      report?: FeedCard["report"];
    }
  | { type: "turn"; turn: TurnState }
  | { type: "done"; tokens: number }
  | { type: "error"; code?: string; message: string; action?: FeedCard["action"] };

// ---------- RPC 方法表 ----------

export interface RpcContracts {
  "session.snapshot": {
    params: void;
    result: SessionSnapshot;
  };
  "permission.set": {
    params: { mode: PermissionMode };
    result: { ok: true; mode: PermissionMode };
  };
  /**
   * 发送一条消息；回复经事件流推送，本调用只回执。
   * mode: steer=插话（改变当前方向）；queue=排队（本轮结束后执行，默认）
   */
  "feed.send": {
    params: {
      text: string;
      mode?: "steer" | "queue";
      /** 本轮随附（M1-16）：文件为项目工作区相对路径，图片为 data URL */
      attachments?: { files?: string[]; images?: { name: string; data: string }[] };
    };
    result: { ok: true; queued: boolean; queueId?: string };
  };
  /** 项目工作区文件检索（@ 提及补全，M1-16） */
  "files.search": {
    params: { q: string; limit?: number };
    result: { files: { path: string; size: number }[] };
  };
  /** persona.md 语气人设（M1-17） */
  "persona.get": {
    params: void;
    result: { text: string };
  };
  "persona.save": {
    params: { text: string };
    result: { ok: boolean; versionId: string; /** 是否已热同步到运行中的 Pi worker（false = 无 worker 或直连，自然生效） */ hot: boolean };
  };
  "persona.versions": {
    params: void;
    result: { versions: { id: string; savedAt: string; chars: number }[] };
  };
  "persona.rollback": {
    params: { id: string };
    result: { ok: boolean; text: string; hot: boolean };
  };
  /** 更新器（M1-23）：supported=false 时 reason 说明原因（开发环境/未配置源），不假装检查成功 */
  "update.status": {
    params: void;
    result: {
      supported: boolean;
      reason?: string;
      feedUrl?: string;
      version: string;
      latest?: string;
      phase: "idle" | "available" | "downloading" | "downloaded" | "none";
      percent?: number;
      error?: string;
    };
  };
  "update.check": {
    params: void;
    result: UpdateStatusView;
  };
  "update.download": {
    params: void;
    result: UpdateStatusView;
  };
  "update.install": {
    params: void;
    result: UpdateStatusView;
  };
  /** 会话记忆两层（M2-05）：kind = user（永远保留）| memory（可 diff/回滚） */
  "memory.get": {
    params: { kind: "user" | "memory" };
    result: { text: string };
  };
  "memory.save": {
    params: { kind: "user" | "memory"; text: string };
    result: { ok: boolean; versionId: string; hot: boolean };
  };
  "memory.versions": {
    params: { kind: "user" | "memory" };
    result: { versions: { id: string; savedAt: string; chars: number }[] };
  };
  "memory.diff": {
    params: { kind: "user" | "memory"; versionId?: string };
    result: { changes: { t: "same" | "add" | "del"; line: string }[] };
  };
  "memory.rollback": {
    params: { kind: "user" | "memory"; versionId: string };
    result: { ok: boolean; text: string; hot: boolean };
  };
  /** 多 provider（M2-12）：预设只是推荐值；models.yaml 增删厂商不改主程序 */
  "providers.presets": {
    params: void;
    result: {
      presets: { id: string; name: string; baseUrl: string; models: string[]; contextWindow: number; pricing?: { input: number | null; output: number | null; note?: string } }[];
    };
  };
  "providers.list": {
    params: void;
    result: { providers: { id: string; name?: string; baseUrl: string; models: string[] }[]; error?: string };
  };
  "providers.save": {
    params: { providers: { id: string; name?: string; baseUrl: string; models: string[]; contextWindow?: number }[] };
    result: { ok: boolean };
  };
  "providers.discover": {
    params: { baseUrl: string; apiKey?: string };
    result: { models: string[]; error?: string };
  };
  /** 本地日历（M2-01）：自然语言录入；解析不了如实报，不猜 */
  "calendar.add": {
    params: { text: string; remindLead?: number };
    result: { ok: boolean; event?: { id: number; title: string; at: string }; matched?: string; defaultedTime?: boolean; error?: string };
  };
  "calendar.list": {
    params: { includePast?: boolean };
    result: { events: { id: number; title: string; at: string; status: string }[]; backend: "sqlite" | "json" };
  };
  "calendar.finish": {
    params: { id: number; status?: "done" | "canceled" };
    result: { ok: boolean };
  };
  "calendar.todo.add": {
    params: { text: string };
    result: { ok: boolean; id: number };
  };
  "calendar.todo.list": {
    params: void;
    result: { todos: { id: number; text: string; due?: string }[] };
  };
  "calendar.todo.finish": {
    params: { id: number };
    result: { ok: boolean };
  };
  "calendar.scan": {
    params: void;
    result: { ok: boolean };
  };
  "schedule.tick": {
    params: void;
    result: { ok: boolean };
  };
  /** 知识库（M2-04）：markdown 权威 + FTS5 trigram 中文检索 */
  "kb.search": {
    params: { q: string; limit?: number };
    result: { hits: { file: string; title: string; snippet: string; score: number }[]; error?: string };
  };
  "kb.list": {
    params: void;
    result: { docs: { file: string; title: string; chars: number }[]; backend: string };
  };
  "kb.read": {
    params: { file: string };
    result: { ok: boolean; title?: string; body?: string; error?: string };
  };
  "kb.reindex": {
    params: void;
    result: { indexed: number; removed: number; docs: number; dbBytes: number };
  };
  /** 定时任务（M2-02）：调度器在核心里；单飞/补跑/陈旧清理，lastStatus 如实 */
  "schedule.add": {
    params: { name: string; prompt: string; kind: "once" | "daily" | "interval"; at?: string; time?: string; intervalMin?: number };
    result: { ok: boolean; task: { id: string; name: string; nextRun?: string } };
  };
  "schedule.list": {
    params: void;
    result: { tasks: { id: string; name: string; kind: string; enabled: boolean; nextRun?: string; lastRun?: string; lastStatus?: string }[] };
  };
  "schedule.remove": {
    params: { id: string };
    result: { ok: boolean };
  };
  "schedule.toggle": {
    params: { id: string };
    result: { ok: boolean; enabled?: boolean; error?: string };
  };
  /** 停止当前这一轮（保留已产出文本） */
  "session.abort": {
    params: void;
    result: { ok: boolean; aborted: boolean };
  };
  /** 重建运行时进程（下一条消息重新起；上下文从会话文件恢复） */
  "session.reload": {
    params: void;
    result: { ok: boolean };
  };
  /** 项目信任（M1-13）：未信任不加载项目级 mcp.json */
  "trust.set": {
    params: { trusted: boolean };
    result: { ok: boolean; trusted: boolean; root: string; reloading: boolean };
  };
  /** 会话线程（M1-14） */
  "thread.list": {
    params: void;
    result: { id: string; title: string; updatedAt: string }[];
  };
  "thread.new": {
    params: { title?: string };
    result: { ok: boolean; thread: { id: string; title: string } };
  };
  "thread.switch": {
    params: { id: string };
    result: { ok: boolean; thread: { id: string; title: string } };
  };
  "thread.rename": {
    params: { id: string; title: string };
    result: { ok: boolean; title: string };
  };
  "thread.remove": {
    params: { id: string };
    result: { ok: boolean };
  };
  "thread.search": {
    params: { q: string };
    result: { results: { id: string; title: string; hits: string[] }[] };
  };
  /** 撤销上一轮的文件改动（检查点回滚：改过的还原、新建的删掉） */
  "session.undo": {
    params: Record<string, never>;
    result: { ok: boolean; restored?: number; removed?: number; error?: string };
  };
  /** 记住当前主题底色（首帧用，避免白闪/错色闪） */
  "app.appearance": {
    params: { mode: string; desk: string };
    result: { ok: boolean };
  };
  /** 打开一条证据（限定在该工单工作区内；越界拒绝） */
  "evidence.open": {
    params: { taskId: string; ref: string };
    result: { ok: boolean; error?: string };
  };
  /** 打开数据目录 / 日志目录（系统文件管理器） */
  "app.openData": {
    params: { kind: "data" | "logs" };
    result: { ok: boolean; path: string };
  };
  /** 排队输入：列出 / 清空 / 撤回一条 */
  "session.queue": {
    params: { action: "list" | "clear" | "remove"; id?: string };
    result: { items: QueueItem[] };
  };
  /**
   * 回答她升级上来的问题 / 对任务契约做决定。
   * question: answer 必须带 text；plan: start=开工、revise=带 text 改一版、reject=先不做
   */
  "decision.resolve": {
    params: { id: string; action: "answer" | "start" | "revise" | "reject"; text?: string };
    result: { ok: true } | { ok: false; error: string };
  };
  /** 你对工单的裁决（印章区）：验收归档 / 打回重做（§4.10.5 的"用户显式拍板"） */
  "task.decide": {
    params: {
      taskId: string;
      action: "approve" | "reject";
      reason?: { what: string; expect: string; deadline: string };
    };
    result:
      | { ok: true; status: TaskStatus; escalated?: boolean }
      | { ok: false; error: string };
  };
  "config.get": {
    params: void;
    result: ModelConfigView;
  };
  "config.save": {
    params: { provider: string; baseUrl: string; model: string; apiKey?: string };
    result: { ok: true };
  };
  "config.test": {
    params: { baseUrl: string; apiKey: string; model: string };
    result: { ok: true; latencyMs: number } | { ok: false; error: string };
  };
  /** 偏好设置（目前只有"任务契约自动开始"） */
  "config.prefs": {
    params: { autoStart: boolean; trayOnClose?: boolean; notify?: boolean };
    result: { ok: true; autoStart: boolean; trayOnClose: boolean; notify: boolean };
  };
  /** 清除已保存的 API Key（保留端点与模型） */
  "config.clearKey": {
    params: void;
    result: { ok: boolean };
  };
  "session.new": {
    params: void;
    result: { ok: true };
  };
  /** 桌宠模式（P2）：独立透明置顶小窗，单击唤回主界面 */
  "pet.open": { params: void; result: { ok: true } };
  "pet.close": { params: void; result: { ok: true } };
  "pet.focus": { params: void; result: { ok: true } };
  /** 已装插件（L0 可加载；L1/L2 先列出、标记待接入） */
  "plugins.list": {
    params: void;
    result: {
      plugins: {
        id: string;
        name: string;
        version: string;
        tier: string;
        enabled: boolean;
        loadable: boolean;
        description?: string;
        theme?: { name?: string; dark?: Record<string, string>; light?: Record<string, string> };
      }[];
      errors: string[];
    };
  };
  "plugins.toggle": {
    params: { id: string; enabled: boolean };
    result: { ok: true };
  };
  /** 隔离试装：一次性进程里跑起来、调用一次、再杀干净（L2 走真实 MCP 握手） */
  "plugins.probe": {
    params: { id: string };
    result: { ok: boolean; detail: string };
  };
  /** 插件集指纹 / 安全模式 / 快照列表 */
  "plugins.status": {
    params: void;
    result: {
      fingerprint: string;
      count: number;
      safeMode: boolean;
      safeModeReason?: string;
      snapshots: { file: string; at: string; reason: string; count: number }[];
    };
  };
  /** 一键回滚：恢复启用状态快照（不动用户数据） */
  "plugins.rollback": {
    params: { file?: string };
    result: { ok: boolean; detail: string };
  };
  /** 磁盘上的 U 档插件（渲染层只拿 manifest + iframe 文档，不碰文件系统） */
  "ui.plugins": {
    params: void;
    result: {
      plugins: {
        id: string;
        name: string;
        version: string;
        slots: UiSlot[];
        source: "official" | "third-party";
        sandbox: boolean;
        description?: string;
        /** iframe 文档内容（已按白名单校验过 manifest） */
        html?: string;
      }[];
      errors: string[];
    };
  };
}

export type RpcMethod = keyof RpcContracts;

/** 渲染层 preload 暴露的调用签名 */
export type RpcClient = <M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
) => Promise<RpcContracts[M]["result"]>;

export interface LynnBridge {
  rpc: RpcClient;
  /** 订阅内核事件；返回取消订阅函数 */
  onEvent: (cb: (ev: KernelEvent) => void) => () => void;
}

declare global {
  interface Window {
    lynn: LynnBridge;
  }
}
