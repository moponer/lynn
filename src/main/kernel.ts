import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BoardData,
  FeedCard,
  KernelEvent,
  PermissionMode,
  RpcContracts,
  RpcMethod,
} from "../shared/contract";
import { ManagementTools } from "./management-tools";
import { LlmError, streamChat, probeEndpoint, type ChatMessage, type ToolSchema } from "./llm";
import { SettingsStore, loadApiKey, defaultDataRoot } from "./settings";
import { TeamStore } from "./team-store";

/**
 * 内核：**Pi 为底座**（§1.3）。
 * - Agent 循环 / 模型协议：@earendil-works/pi-agent-core + pi-ai（ESM，动态加载）
 * - 我方产品层：管理工具 8 件套（execute 桥接 Pi 的 AgentTool）、权限、审计、指挥板
 * - 直连 OpenAI 兼容实现（llm.ts）保留为 Pi 不可用时的降级路径
 * 渲染层契约（contract.ts）不感知以上差别。
 */

const SYSTEM_PROMPT = `你是风铃（Lynn），一位常驻用户桌面的 AI 个人助理。

你的身份与做法：
- 你是**指挥者，不是执行者**。你不亲自改文件、抓网页、做表格；你通过「成员（书面岗位）」执行：招募 → 派简报 → 跟进 → 审查（打回要写清改什么、期望什么、时限）→ 向用户汇报。
- 完成标准先行：接到委托先写清"要做什么、什么算完成"，再决定是自己回答还是组队。闲聊/简单问答直接答，不要为小事组队。
- 你只拥有管理型工具；执行类工具都发给成员，且每次分配的工具集只能比岗位白名单更窄。
- 汇报 = 结论 + 证据 + 未完成项 + 需要用户拍板的事。不贴原始日志。
- 验收不轻信自述：成员回报必须附证据（文件路径/命令输出/测试结果），否则判未完成。
- 打回最多 3 轮，之后工具会强制你升级问用户——不要绕。

语气准则：
- 称呼用户为「你」；提到自己用「我」或「风铃」。
- 不喊大词（颠覆/赋能/重塑）；用具体动作代替形容词。
- 简洁。汇报用短段落；不确定就问，不编造。

当前你的能力是本机团队管理（招募/派单/审查/汇报）。办公文档、浏览器、消息平台等重能力尚未接入——用户提到时，如实告知还没装，不要假装执行。`;

/** CJS 环境里加载纯 ESM 的 Pi 包（未来切 Pi RPC worker 后此处整体移除） */
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// ---------- Pi 侧最小类型（来自 pi-coding-agent SDK；运行时为 ESM 实体） ----------

interface PiSession {
  prompt(text: string): Promise<void>;
  subscribe(cb: (ev: PiAgentEvent) => void): () => void;
  waitForIdle?(): Promise<void>;
  followUp?(text: string): Promise<unknown>;
  steer?(text: string): Promise<unknown>;
}

interface PiModelRuntime {
  registerProvider(providerId: string, config: Record<string, unknown>): void;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  getModel(providerId: string, modelId: string): unknown;
}

interface PiAgentEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

// ---------- 我方工具定义（OpenAI JSON 与 TypeBox 双写，一份语义） ----------

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

interface DecisionEntry {
  id: string;
  from: string;
  title: string;
  detail: string;
}

export class Kernel {
  readonly dataRoot: string;
  private settings: SettingsStore;
  private teamStore: TeamStore;
  private tools: ManagementTools;
  private permission: PermissionMode = "auto";
  private feed: FeedCard[] = [];
  private history: ChatMessage[] = [];
  private decisions: DecisionEntry[] = [];
  private tokensUsed = 0;
  private cardSeq = 0;
  private busy = false;
  private listeners = new Set<(ev: KernelEvent) => void>();

  /** Pi（ESM）运行时：init() 成功后可用 */
  private piReady = false;
  private piCreateAgentSession: ((opts: Record<string, unknown>) => Promise<{ session: PiSession }>) | null = null;
  private piModelRuntimeCtor: { create(opts?: Record<string, unknown>): Promise<PiModelRuntime> } | null = null;
  private piSessionManager: { inMemory(): unknown } | null = null;
  private session: PiSession | null = null;
  private sessionSettingsStamp = "";
  /** 流式中的她：runChat 里增量 patch */
  private liveCard: FeedCard | null = null;

  private decryptor: ((blob: Buffer) => string) | null = null;

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = dataRoot;
    // 测试环境（LYNN_HOME 隔离）无 safeStorage；main.ts 会用真实现覆盖
    this.settings = new SettingsStore(dataRoot, (plain) => Buffer.from(plain, "utf-8"), () => false);
    this.teamStore = new TeamStore(dataRoot);
    this.tools = new ManagementTools(this.teamStore, dataRoot);
    fs.mkdirSync(path.join(dataRoot, "session"), { recursive: true });
    this.loadSession();
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

