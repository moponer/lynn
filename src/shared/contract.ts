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

// ---------- 截图（壳层能力，M2-13 消费侧） ----------

/** 选区矩形；坐标一律是选区窗口内的 DIP，物理像素换算在主进程做 */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureSize {
  width: number;
  height: number;
}

/** 自动识别到的窗口（选区窗内 DIP 坐标，按面积升序） */
export interface CaptureWindow {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

/** 一张已裁好的截图：直接进本轮随附条，不写临时文件、不自动发送 */
export interface CaptureShot {
  /** 事件与待取队列双通道共用，渲染层按 id 去重 */
  id: string;
  name: string;
  /** data:image/png;base64,...（已含标注） */
  data: string;
  width: number;
  height: number;
  /** 捕获 + 合成编码耗时（毫秒），如实回显，不冒充端到端耗时 */
  ms: number;
  /** 是否真的写进了系统剪贴板（失败如实标 false） */
  copied?: boolean;
}

export interface CaptureStatus {
  /** 原生捕获引擎是否可用（缺平台二进制时如实为 false） */
  engine: boolean;
  engineError?: string;
  hotkey: string;
  /** 全局快捷键是否真的注册上了（被别的程序占用时为 false） */
  registered: boolean;
  active: boolean;
  note: string;
}

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

/** 模型库里一条的脱敏视图（编辑 / 删除 / 设为默认 / 用于当前对话） */
export interface ModelEntryView {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  isDefault: boolean;
  isThreadModel: boolean;
  updatedAt: string;
  /** 端点风险：本机/局域网、非 HTTPS、普通远程 */
  riskLevel: "local" | "insecure" | "remote";
  /** 用户是否已勾选风险确认（本机/非 HTTPS 保存前必须） */
  riskAccepted: boolean;
}

/** 本机免费/本地网关探测结果 */
export interface GatewayView {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  docsUrl: string;
  note: string;
  status: "running" | "down" | "needs_key";
  latencyMs?: number;
  modelCount?: number;
  error?: string;
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
  /** 本单实际授权（§4.10.3）：派单时落 assignments 的 tools；未派单/读不到时缺省=模板 */
  effectiveTools?: string[];
  color: string;
  /** 头像库 id：和岗位档案一致，成员卡/设置页/工具卡用同一张脸 */
  avatarId?: string;
  /** 成员默认模型（§4.10.2） */
  model?: string;
  /** 轮次上限（§4.10.3，界面必显项） */
  turnLimit?: number;
  /** 最近一步动作（"正在跑什么命令 / 写了哪个文件"）：进度条回答不了"在干什么" */
  lastStep?: string;
}

export interface Team {
  id: string;
  name: string;
  status: "active" | "paused" | "dissolved";
  members: Member[];
}

/** 编制管理（用户手动）：带岗位说明正文，设置页按需拉，不塞进每轮快照 */
export interface TeamAdminMember {
  name: string;
  role: string;
  /** 单一目标（成员收敛行为的依据） */
  goal: string;
  /** 岗位说明 / 角色提示词正文（Markdown） */
  body: string;
  /** 工具白名单（这里只读：扩权必须走风铃/模板导入的收窄校验） */
  tools: string[];
  model: string;
  /** 头像库 id：设置页里挑的那张，读出来才能让选择器高亮当前项 */
  avatarId?: string;
}

/** MCP 服务器实况（mcp.status / mcp.reload）：配置一条不少，连没连上照实说 */
export interface McpServerView {
  id: string;
  command: string;
  enabled: boolean;
  lazy: boolean;
  connected: boolean;
  tools: number;
  error?: string;
}

export interface McpStatusView {
  servers: McpServerView[];
  /** 全局配置路径（~/.lynn/mcp.json） */
  globalFile: string;
  /** 项目级配置路径（<project>/.lynn/mcp.json） */
  projectFile: string;
  /** 项目级配置是否被信任（未信任不加载） */
  projectTrusted: boolean;
  /** 配置文件本身读坏了的原因（有就如实报） */
  errors?: string[];
}

export interface TeamAdminView {
  id: string;
  name: string;
  status: "active" | "paused" | "dissolved";
  createdAt: string;
  members: TeamAdminMember[];
}

// ---------- 指挥频道卡片（§3.8 证据链卡） ----------

export type CardKind =
  | "user" // 你的指令
  | "lynn" // 她的话（流式组装）
  | "tool" // 工具调用卡（组队/派单/回报/审查/汇报/问询）
  | "system"; // 系统提示（未配置模型等）

// ---------- 群聊：谁在说话、@了谁（2026-11-12） ----------

/**
 * 卡片作者：群里"谁在说话"。
 * 与 kind 正交——kind 说的是"这是一类什么消息"（你/她/工具/系统），
 * author 说的是"这一条具体是谁说的"（成员有名字、有脸、有岗位）。
 * 旧卡没有 author，渲染层按 kind 回退旧语义（向后兼容，不改既有行为）。
 */
export type AuthorKind = "user" | "lynn" | "member" | "system";

export interface FeedAuthor {
  kind: AuthorKind;
  /** 成员名（member）/ "风铃"（lynn） */
  name?: string;
  /** 成员唯一键 = 名字（team-store 的派单匹配键与战绩主键） */
  memberId?: string;
  teamId?: string;
  /** 岗位（能力域），显示在成员名下 */
  role?: string;
  /** 头像库 id（a01…），没存的老档案按名字兜底 */
  avatarId?: string;
}

/** 被 @ 的人：群里定向诉求的落点（"不 @" = 只有风铃看见） */
export interface FeedMention {
  kind: "member" | "lynn";
  name: string;
  memberId?: string;
}


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
  /** 当前在做什么：模型在生成 / 某个工具在执行（渲染层据此显示状态行，避免长时间静默） */
  activity?: "model" | "tool";
  /** activity 的具体名字（工具名）；模型生成时为空 */
  activityName?: string;
  /** activity 的起始毫秒时间戳，渲染层用来算已用时 */
  activityAt?: number;
  /** 本轮写过哪些文件；canUndo=true 表示可以整体撤销 */
  canUndo?: boolean;
  changedFiles?: string[];
}

