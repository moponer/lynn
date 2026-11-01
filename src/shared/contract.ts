/**
 * Lynn 类型化 IPC 契约（唯一契约，单一来源）。
 * 渲染层与主进程只通过两个通道通信：
 *   1. `lynn:rpc`     —— JSON-RPC 语义：invoke(method, params) → result
 *   2. `lynn:event`   —— 主进程推送：流式 delta / 工具调用 / 完成 / 错误
 * 内核当前是主进程内的直连实现（OpenAI 兼容协议 + 管理工具 8 件套）；
 * 未来接入 Pi 运行时（JSON-RPC over stdio）时本契约保持不变。
 */

// ---------- 基础枚举 ----------

export type PermissionMode = "plan" | "ask" | "auto" | "full";

export type TaskStatus = "running" | "waiting" | "done" | "archived";

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

export type ToolCardBadge = "组队" | "派单" | "回报" | "审查" | "汇报" | "需要你拍板" | "工具";

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
}

// ---------- 指挥板（§3.8） ----------

export interface TaskTrackItem {
  id: string;
  teamId: string;
  title: string;
  status: TaskStatus;
  statusNote: string;
}

export interface Decision {
  id: string;
  from: string;
  title: string;
  detail: string;
}

export interface BoardData {
  teams: Team[];
  track: TaskTrackItem[];
  decisions: Decision[];
  /** 本次会话累计 token（来自 API usage；取不到就为 0，不造假数） */
  tokensUsed: number;
}

// ---------- 会话快照 ----------

export interface SessionSnapshot {
  workspace: { project: string; subdir: string };
  permission: PermissionMode;
  model: ModelConfigView;
  feed: FeedCard[];
  board: BoardData;
}

// ---------- 事件流（主进程 → 渲染层） ----------

export type KernelEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; badge: ToolCardBadge; title: string; meta?: string; body?: string; members?: FeedCard["members"] }
  | { type: "done"; tokens: number }
  | { type: "error"; message: string };

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
  /** 发送一条消息；回复经事件流推送，本调用只回执 */
  "feed.send": {
    params: { text: string };
    result: { ok: true };
  };
  /** 回答她升级上来的问题（归集审批/口径选择） */
  "decision.resolve": {
    params: { id: string; action: "approve" | "reject" | "ask" };
    result: { ok: true };
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
  "session.new": {
    params: void;
    result: { ok: true };
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