  private emit(ev: KernelEvent): void {
    for (const cb of this.listeners) cb(ev);
  }

  private card(c: Omit<FeedCard, "id" | "createdAt">): FeedCard {
    const full: FeedCard = {
      ...c,
      id: `c-${++this.cardSeq}`,
      createdAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    this.feed.push(full);
    return full;
  }

  // ---------- Pi 初始化（ESM 动态加载；失败则降级直连） ----------

  async init(): Promise<void> {
    try {
      const coding = await dynamicImport("@earendil-works/pi-coding-agent");
      this.piCreateAgentSession = coding.createAgentSession as Kernel["piCreateAgentSession"];
      this.piModelRuntimeCtor = coding.ModelRuntime as Kernel["piModelRuntimeCtor"];
      this.piSessionManager = coding.SessionManager as Kernel["piSessionManager"];
      this.piReady = true;
    } catch (err) {
      console.warn("[kernel] Pi 加载失败，降级直连模式：", err instanceof Error ? err.message : err);
      this.piReady = false;
    }
  }

  // ---------- 工具执行（Pi execute 与直连 tool_calls 共用） ----------

  private teamColor(i: number): string {
    return ["#6396BC", "#E8B04B", "#5FBF77", "#C05687", "#8DA0AB", "#C44A35"][i % 6];
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
        this.tools.assignTask(String(args.teamId), {
          taskId: String(args.taskId),
          member: String(args.member),
          brief: String(args.brief),
          deadline: String(args.deadline),
          tools: args.tools as string[] | undefined,
        });
        this.emit({
          type: "tool",
          badge: "派单",
          title: `${args.member} · ${args.taskId}`,
          meta: `截止 ${args.deadline}`,
          body: String(args.brief),
        });
        return `简报包已派给 ${args.member}。`;
      }
      case "check_progress": {
        const p = this.tools.checkProgress(String(args.teamId), String(args.taskId));
        return JSON.stringify(p, null, 2);
      }
      case "review_result": {
        this.tools.reviewResult(String(args.teamId), String(args.taskId), {
          member: String(args.member),
          text: String(args.text),
          evidence: (args.evidence as string[]) ?? [],
        });
        this.emit({
          type: "tool",
          badge: "回报",
          title: `${args.member} · ${args.taskId}`,
          body: `${args.text}\n证据：${((args.evidence as string[]) ?? []).join("、")}`,
        });
        return "回报已登记（含证据索引）。";
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
            ? "验收通过，已记入卷宗。"
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

  // ---------- Pi 会话生命周期 ----------

  private async ensureSession(): Promise<PiSession> {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) throw new Error("no-model-config");
    const stamp = `${cfg.baseUrl}@${cfg.model}@${cfg.updatedAt}`;
    if (this.session && this.sessionSettingsStamp === stamp) return this.session;

    // 凭据走 ModelRuntime（实验验证过的注入方式），不落 auth.json 明文
    const runtime = await this.piModelRuntimeCtor!.create({ refreshOnCreate: false });
    runtime.registerProvider("lynn-user", {
      name: cfg.provider,
      baseUrl: cfg.baseUrl,
      api: "openai-completions",
      apiKey,
      models: [
        {
          id: cfg.model,
          name: cfg.model,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
    await runtime.setRuntimeApiKey("lynn-user", apiKey);
    const model = runtime.getModel("lynn-user", cfg.model);
    if (!model) throw new Error(`Pi getModel 为空: ${cfg.model}`);

    await this.loadPiTools();
    const { session } = await this.piCreateAgentSession!({
      modelRuntime: runtime,
      model,
      sessionManager: this.piSessionManager!.inMemory(),
      customTools: this.piToolCache!,
      tools: this.piToolCache!.map((t) => (t as { name: string }).name),
    });
    session.subscribe((ev: PiAgentEvent) => this.onAgentEvent(ev));
    this.session = session;
    this.sessionSettingsStamp = stamp;
    return session;
  }

  /** Pi AgentTool 列表（TypeBox schema；typebox 随 Pi 依赖可用） */
  private piToolCache: unknown[] | null = null;

  private async loadPiTools(): Promise<void> {
    if (this.piToolCache) return;
    const tb = (await dynamicImport("typebox")) as { Type: {
      Object: (o: Record<string, unknown>) => unknown;
      String: (o?: Record<string, unknown>) => unknown;
      Array: (o: unknown) => unknown;
      Boolean: (o?: Record<string, unknown>) => unknown;
    } };
    const T = tb.Type;
    const self = this;
    const s = (d?: string) => T.String(d ? { description: d } : undefined);
    const list = (d?: string) => T.Array(s(d));
    const tool = (name: string, label: string, description: string, params: Record<string, unknown>) => ({
      name,
      label,
      description,
      parameters: T.Object(params),
      execute: async (_id: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; details: Record<string, never> }> => {
        const text = self.runTool(name, args);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    this.piToolCache = [
      tool("create_member", "招募成员", "招募团队成员（书面岗位）：名字、岗位、单一目标、边界、工具白名单、验收标准。超过 6 人编制需 justification。", {
        teamId: s("团队 id"),
        name: s("成员名"),
        role: s("岗位"),
        goal: s("单一目标"),
        boundaries: list("边界：不许做什么"),
        tools: list("工具白名单"),
        deliverable: s("产出物契约"),
        acceptance: list("验收标准"),
        justification: s("超 6 人编制时必填"),
      }),
      tool("assign_task", "派单", "向成员派单，成员只拿简报包。", {
        teamId: s(), taskId: s(), member: s(),
        brief: s("简报包：任务+完成标准+上下文"),
        deadline: s(), tools: list("本次分配工具集（⊆ 岗位白名单）"),
      }),
      tool("check_progress", "查进度", "查看任务进度摘要。", { teamId: s(), taskId: s() }),
      tool("review_result", "登记回报", "登记成员节点回报，必须附证据。", {
        teamId: s(), taskId: s(), member: s(), text: s("回报摘要"),
        evidence: list("证据：文件/命令/输出，至少一条"),
      }),
      tool("accept_or_reject", "验收/打回", "验收或打回；打回必须 what/expect/deadline 齐全。", {
        teamId: s(), taskId: s(), member: s(),
        verdict: T.String({ description: "accept 或 reject" }),
        what: s("哪里不合格"), expect: s("期望"), deadline: s("重交时限"),
      }),
      tool("report_to_user", "汇报", "向用户汇报：结论/证据/未完成/待拍板。", {
        teamId: s(), taskId: s(), conclusion: s(),
        evidence: list(), unfinished: list(), decisionsNeeded: list(),
      }),
      tool("ask_user", "问用户", "向用户提问并等待回答。", { question: s(), context: s("为什么现在必须问") }),
      tool("dissolve_team", "解散/保留", "解散团队或保留编制。", { teamId: s(), keep: T.Boolean({ description: "true=保留编制" }) }),
    ];
  }

  private onAgentEvent(ev: PiAgentEvent): void {
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta" && ev.assistantMessageEvent.delta) {
      const delta = ev.assistantMessageEvent.delta;
      if (this.liveCard) {
        this.liveCard.text = (this.liveCard.text ?? "") + delta;
      }
    }
    // tool 卡片由 runTool 内 emit（带业务徽章），这里不重复
  }

  // ---------- 对话主路径 ----------

  private async runChatPi(userText: string, wasBusy: boolean): Promise<void> {
    const session = await this.ensureSession();

    const live = this.card({ kind: "lynn", text: "", streaming: true });
    this.liveCard = live;
    try {
      if (wasBusy && session.followUp) {
        // 排队输入（§3.2）：她干活时你也能打字
        await session.followUp(userText);
      } else {
        await session.prompt(userText);
      }
      await session.waitForIdle?.();
      const finalText = live.text ?? "";
      if (finalText.trim()) {
        this.history.push({ role: "assistant", content: finalText });
        this.persist("assistant", finalText);
      }
      live.streaming = false;
      this.emit({ type: "done", tokens: 0 });
    } finally {
      this.liveCard = null;
    }
  }

  /** 直连降级路径：Pi 不可用时仍可用（原实现保留） */
  private async runChatDirect(userText: string, cfg: NonNullable<ReturnType<SettingsStore["getModel"]>>, apiKey: string): Promise<void> {
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    const patchLive = (text: string, streaming: boolean) => {
      live.text = text;
      live.streaming = streaming;
    };
    this.history.push({ role: "user", content: userText });
    this.persist("user", userText);
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...this.history];
    try {
      for (let round = 0; round < 8; round++) {
        let roundText = "";
        const result = await streamChat({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages,
          tools: TOOL_JSON,
          onDelta: (t) => {
            roundText += t;
            patchLive(roundText, true);
          },
        });
        this.tokensUsed += result.promptTokens + result.completionTokens;
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
            let outcome: string;
            try {
              outcome = this.runTool(tc.name, JSON.parse(tc.arguments || "{}") as Record<string, unknown>);
            } catch (err) {
              outcome = `工具执行失败：${err instanceof Error ? err.message : String(err)}。请调整后重试或如实告知用户。`;
              this.emit({ type: "tool", badge: "工具", title: `${tc.name} 失败`, body: outcome });
            }
            messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
          }
          patchLive(result.content || "", false);
          continue;
        }
        this.history.push({ role: "assistant", content: result.content });
        this.persist("assistant", result.content);
        patchLive(result.content, false);
        this.emit({ type: "done", tokens: result.promptTokens + result.completionTokens });
        return;
      }
      patchLive((live.text || "") + "\n\n（工具轮次达到上限，先停在这里。）", false);
      this.emit({ type: "done", tokens: 0 });
    } catch (err) {
      const msg = err instanceof LlmError ? `模型请求失败：${err.message}` : `出错了：${err instanceof Error ? err.message : String(err)}`;
      if (!live.text) live.text = msg;
      live.streaming = false;
      this.emit({ type: "error", message: msg });
    }
  }

  private async runChat(userText: string, wasBusy = false): Promise<void> {
    const cfg = this.settings.getModel();
    const apiKey = cfg
      ? loadApiKey(this.settings, (b) => (this.decryptor ? this.decryptor(b) : b.toString("utf-8")))
      : null;
    if (!cfg || !apiKey) {
      this.card({
        kind: "system",
        text: "还没有可用的模型配置（或 Key 无法解密——应用升级后需要重新填一次）。点右上角 ⚙ 设置。",
      });
      this.emit({ type: "error", message: "尚未配置模型" });
      return;
    }
    try {
      if (this.piReady) {
        await this.runChatPi(userText, wasBusy);
      } else {
        await this.runChatDirect(userText, cfg, apiKey);
      }
    } catch (err) {
      const msg = `出错了：${err instanceof Error ? err.message : String(err)}`;
      if (this.liveCard) {
        if (!this.liveCard.text) this.liveCard.text = msg;
        this.liveCard.streaming = false;
        this.liveCard = null;
      } else {
        this.card({ kind: "system", text: msg });
      }
      this.emit({ type: "error", message: msg });
    }
  }

  // ---------- 会话持久化（§4.8 冷层） ----------

  private get timelineFile(): string {
    return path.join(this.dataRoot, "session", "timeline.jsonl");
  }

  private loadSession(): void {
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
    fs.appendFileSync(this.timelineFile, JSON.stringify({ role, content, at: new Date().toISOString() }) + "\n", "utf-8");
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
          progress: 0,
          budgetUsed: 0,
          budgetTotal: Math.round(p.limits.budgetTokens / 1000),
          rejections: 0,
          rejectionLimit: 3,
          toolWhitelist: p.tools,
          color: this.teamColor(i),
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
        const status = last.kind === "accept" ? "done" : last.kind === "escalate" ? "waiting" : "running";
        track.push({
          id: taskId,
          teamId: entry.name,
          title: taskId,
          status,
          statusNote: `${last.kind} · ${last.member ?? "风铃"} · ${last.text.slice(0, 30)}`,
        });
      }
    }
    return track.reverse();
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

  handle<M extends RpcMethod>(method: M, params: unknown): RpcContracts[M]["result"] {
    switch (method) {
      case "session.snapshot": {
        const cfg = this.settings.getModel();
        const snap: RpcContracts["session.snapshot"]["result"] = {
          workspace: { project: "我的风铃", subdir: "指挥台" },
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
        };
        return snap as RpcContracts[M]["result"];
      }

      case "permission.set": {
        const { mode } = params as { mode: PermissionMode };
        this.permission = mode;
        return { ok: true, mode } as RpcContracts[M]["result"];
      }

      case "feed.send": {
        const { text } = params as { text: string };
        const wasBusy = this.busy;
        this.card({ kind: "user", text });
        this.busy = true;
        void this.runChat(text, wasBusy).finally(() => {
          this.busy = false;
        });
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "decision.resolve": {
        const { id } = params as { id: string };
        const d = this.decisions.find((x) => x.id === id);
        this.decisions = this.decisions.filter((x) => x.id !== id);
        this.card({ kind: "lynn", text: `收到你对「${d?.title ?? id}」的答复，我继续推进。` });
        return { ok: true } as RpcContracts[M]["result"];
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
        return probeEndpoint(p) as unknown as RpcContracts[M]["result"];
      }

      case "session.new": {
        this.feed = [];
        this.history = [];
        this.tokensUsed = 0;
        this.session = null;
        this.sessionSettingsStamp = "";
        try {
          fs.rmSync(this.timelineFile, { force: true });
        } catch {
          // 忽略
        }
        this.card({ kind: "system", text: "新会话已开始。历史卷宗仍在 ~/.lynn 里，随时可查。" });
        return { ok: true } as RpcContracts[M]["result"];
      }

      default:
        throw new Error(`unknown rpc method: ${method as string}`);
    }
  }
}