/** 用量读数：轮/会话两层 + 上下文占比（都由后端算，前端不估） */
export interface UsageView {
  turnIn: number;
  turnOut: number;
  /** 未命中缓存的输入 token（= 实际计费输入；不含缓存读/写） */
  sessionIn: number;
  sessionOut: number;
  /** 缓存命中 token（复用已有缓存，不再重新计费） */
  cacheRead: number;
  /** 缓存写入 token（本次新写入缓存，下一轮可复用；不含 DeepSeek 的 miss，它已在 sessionIn 里） */
  cacheWrite: number;
  /** 本轮缓存命中率（%）：只算这一轮的 prompt，不拿会话累计值冒充 */
  turnHitRate?: number | null;
  /** 累计费用（模型定价货币；未知价时为 0，不估假费用） */
  cost: number;
  contextTokens: number;
  contextWindow: number;
  /** 上下文占用百分比（0–100；压缩后首条回复前可能为 null = 未知，不显示假数） */
  contextPercent?: number | null;
}

/**
 * 缓存命中率（%）：命中 / (未命中输入 + 命中 + 写入)。
 * prompt 为 0 时返回 undefined，界面据此隐藏命中率而不是显示假 0。
 */
export function cacheHitRate(v: UsageView): number | undefined {
  const prompt = v.sessionIn + v.cacheRead + v.cacheWrite;
  return prompt > 0 ? (v.cacheRead / prompt) * 100 : undefined;
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
  /** 证据策略：required 才强制；缺省 optional（2026-11-11，普通任务不再被证据卡死） */
  evidencePolicy?: "required" | "optional";
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
  | "提醒"
  /** 成员执行中的跟踪进度（按时间追加到对话流底部，20 秒内折成一张卡） */
  | "进度"
  /** 成员被用户停掉 */
  | "已停止"
  /** 成员跑完但没有交出回报 */
  | "未完成"
  /** 心跳巡检（M3-01） */
  | "心跳"
  /** 风铃沉淀记忆（M3-01） */
  | "记忆"
  /** 成员执行崩溃 */
  | "崩溃"
  /** 删除类命令的低风险自清理：系统自动放行，不需要用户点头（留痕可回看） */
  | "放行";

/** 内置预览读文件的结果：kind 决定渲染层走哪条视图，永远不把路径交回前端 */
export interface PreviewReadResult {
  ok: boolean;
  /**
   * office：docx/xlsx/pptx 的原始字节（base64），渲染层用开源库
   * （docx-preview / @js-preview/excel / pptx-preview，全部懒加载）保真渲染。
   */
  kind: "text" | "image" | "binary" | "empty" | "missing" | "office" | "pdf";
  text?: string;
  /** 图片走 data URL，避免Electron file:// 协议与 CSP 打架 */
  dataUrl?: string;
  /** office：文件原始字节（base64），渲染层解码后交给对应开源库 */
  dataBase64?: string;
  ext?: string;
  bytes?: number;
  /** 超大文本只取开头一段，界面要如实标注 */
  truncated?: boolean;
  error?: string;
}

export interface FeedCard {
  id: string;
  kind: CardKind;
  createdAt: string;
  /** user / lynn / system 的文本 */
  text?: string;
  /** 是否正在流式生成（lynn 卡） */
  streaming?: boolean;
  /**
   * 同一张单反复撞同一堵墙（如权限拦截）时聚合计数：
   * 13 次"已拦截"只占一行，展开看最后一次的原因。0/1 不显示。
   */
  count?: number;
  /**
   * 思考过程（reasoning 模型才有；来自 Pi 的 thinking_delta）。
   * 跟正文分开存、分开渲染：正文只装 text_delta，思考单独成块、默认收起。
   */
  thinking?: string;
  /** tool 卡 */
  badge?: ToolCardBadge;
  title?: string;
  /** 系统消息类别：标签、图标与底色各不同（2026-11-12）；缺省 notice */
  systemTone?: "cleanup" | "budget" | "recover" | "patrol" | "auth" | "notice" | "error";
  meta?: string;
  body?: string;
  members?: { name: string; role: string; color: string; avatarId?: string }[];
  /** 归属工单（「往来」页签按它过滤；空 = 频道） */
  jobId?: string;
  /** 错误码：前端按码给动作，不拼后端原文 */
  code?: string;
  /** 错误卡附带的一个可执行动作（stopRunning：新会话时"还有单在跑"，一键全停） */
  action?: "settings" | "retry" | "logs" | "reload" | "stopRunning" | "none";
  /** 汇报卡的四段（一段不省） */
  report?: { conclusion: string; evidence: string; unfinished: string; decision: string };
  /**
   * 谁在说话（群聊模式）。缺省时按 kind 回退旧语义：
   * user → 你、lynn → 风铃、tool → 工具卡、system → 系统提示。
   */
  author?: FeedAuthor;
  /** 这条消息 @ 了谁（群里定向）。空 = 没有定向诉求 */
  mentions?: FeedMention[];
  /**
   * 产物清单（验收/汇报卡）：ref 指向卷宗里的副本，点一下走内置预览。
   * 只有 ref 不点开就等于让用户自己去找文件——实机她只给了绝对路径字符串。
   */
  artifacts?: { label: string; ref: string; bytes?: number }[];
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
  /**
   * 验收人：lynn = 派给成员的活，风铃自己验（她点头即归档，不弹给用户）；
   * user = 风铃交付给用户的最终结果，只有用户能拍板。缺省按 user。
   */
  reviewer?: "lynn" | "user";
  /** 真实证据索引（可点开验证）；空数组=还没有证据 */
  evidence?: { label: string; ref: string; verified: boolean; at?: string }[];
  /** 交付物（用户要带走的东西；验收后永久保留） */
  deliverables?: { path: string; ref: string; bytes?: number }[];
  /** 她预填的打回三要素（来自最近一次打回） */
  rejectDraft?: { what: string; expect: string; deadline: string };
  /** 这张单是在哪个会话里派的（跨会话追溯） */
  threadId?: string;
  /** 本单第几轮：由卷宗派单/重做事件推导，只读展示（阶段状态机的数据底座） */
  round?: number;
  /** 卷宗时间线尾部（最新若干条）；全量仍在磁盘 timeline.jsonl，这里只供展示 */
  timeline?: { at: string; kind: string; text: string }[];
  /** 本单的只读授权目录（用户显式授予；空 = 只能读工作区） */
  readRoots?: string[];
  /** 成员的读写工作区（= 派单时会话的项目目录；可写，删除需用户点头） */
  workspaceRoot?: string;
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
  workspace: {
    project: string;
    subdir: string;
    /** 会话主根（空 = 这次不用工作区） */
    primary?: string;
    /** 会话附加根（只读/可写）；目录名太长，界面显示 label 或末段 */
    extras?: { path: string; mode: "rw" | "ro"; label?: string }[];
  };
  /** 当前项目：项目级扩展只在 trusted 时加载（M1-13） */
  project: { root: string; trusted: boolean; hasMcp: boolean };
  /** 当前会话线程与线程列表（M1-14） */
  thread: { id: string; title: string; projectRoot?: string };
  /** C3：会话行显示"这个会话派出过多少单"（后端按 task.threadId 汇总） */
  threads: {
    id: string;
    title: string;
    updatedAt: string;
    projectRoot?: string;
    counts?: { active: number; archived: number };
    /** 置顶（群列表排最前） */
    pinned?: boolean;
    /** 最近一条消息摘要（微信式群列表） */
    lastPreview?: string;
    /** 最近一次有消息的时刻 */
    lastAt?: string;
    /** 未读：没看的这段时间这个群又发生了多少事（切进去即清零） */
    unread?: number;
    /** 群公告（全局段） */
    announcement?: string;
  }[];
  /** 真在跑的成员单（不只 status=in_progress：卡住但没在跑的不能算） */
  running?: string[];
  /**
   * 无主单：threadId 指向已删会话的工单（老版本删会话不级联留下的）。
   * 不为 0 时界面要给一键清理出口，否则这些单永远留在台账里，谁也删不掉。
   */
  orphans?: number;
  permission: PermissionMode;
  model: ModelConfigView;
  feed: FeedCard[];
  board: BoardData;
  turn: TurnState;
  usage: UsageView;
  queue: QueueItem[];
  prefs: {
    autoStart: boolean;
    trayOnClose: boolean;
    notify: boolean;
    lang: "zh" | "en";
    /** D3：会话级软预算（0 = 未配置，界面不假装有预算） */
    softBudgetTokens?: number;
  };
}

// ---------- 事件流（主进程 → 渲染层） ----------

export type KernelEvent =
  /** 流式补字：text 是正文，thinking 是思考（两者互斥更新，渲染层分开落） */
  | { type: "delta"; text?: string; thinking?: string; cardId?: string }
  /** 壳层窗口事件（自绘标题栏）：最大化状态变化 */
  | { type: "window"; maximized: boolean }
  /** 截图完成：图片进输入框的「本轮随附」，用户自己决定发不发 */
  | { type: "capture"; shot: CaptureShot }
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
      artifacts?: FeedCard["artifacts"];
      /** 群聊：这张动作卡是谁做的（风铃派单 / 成员回报） */
      author?: FeedAuthor;
      /** 群聊：这张动作卡点名了谁（工具层强制 @，模型忘了写也补上） */
      mentions?: FeedMention[];
    }
  | { type: "turn"; turn: TurnState }
  /** 另一个会话有新动静（后台成员回报写回了它的出发会话）：前端只刷新，不 upsert */
  | { type: "thread"; threadId: string }
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
      /**
       * 群内 @成员（名字）。只是提示：内核按"本群成员名单"二次校验，
       * 陌生名字一律丢弃（防模型/前端报一个不存在的人）。
       */
      mentions?: { name: string }[];
    };
    result: { ok: true; queued: boolean; queueId?: string };
  };
  /** 项目工作区文件检索（@ 提及补全，M1-16） */
  "files.search": {
    params: { q: string; limit?: number };
    result: { files: { path: string; size: number }[] };
  };
  /**
   * 区域截图（壳层能力，M2-13 消费侧）：先冻结光标所在显示器，再由选区窗裁剪。
   * 截好的图只进「本轮随附」，不自动发送、不自动进剪贴板。
   */
  "capture.status": {
    params: void;
    result: CaptureStatus;
  };
  "capture.start": {
    params: void;
    result: { ok: boolean; error?: string };
  };
  /** 选区窗加载后取冻结帧 + 可自动识别的窗口矩形（不二次抓屏，也不会拍到选区窗自己） */
  "capture.frame": {
    params: void;
    /** view 是选区窗内容区的 DIP 尺寸；主进程已把冻结帧裁到这块，坐标口径完全对齐 */
    result: { ok: boolean; data?: string; width: number; height: number; view: CaptureSize; windows: CaptureWindow[]; error?: string };
  };
  /**
   * 完成：dataUrl 是选区窗把「冻结帧 + 标注」合成后按 rect 裁好的 PNG。
   * action: attach=进本轮随附条（并复制）、copy=只复制、save=另存为（不关闭选区窗）。
   * 主进程会核对 PNG 尺寸与 rect 是否一致，防止界面和落盘结果错位。
   */
  "capture.commit": {
    params: { rect: CaptureRect; dataUrl: string; action: "attach" | "copy" | "save" };
    result: { ok: boolean; error?: string; path?: string };
  };
  "capture.cancel": {
    params: void;
    result: { ok: true };
  };
  /** 事件丢失兜底：窗口刚起来或重新获得焦点时，取回并清空未消费的截图 */
  "capture.pending": {
    params: void;
    result: { shots: CaptureShot[] };
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
  /** ---------- 技能管理（M2-10）：发现/启停（禁用清单持久化在 prefs.disabledSkills） ---------- */
  "skills.list": {
    params: void;
    result: {
      skills: {
        name: string;
        description: string;
        allowedTools: string[];
        level: "user" | "project" | "plugin";
        dir: string;
        disabled: boolean;
        warnings: string[];
      }[];
      /** 解析失败/重名等诊断（不拦列表） */
      errors: string[];
    };
  };
  "skills.toggle": {
    params: { name: string; enabled: boolean };
    result: { ok: true; enabled: boolean } | { ok: false; error: string };
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
  /** office 引擎健康（M2-06）：csv 永远可用；xlsx 看引擎 */
  "office.health": {
    params: void;
    result: { found: boolean; kind: string; version?: string; sofficePath?: string; detail: string; csv: boolean; xlsx: boolean };
  };
  /** 视觉/OCR 模型（M2-13）：与对话模型解耦，独立配置 */
  "config.vision.get": {
    params: void;
    result: { configured: boolean; provider?: string; baseUrl?: string; model?: string; updatedAt?: string };
  };
  "config.vision.save": {
    params: { provider: string; baseUrl: string; model: string; apiKey?: string };
    result: { ok: boolean; error?: string };
  };
  "config.vision.clear": {
    params: void;
    result: { ok: boolean };
  };
  /** 停一张正在跑的成员单（不能只靠"解散全队"止损） */
  "task.cancel": {
    params: { taskId: string };
    result: { ok: boolean; error?: string };
  };
  /** 停掉所有在跑的成员单（C4：新会话时"还有 N 张单在跑"的一键止损） */
  "task.cancelAll": {
    params: void;
    result: { ok: boolean; stopped: number };
  };
  /** 内核构建信息（版本握手：前端据此判断"后台是不是旧版本"） */
  "app.info": {
    params: void;
    result: { buildAt: string };
  };
  /** 一键重启应用（壳层 app.relaunch）：改了代码没重启时，用户不必自己去托盘翻 */
  "app.restart": {
    params: void;
    result: { ok: boolean };
  };
  /**
   * 只读授权：允许这张单的成员**读**某个目录（写仍然只能在工作区）。
   * 只由用户在界面上发起（右键 → 授权只读目录），模型不能自我扩权。
   */
  "task.grantRead": {
    /** dir 兼容旧调用；dirs 支持一次授权多个；allowDriveRoot = 用户已确认整盘只读 */
    params: { taskId: string; dir?: string; dirs?: string[]; allowDriveRoot?: boolean };
    result: { ok: boolean; roots?: string[]; error?: string };
  };
  "task.revokeRead": {
    params: { taskId: string; dir?: string };
    result: { ok: boolean; roots?: string[]; error?: string };
  };
  /** 选目录（壳层原生对话框），只给授权入口用 */
  "app.pickDir": {
    params: { title?: string };
    result: { path?: string; canceled?: boolean };
  };
  /** 一次选多个目录（只读授权用；多选是常态，不再一个个点） */
  "app.pickDirs": {
    params: { title?: string };
    result: { paths?: string[]; canceled?: boolean };
  };
  /**
   * 审查快照：把这张单的工作区（只读看过/要跑测试的项目）复制进任务沙箱，
   * 之后成员在副本里跑构建测试，原项目不动。
   */
  "task.snapshotProject": {
    params: { taskId: string };
    result: { ok: boolean; error?: string; root?: string; bytes?: number };
  };
  /** 导出任务卷宗 zip（task.json / timeline / summary / artifacts / 交付清单） */
  "task.export": {
    params: { taskId: string };
    result: { ok: boolean; error?: string; path?: string };
  };
  /** 用系统程序打开一个路径（仅限数据根内，防止被当成任意文件执行器） */
  "app.openPath": {
    params: { path: string };
    result: { ok: boolean; error?: string };
  };
  /** 取消一张单（→ canceled，进归档带；在跑的会先停成员） */
  "task.dismiss": {
    params: { taskId: string };
    result: { ok: boolean; error?: string };
  };
  /**
   * 从台账彻底删掉一张单（连同 tasks/<id>/ 目录；在跑的不许删）。
   * removed = 实际删掉的东西；kept = 没有动的路径（用户项目 / 跨任务共享的工作区）。
   */
  "task.remove": {
    params: { taskId: string };
    result: { ok: boolean; error?: string; removed?: string[]; kept?: string[] };
  };
  /**
   * 清掉无主单：threadId 指向已删会话的工单（老版本删会话只删了对话记录）。
   * 没有 threadId 的历史单不算无主——那可能是早于会话归属的记录，不猜、不删。
   */
  "task.purgeOrphans": {
    params: void;
    result: { ok: boolean; removed: number; kept: number };
  };
  /** 建团队（§4.10.3 修正）：用户只给名字，ID 由系统生成 */
  "team.create": {
    params: { name?: string };
    result: { ok: boolean; id?: string; name?: string; error?: string };
  };
  /** 编制管理：列出全部团队与成员岗位（含岗位说明正文） */
  "team.list": {
    params: void;
    result: { teams: TeamAdminView[]; error?: string };
  };
  /** 单个成员战绩：成员卡按需拉，不塞进每轮快照（快照每几秒一次，扫卷宗太贵） */
  "team.member.record": {
    params: { teamId: string; name: string };
    result: { tasks: number; accepted: number; rejected: number; escalations: number };
  };
  /** 改成员岗位：角色 / 单一目标 / 提示词正文 / 头像库 id（不给扩工具权限） */
  "team.member.save": {
    params: { teamId: string; name: string; role?: string; goal?: string; body?: string; avatarId?: string };
    result: { ok: true } | { ok: false; error: string };
  };
  /** 删成员：只删岗位档案（派单/回报记录留作审计资产）；手上有单先停 */
  "team.member.remove": {
    params: { teamId: string; name: string };
    result: { ok: true } | { ok: false; error: string };
  };
  /** 解散团队：档案保留为资产、不能再派活；手上有单先停 */
  "team.dissolve": {
    params: { teamId: string };
    result: { ok: true } | { ok: false; error: string };
  };
  /** 模板导出/导入（M2-15）：导入白名单只收窄（越权工具剥掉并告警） */
  "team.exportTemplate": {
    params: { name: string; outFile: string };
    result: { ok: boolean; file?: string; error?: string };
  };
  "team.importTemplate": {
    params: { json: string };
    result: {
      ok: boolean;
      name?: string;
      members?: number;
      proposal?: { name: string; members: { name: string; role: string; tools: string[] }[]; warnings: string[] };
      error?: string;
    };
  };
  /** 消息平台（M2-16）：合规路径（官方 API + 用户自建应用）；收消息未实现如实标注 */
  "msg.status": {
    params: void;
    result: {
      compliance: string;
      feishu: { appId: string; enabled: boolean; updatedAt: string } | null;
      qq: { appId: string; enabled: boolean; updatedAt: string } | null;
      receiveSupported: boolean;
    };
  };
  "msg.configure": {
    params: { channel: "feishu" | "qq"; appId: string; appSecret?: string; enable?: boolean };
    result: { ok: boolean; compliance?: string; error?: string };
  };
  "msg.send": {
    params: { channel: "feishu" | "qq"; receiveId: string; text: string };
    result: { ok: boolean; error?: string };
  };
  /** MCP 扩展服务器（L2）：配置里有什么 + 实际连上没连上，两个都如实报 */
  "mcp.status": {
    params: void;
    result: McpStatusView;
  };
  /** 立刻重连（不重启应用）：返回重连后的实况 */
  "mcp.reload": {
    params: void;
    result: McpStatusView & { ok: true };
  };
  /** 定时任务（M2-02）：调度器在核心里；单飞/补跑/陈旧清理，lastStatus 如实 */
  "schedule.add": {
    params: { name: string; prompt: string; kind: "once" | "daily" | "interval"; at?: string; time?: string; intervalMin?: number };
    /** 失败要能说清原因（时间格式 / 缺字段），不要只回 ok:false */
    result: { ok: true; task: { id: string; name: string; nextRun?: string } } | { ok: false; error: string };
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
  /**
   * 删会话。会话是任务容器：连同它名下的工单一并撤掉（在跑的先停），
   * `removedTasks` 是真正清掉的单数，`keptTasks` 是因目录占用等原因留在台账里的。
   */
  "thread.remove": {
    params: { id: string };
    /** threadsLeft=0 表示刚才删掉的是最后一条：界面进空场，不偷偷补一条新会话 */
    result: { ok: boolean; removedTasks?: number; keptTasks?: number; threadsLeft?: number };
  };
  "thread.search": {
    params: { q: string };
    result: { results: { id: string; title: string; hits: string[] }[] };
  };
  /** 置顶 / 取消置顶（群列表微信式） */
  "thread.pin": {
    params: { id: string; pinned: boolean };
    result: { ok: boolean; pinned: boolean };
  };
  /**
   * 群公告 = 这个群的全局段（整体干什么 / 谁管哪段 / 接缝在哪 / 共享写入点归谁）。
   * 风铃每轮都能看见它——接缝没人接是并行协作的头号事故。
   */
  "thread.announcement": {
    params: { id: string; text: string };
    result: { ok: boolean; text: string };
  };
  /**
   * 成员档案全量（群聊模式：右键成员看"他是谁"）。
   * 岗位说明书 + 战绩 + 手上那张单。
   */
  "team.member.detail": {
    params: { teamId: string; name: string };
    result: {
      ok: boolean;
      error?: string;
      profile?: {
        name: string;
        role: string;
        goal: string;
        boundaries: string[];
        tools: string[];
        model: string;
        limits: { maxTurns: number; budgetTokens: number; wallClockMin: number };
        outputContract: { deliverable: string; evidence: string[]; acceptance: string[] };
        escalateWhen: string;
        body: string;
        avatarId?: string;
      };
      record?: { tasks: number; accepted: number; rejected: number; escalations: number };
      job?: { id: string; title: string; status: string };
    };
  };
  /**
   * 工单详情（群聊模式：右键成员看"他在做什么"）。
   * 目标 / 完成标准 / 状态 / 工作区 / 交付物 / 卷宗时间线尾部。
   */
  "task.detail": {
    params: { taskId: string };
    result: {
      ok: boolean;
      error?: string;
      detail?: {
        id: string;
        title: string;
        member?: string;
        teamId: string;
        status: string;
        statusNote: string;
        goal?: string;
        acceptance: string[];
        brief?: string;
        workspaceRoot?: string;
        deliverables: { label: string; ref: string; bytes?: number }[];
        timeline: { at: string; kind: string; text: string }[];
      };
    };
  };
  /**
   * 用户催办（群聊模式：右键成员"催一下"）。
   * 催办本身不越权：话照转给成员（下一轮生效），由风铃决定要不要返工或改口径。
   */
  "task.nudge": {
    params: { taskId: string; note?: string };
    result: { ok: boolean; error?: string; member?: string };
  };
  /**
   * 某张工单的往来。工单在 A 会话派出、用户切到 B 会话后，
   * 当前 feed 里没有它的卡，只能按 task.threadId 回原会话读。
   */
  "task.feed": {
    params: { taskId: string };
    result: { cards: FeedCard[]; threadId?: string; threadTitle?: string };
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
  /**
   * 内置预览：主进程读文件内容，渲染层自己排版/高亮，不启动外部关联程序。
   * 路径守卫与 evidence.open 一致：只在 tasks/<taskId>/ 内解析。
   */
  "preview.read": {
    params: { taskId: string; ref: string };
    result: PreviewReadResult;
  };
  /** PDF 预览：在应用内开一个独立窗口用内置阅读器看（路径守卫与 preview.read 一致） */
  "preview.pdfWindow": {
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
      /** reopen = 把已归档的单拉回执行中（风铃代验判错时的唯一退路，只有用户能开） */
      action: "approve" | "reject" | "reopen";
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
    /** 换端点却留空 Key 时如实拒绝（旧 Key 不能带到新服务商） */
    result: { ok: true } | { ok: false; error: string };
  };
  "config.test": {
    params: { baseUrl: string; apiKey: string; model: string };
    result: { ok: true; latencyMs: number } | { ok: false; error: string };
  };

  // ---------- 模型库：多条配置 / 全局默认 / 每对话覆盖 ----------

  "model.list": {
    params: void;
    result: {
      models: ModelEntryView[];
      defaultModelId: string | null;
      threadModelId: string | null;
      activeModelId: string | null;
      threadTitle: string;
    };
  };
  "model.save": {
    /** 不带 id = 新增；带 id = 编辑那条。apiKey 留空 = 沿用该条已保存的 Key */
    params: {
      id?: string;
      label: string;
      provider: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
      /** 本机/局域网/非 HTTPS 端点必须显式勾选 */
      riskAccepted?: boolean;
    };
    result: { ok: true; id: string } | { ok: false; error: string };
  };
  "model.remove": {
    params: { id: string };
    result: { ok: true; defaultModelId: string | null } | { ok: false; error: string };
  };
  "model.setDefault": {
    params: { id: string };
    result: { ok: true } | { ok: false; error: string };
  };
  /** null = 这个对话跟随全局默认 */
  "model.setThread": {
    params: { id: string | null };
    result: { ok: true } | { ok: false; error: string };
  };
  "model.test": {
    /** 传 id 测已保存的 Key；不传 id 用表单里临时填的 Key 测 */
    params: { id?: string; baseUrl?: string; apiKey?: string; model?: string };
    result: { ok: true; latencyMs: number } | { ok: false; error: string };
  };
  /** 自定义 OpenAI 兼容端点：拉 /v1/models，不消耗 token */
  "model.discover": {
    params: {
      id?: string;
      baseUrl: string;
      apiKey?: string;
      /** 本机/局域网/非 HTTPS 端点必须显式确认风险，才允许把 Key 发过去探测 */
      riskAccepted?: boolean;
    };
    result:
      | { ok: true; models: { id: string; ownedBy?: string; created?: number }[]; latencyMs: number; url: string }
      | { ok: false; error: string };
  };
  /** 端点健康检查：/models 优先，失败再退回一次最小 chat 探针 */
  "model.health": {
    params: { id?: string; baseUrl?: string; apiKey?: string; model?: string };
    result:
      | { ok: true; latencyMs: number; modelCount?: number; via: "models" | "chat" }
      | { ok: false; error: string; latencyMs?: number };
  };
  /** 本机常见免费/本地网关探测（只 GET /models，不发 Key，不自动启动进程） */
  "gateway.list": {
    params: void;
    result: { gateways: GatewayView[] };
  };
  /** 打开外部说明页（只允许 http/https） */
  "app.openExternal": {
    params: { url: string };
    result: { ok: boolean; error?: string };
  };

  /** 偏好设置（M2-11 加软预算与备用模型；M3-08 加界面语言；截图加快捷键；M3-01 加心跳） */
  "config.prefs": {
    params: { autoStart: boolean; trayOnClose?: boolean; notify?: boolean; softBudgetTokens?: number; fallbackModel?: string; lang?: "zh" | "en"; captureHotkey?: string; heartbeat?: boolean };
    result: { ok: true; autoStart: boolean; trayOnClose: boolean; notify: boolean; softBudgetTokens: number; fallbackModel: string; lang: "zh" | "en"; captureHotkey: string; heartbeat: boolean };
  };
  /** M3-08：当前界面语言的合并字典（内置 + 启用的语言包插件覆盖），渲染层按 lang 变化拉取 */
  "i18n.get": {
    params: void;
    result: {
      lang: "zh" | "en";
      strings: Record<string, string>;
      /** 参与合并的语言包插件 id（如实说明文案来源） */
      sources: string[];
    };
  };
  /** 清除已保存的 API Key（保留端点与模型） */
  "config.clearKey": {
    params: void;
    result: { ok: boolean };
  };
  "session.new": {
    /** projectRoot：这个会话的工作区（开会话时选；不传 = 沿用当前） */
    params: { projectRoot?: string };
    result: { ok: true; threadId?: string };
  };
  /** 换当前会话的工作区：影响 @ 检索、附件、Pi 的 cwd、项目级插件与 MCP */
  "project.setRoot": {
    params: { root: string };
    result: { ok: boolean; root?: string; trusted?: boolean; error?: string };
  };
  /** 这次不用工作区（临时对话）：主根清空，任务产出落卷宗沙箱 */
  "project.clearRoot": {
    params: void;
    result: { ok: boolean; error?: string };
  };
  /** 全局工作区偏好：默认主根 + 常用只读根（L0） */
  "workspace.prefs": {
    params: void;
    result: { defaultWorkspace?: string; knownReadRoots: string[] };
  };
  "workspace.savePrefs": {
    params: { defaultWorkspace?: string | null; knownReadRoots?: string[] };
    result: { ok: boolean; error?: string; defaultWorkspace?: string; knownReadRoots?: string[] };
  };
  /** 数据用量与保留策略（清理只碰过程文件，交付物与证据永久） */
  "data.usage": {
    params: void;
    result: {
      usage: {
        totalBytes: number;
        tasksBytes: number;
        scratchBytes: number;
        artifactsBytes: number;
        sandboxBytes: number;
        logsBytes: number;
        checkpointsBytes: number;
      };
      retention: { scratchDays: number; checkpointDays: number; logDays: number };
    };
  };
  "data.cleanup": {
    params: { retention?: { scratchDays?: number; checkpointDays?: number; logDays?: number } };
    result: { ok: true; freedBytes: number; removed: number };
  };
  /** 当前会话的根集合（主根 + 附加根）；readable/writable 是派生结果 */
  "workspace.get": {
    params: void;
    result: {
      primary?: string;
      extras: { path: string; mode: "rw" | "ro"; scope: string; label?: string }[];
      readable: string[];
      writable: string[];
    };
  };
  /** 给当前会话加一个附加根（rw 只能由用户入口调用；模型没有这个能力） */
  "workspace.addRoot": {
    params: {
      path: string;
      mode?: "rw" | "ro";
      scope?: "session" | "team" | "task";
      label?: string;
      /** 整盘只读需要用户显式确认 */
      allowDriveRoot?: boolean;
    };
    result: { ok: boolean; error?: string; roots?: string[] };
  };
  "workspace.removeRoot": {
    params: { path: string };
    result: { ok: boolean; error?: string; roots?: string[] };
  };
  /** 自绘标题栏（frame:false）：最小化 / 最大化还原 / 关闭（关闭尊重"关窗进托盘"设置） */
  "window.control": {
    params: { action: "minimize" | "maximize" | "close" | "query" };
    result: { ok: true; maximized: boolean };
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
        /** L0 形态层：插件内 CSS 原文（渲染层注入 <style>，不经脚本求值） */
        style?: string;
        /** M3-08：L0 语言包插件才有 */
        langs?: { lang: "zh" | "en"; strings: Record<string, string> }[];
        /** 占用的卡槽（设置页据此标注「控制台视图」等） */
        slots?: string[];
        /** 占内置视图卡槽时指名的视图 id */
        view?: string;
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
  /** 安全模式开关：连续崩溃自动进入，退出只能由用户显式点（人与机器各一侧的闸门） */
  "plugins.safeMode": {
    params: { on: boolean };
    result: { ok: true };
  };
  /** ---------- M3-07 插件工坊：规格 → 草稿区 → 准入 → 启用（§4.11） ---------- */
  "workshop.create": {
    params: { title: string; kind: "L0" | "L1" | "L2"; spec: string; taskId?: string };
    result: {
      draftId: string;
      title: string;
      kind: "L0" | "L1" | "L2";
      taskId?: string;
      spec: string;
      createdAt: string;
      status: "draft" | "reviewed" | "enabled";
    };
  };
  "workshop.list": {
    params: void;
    result: {
      drafts: {
        draftId: string;
        title: string;
        kind: "L0" | "L1" | "L2";
        taskId?: string;
        createdAt: string;
        status: "draft" | "reviewed" | "enabled";
      }[];
    };
  };
  /** 准入审查（静态流水线）：manifest / 禁项 / 冲突 / 自研追溯，分档强度 */
  "workshop.review": {
    params: { draftId: string };
    result: {
      ok: boolean;
      verdict: "approved" | "rejected";
      tier: "L0" | "L1" | "L2";
      findings: { ok: boolean; text: string }[];
      /** Q6 定稿 C：只有 L0 允许她自启用 */
      selfEnable: boolean;
    };
  };
  /** 迁入插件库：L1/L2 必须 byUser=true（用户点启用）；L0 可由风铃自启用（记审计） */
  "workshop.promote": {
    params: { draftId: string; byUser: boolean };
    result: { ok: true; id: string; tier: "L0" | "L1" | "L2"; byUser: boolean };
  };
  "workshop.discard": {
    params: { draftId: string };
    result: { ok: true };
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
        /** 声明 stage.console 时的内置视图 id（渲染层注册表里的键） */
        view?: string;
        /** 插件档位 */
        tier?: string;
        /** 启用状态（主进程 _state.json 唯一真相） */
        enabled?: boolean;
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
  /**
   * 渲染层异常上报（可选）：白屏时代没有现场，报错只能靠猜。
   * 上报内容落 `<数据根>/logs/renderer.log`，一行一个 JSON。
   */
  logError?: (payload: { kind: "error" | "rejection" | "react"; message: string; stack?: string; source?: string }) => void;
}

declare global {
  interface Window {
    lynn: LynnBridge;
  }
}
