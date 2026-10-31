/**
 * Lynn 类型化 IPC 契约（唯一契约，单一来源）。
 * 渲染层与主进程只通过 `lynn:rpc` 通道以 JSON-RPC 语义通信：
 *   request  → { method: RpcMethod, params: P }
 *   response → RpcResult<method>
 * 未来接入 Pi 内核（JSON-RPC over stdio）时，本契约保持不变，
 * 主进程把调用转发到内核即可——渲染层无感。
 */

// ---------- 基础枚举 ----------

export type PermissionMode = "plan" | "ask" | "auto" | "full";

/** 任务流水线阶段（§4.10.4 生命周期） */
export type TaskStage =
  | "accept" // 受理
  | "decompose" // 拆解
  | "staffing" // 组队
  | "dispatch" // 派单
  | "execute" // 执行
  | "review" // 审查
  | "report"; // 汇报

export type TaskStatus = "running" | "waiting" | "done" | "archived";

export type MemberStatus = "running" | "delivered" | "idle" | "stuck";

// ---------- 成员（书面岗位，§4.10.2） ----------

export interface Member {
  id: string;
  name: string;
  role: string;
  /** 岗位一句话（决定什么时候派给他） */
  goal: string;
  status: MemberStatus;
  statusNote: string;
  /** 0-100，执行中的进度 */
  progress: number;
  /** 已用 token / 预算 token */
  budgetUsed: number;
  budgetTotal: number;
  /** 打回次数 / 上限 */
  rejections: number;
  rejectionLimit: number;
  toolWhitelist: string[];
  /** 头像底色（mock 阶段用，正式版由形象/头像插件决定） */
  color: string;
}

export interface Team {
  id: string;
  name: string;
  members: Member[];
}

// ---------- 任务与卷宗（§4.8） ----------

export interface Task {
  id: string;
  title: string;
  stage: TaskStage;
  /** 已完成的阶段数（用于执行 x/y 展示） */
  stageProgress: string;
  status: TaskStatus;
  statusNote: string;
  teamId: string | null;
  deadline: string | null;
}

// ---------- 指挥频道卡片（§3.8 证据链卡） ----------

export type CardKind =
  | "user" // 你的指令
  | "accept" // 她的受理/拆解
  | "dispatch" // 派单卡
  | "member_report" // 成员回报卡（带证据）
  | "review_reject" // 审查打回卡
  | "approval" // 归集审批卡（需要你拍板）
  | "lynn_report" // 她的汇报/进度
  | "typing"; // 进行中指示

export interface Evidence {
  id: string;
  kind: "file" | "command" | "snapshot" | "brief";
  label: string;
  /** 弹窗标题 */
  title: string;
  /** 终端/预览文本（可复跑的命令输出等） */
  body: string;
}

export interface FeedCard {
  id: string;
  kind: CardKind;
  createdAt: string;
  /** user/lynn 气泡文本；组织卡为空 */
  text?: string;
  /** 组织卡标题，如「林工 · 抓取并清洗 9 月订单明细」 */
  title?: string;
  /** 徽章文本，如「派单」「打回 第1/3轮」 */
  badge?: string;
  meta?: string;
  body?: string;
  /** 卡内成员 chips */
  members?: { id: string; name: string; role: string; color: string }[];
  /** 证据 chips（可点开） */
  evidence?: Evidence[];
  /** 审批卡动作 */
  actions?: ("approve" | "reject" | "ask")[];
}

// ---------- 指挥板（§3.8） ----------

export interface TaskTrackItem {
  id: string;
  title: string;
  status: TaskStatus;
  statusNote: string;
}

export interface Decision {
  id: string;
  /** 升级 / 口径 / 审批 … */
  from: string;
  title: string;
  detail: string;
}

export interface BudgetInfo {
  teamUsed: number;
  teamTotal: number;
  lynnUsed: number;
  membersUsed: number;
  costYuan: number;
}

export interface BoardData {
  team: Team | null;
  track: TaskTrackItem[];
  decisions: Decision[];
  budget: BudgetInfo;
}

// ---------- 会话快照（渲染层一次拉全） ----------

export interface SessionSnapshot {
  workspace: { project: string; subdir: string };
  permission: PermissionMode;
  model: { name: string; thinking: boolean };
  task: Task | null;
  feed: FeedCard[];
  board: BoardData;
}

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
  "feed.send": {
    params: { text: string };
    result: { ok: true; cards: FeedCard[] };
  };
  "decision.resolve": {
    params: { id: string; action: "approve" | "reject" | "ask" };
    result: { ok: true; resolvedId: string };
  };
  "evidence.get": {
    params: { id: string };
    result: Evidence;
  };
}

export type RpcMethod = keyof RpcContracts;

/** 渲染层 preload 暴露的调用签名 */
export type RpcClient = <M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
) => Promise<RpcContracts[M]["result"]>;

/** preload 挂到 window 上的桥 */
export interface LynnBridge {
  rpc: RpcClient;
}

// 渲染层访问桥的全局声明
declare global {
  interface Window {
    lynn: LynnBridge;
  }
}
