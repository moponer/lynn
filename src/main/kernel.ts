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
import { TeamStore, memberFileName } from "./team-store";

/**
 * 内核（主进程内直连实现）：OpenAI 兼容对话 + 流式推送 + 管理工具 8 件套。
 * ——「她是指挥者」在这里成型：她的工具面只有管理动作，没有 bash/write/browser。
 * 未来接 Pi 运行时时，本文件替换为 stdio JSON-RPC 转发层，契约不变。
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

/** 8 件套的 OpenAI function 格式 schema */
const TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "create_member",
      description: "招募团队成员（书面岗位）。一次性写清：名字、岗位、单一目标、边界（不许做什么）、工具白名单、产出契约与验收标准。超过 6 人编制需要 justification。",
      parameters: {
        type: "object",
        required: ["teamId", "name", "role", "goal", "tools"],
        properties: {
          teamId: { type: "string", description: "团队 id，不存在会自动创建；惯例用短横线小写，如 yuebao-duiji" },
          name: { type: "string" },
          role: { type: "string" },
          goal: { type: "string", description: "单一目标，行为收敛的关键" },
          boundaries: { type: "array", items: { type: "string" }, description: "边界：不许做什么，可执行可判定" },
          tools: { type: "array", items: { type: "string" }, description: "工具白名单（执行类工具发给成员，如 read/write/edit/bash/glob/grep/browser/office）" },
          deliverable: { type: "string", description: "产出物契约" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准" },
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
          brief: { type: "string", description: "简报包：任务说明+完成标准+相关上下文" },
          deadline: { type: "string" },
          tools: { type: "array", items: { type: "string" }, description: "本次分配的工具集（必须 ⊆ 岗位白名单，只能收窄）" },
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
      description: "登记成员的节点回报。必须附证据（文件路径/命令输出/测试结果）；无证据会被拒绝登记。",
      parameters: {
        type: "object",
        required: ["teamId", "taskId", "member", "text", "evidence"],
        properties: {
          teamId: { type: "string" },
          taskId: { type: "string" },
          member: { type: "string" },
          text: { type: "string", description: "回报摘要（一段话）" },
          evidence: { type: "array", items: { type: "string" }, description: "证据：文件路径/命令/输出摘录，至少一条" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_or_reject",
      description: "验收或打回。打回必须写清 what（哪里不合格）/expect（期望）/deadline（时限）；连续 3 轮打回将强制升级问用户。",
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
      description: "向用户汇报（也会显示在界面）。四件套：结论/证据/未完成项/需要用户拍板的事。",
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
      description: "向用户提问（口径选择、超预算决策、连续打回后的升级等）。成员没有问用户的通道，问题必须由你归集转呈。",
      parameters: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          context: { type: "string", description: "为什么现在必须问" },
        },
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
        properties: {
          teamId: { type: "string" },
          keep: { type: "boolean", description: "true=保留编制下次直接调用；false=解散" },
        },
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

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = dataRoot;
    // safeStorage 由 main.ts 注入 encrypt；测试环境 LYNN_HOME 隔离
    this.settings = new SettingsStore(
      dataRoot,
      (plain) => Buffer.from(plain, "utf-8"),
      () => false,
    );
    this.teamStore = new TeamStore(dataRoot);
    this.tools = new ManagementTools(this.teamStore, dataRoot);
    fs.mkdirSync(path.join(dataRoot, "session"), { recursive: true });
    this.loadSession();
  }

  /** main.ts 注入真正的 safeStorage 加密（渲染层永不接触 Key） */
  setEncryptors(encrypt: (plain: string) => Buffer, isAvailable: () => boolean): void {
    this.settings = new SettingsStore(this.dataRoot, encrypt, isAvailable);
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

  // ---------- 会话持久化（§4.8：timeline.jsonl 冷层，重启可续） ----------

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

  // ---------- 工具执行 ----------

  private teamColor(i: number): string {
    return ["#6396BC", "#E8B04B", "#5FBF77", "#C05687", "#8DA0AB", "#C44A35"][i % 6];
  }

  private async execTool(name: string, args: Record<string, unknown>): Promise<string> {
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
              ? {
                  what: String(args.what ?? ""),
                  expect: String(args.expect ?? ""),
                  deadline: String(args.deadline ?? ""),
                }
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

  // ---------- 对话循环 ----------

  private async runChat(userText: string): Promise<void> {
    const cfg = this.settings.getModel();
    const apiKey = cfg ? loadApiKey(this.settings, (b) => b.toString("utf-8")) : null;
    if (!cfg || !apiKey) {
      this.card({
        kind: "system",
        text: "还没有配置模型。点右上角「⚙ 设置」，填好 Base URL / API Key / 模型后再来找我。",
      });
      this.emit({ type: "error", message: "尚未配置模型" });
      return;
    }

    this.history.push({ role: "user", content: userText });
    this.persist("user", userText);

    // 流式中的"她"卡片：delta 不断追加
    const live = this.card({ kind: "lynn", text: "", streaming: true });
    const patchLive = (text: string, streaming: boolean) => {
      live.text = text;
      live.streaming = streaming;
    };

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.history,
    ];

    try {
      for (let round = 0; round < 8; round++) {
        let roundText = "";
        const result = await streamChat({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages,
          tools: TOOLS,
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
              outcome = await this.execTool(tc.name, JSON.parse(tc.arguments || "{}") as Record<string, unknown>);
            } catch (err) {
              outcome = `工具执行失败：${err instanceof Error ? err.message : String(err)}。请调整后重试或如实告知用户。`;
              this.emit({ type: "tool", badge: "工具", title: `${tc.name} 失败`, body: outcome });
            }
            messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
          }
          patchLive(result.content || "", false);
          continue; // 工具结果回传后继续下一轮
        }

        // 最终回复
        this.history.push({ role: "assistant", content: result.content });
        this.persist("assistant", result.content);
        patchLive(result.content, false);
        this.emit({ type: "done", tokens: result.promptTokens + result.completionTokens });
        return;
      }
      patchLive((live.text || "") + "\n\n（工具轮次达到上限，先停在这里。）", false);
      this.emit({ type: "done", tokens: 0 });
    } catch (err) {
      const msg =
        err instanceof LlmError
          ? `模型请求失败：${err.message}`
          : `出错了：${err instanceof Error ? err.message : String(err)}`;
      patchLive(live.text || msg, false);
      if (!live.text) live.text = msg;
      live.streaming = false;
      this.emit({ type: "error", message: msg });
    }
  }

  // ---------- 指挥板数据（真实存储推导，无假数） ----------

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
        const status =
          last.kind === "accept" ? "done" : last.kind === "escalate" ? "waiting" : "running";
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
        this.card({ kind: "user", text });
        if (this.busy) {
          this.card({ kind: "system", text: "她正在处理上一件事——这条先排队了（M0 队列是占位，稍候自动执行）。" });
        }
        this.busy = true;
        void this.runChat(text).finally(() => {
          this.busy = false;
        });
        return { ok: true } as RpcContracts[M]["result"];
      }

      case "decision.resolve": {
        const { id } = params as { id: string };
        const d = this.decisions.find((x) => x.id === id);
        this.decisions = this.decisions.filter((x) => x.id !== id);
        this.card({
          kind: "lynn",
          text: `收到你对「${d?.title ?? id}」的答复，我继续推进。`,
        });
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
        // 同步测连：返回 Promise，Electron ipcMain.handle 会 await 后再回渲染层
        const p = params as { baseUrl: string; apiKey: string; model: string };
        return probeEndpoint(p) as unknown as RpcContracts[M]["result"];
      }

      case "session.new": {
        this.feed = [];
        this.history = [];
        this.tokensUsed = 0;
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

// 防止未使用导入在严格模式下报错（成员文件名在后续成员详情页使用）
export const _memberFileName = memberFileName;
