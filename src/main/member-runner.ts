import * as fs from "node:fs";
import { streamChat, type ChatMessage, type ToolSchema } from "./llm";
import type { MemberProfile } from "./team-store";
import { Toolkit, TOOLKIT_SCHEMAS, resolveReadable, resolveWithin, type ToolkitOptions } from "./toolkit";

/**
 * 成员运行时（M0-09：单层派单真实执行）。
 *
 * 派单不再只是写 jsonl：assign_task 之后这里用成员档案 + 简报包起一个
 * 真实的工具循环。硬约束在代码里，不靠提示词自律（§4.10.3）：
 *  - 成员可用的执行工具 = 本次分配 ∩ 内置执行工具（管理型 8 件套永远进不来）
 *  - 文件读写被钉死在任务工作区（workspace 逃逸在工具层直接拒绝）
 *  - submit_report 无证据不收（§4.10.5 证据原则前置到成员侧）
 *  - 轮次上限来自档案 limits.maxTurns，超限如实报「未完成」
 *
 * 注：run_command 目前只做 cwd 钉扎 + 超时 + 截断，OS 级隔离是 M1-11
 * （纵深防御，不承诺沙箱）的活，这里不做谎报。
 */

export const MEMBER_EXEC_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  "run_command",
  "office_read_table",
  "office_write_table",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_extract",
  "browser_close",
  "kb_add",
] as const;

export type MemberChatFn = typeof streamChat;

/**
 * 简报质量闸（纯函数）：风铃派单前代码层把关，不靠提示词自觉。
 * 合格简报必须能让一个看不到对话的成员独立开工：目标 / 完成标准 / 材料位置 / 限制。
 * 返回 null = 合格；否则返回给风铃的退回说明（含重写模板，一轮就能改对）。
 */
export function validateBrief(brief: string, acceptance?: string[]): string | null {
  const text = (brief ?? "").trim();
  const hasAcceptance = Array.isArray(acceptance) && acceptance.filter((a) => String(a).trim()).length > 0;
  const missing: string[] = [];
  if (text.length < 30) {
    return [
      "简报太薄（不足 30 字），已退回，没有派单。成员看不到你们的对话，只看得到简报包，按下面模板重写后再 assign_task：",
      "",
      "【目标】一句话说清要产出什么（写什么文件/改什么/核对什么）",
      "【完成标准】可验证的验收点（文件存在/数值正确/格式要求），同时填 acceptance 数组",
      "【材料与位置】输入材料的完整路径；不在工作区就写明并传 readRoots 申请只读授权",
      "【限制】不许做什么、范围边界、格式与口径要求",
    ].join("\n");
  }
  if (!hasAcceptance && !/完成标准|验收|产出|交付|输出|核对/.test(text)) {
    missing.push("完成标准（怎么算做完了？给可验证的验收点，或直接填 acceptance）");
  }
  if (!/限制|不许|不得|禁止|不要|只能|边界|注意|范围/.test(text)) {
    missing.push("限制（不许做什么 / 范围边界 / 口径要求——没有限制成员就会自由发挥）");
  }
  if (!/【材料|材料|位置|路径|文件|来源/.test(text)) {
    missing.push("材料与位置（输入材料在哪？给完整路径；不在工作区就传 readRoots 申请只读授权）");
  }
  if (missing.length === 0) return null;
  return [
    "简报不合格，已退回，没有派单。缺：" + missing.join("；") + "。",
    "",
    "按四段模板重写后再 assign_task：",
    "【目标】…",
    "【完成标准】…（可验证；同时填 acceptance）",
    "【材料与位置】…（完整路径）",
    "【限制】…",
  ].join("\n");
}

export interface MemberRunInput {
  profile: MemberProfile;
  brief: string;
  deadline: string;
  /** 本次分配的工具集（调用方已按「只能收窄」校验过与岗位白名单的包含关系） */
  tools: string[];
  /** 轮次上限覆盖（派单时指定）；缺省用岗位档案 limits.maxTurns */
  maxTurns?: number;
  /** 任务工作区：成员一切文件活动的边界（绝对路径） */
  workdir: string;
  /** 过程文件目录（永远在数据根内，可被清理）；缺省不提示 */
  scratchDir?: string;
  /** 用户授权的只读目录：读可以进，写仍然只能在工作区（函数 = 每次现取，跑到一半授权也生效） */
  readRoots?: string[] | (() => string[]);
  /** 用户授权的可写附加根：只影响命令 cwd；文件写入仍只走工作区 */
  writableRoots?: string[] | (() => string[]);
  /** 删除类命令的审批闸：成员能改代码，但删除必须用户点头 */
  onBeforeCommand?: (command: string) => Promise<{ ok: boolean; reason?: string }>;
  model: { baseUrl: string; apiKey: string; model: string };
  /** 测试注入；默认真流式 */
  chatFn?: MemberChatFn;
  /** 进度回调（内核用来发工具卡） */
  onEvent?: (ev: { kind: "tool" | "note" | "turn"; text: string; progress?: number }) => void;
  /** 命令审计回调（M1-11：壳写 audit.jsonl） */
  onAudit?: (ev: { kind: "cmd_blocked" | "cmd_net" | "cmd_run"; command: string; why?: string; cwd: string }) => void;
  /** 写前通知（M1-12 检查点） */
  onBeforeWrite?: (rel: string, full: string, existed: boolean) => void;
  /** office 能力桥接（M2-06）：壳按引擎健康注入；不注入时成员调 office 工具会得到如实提示 */
  office?: ToolkitOptions["office"];
  /** browser 能力桥接（M2-07）：单例控制器；不注入时成员调 browser 工具会得到如实提示 */
  browser?: ToolkitOptions["browser"];
  /** 知识库写入桥接（M2-08） */
  kb?: ToolkitOptions["kb"];
  /** 中止信号（用户点「停」/解散队伍）：模型流与工具轮都尽快收尾 */
  signal?: AbortSignal;
  /**
   * 收件箱：风铃（或巡检）在成员跑的中途补的指示。
   * 每轮开头 drain 一次——不打断当前工具轮，但下一轮模型就能看到（催办不必杀进程重跑）。
   */
  inbox?: string[];
}

export interface MemberRunResult {
  status: "reported" | "turn_limit" | "aborted" | "error";
  report: string;
  evidence: string[];
  /** 交付物（与证据分开；验收后固化进卷宗，永久保留） */
  deliverables: string[];
  turns: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

// ---------- 成员工具实现（官方 L1 工具集，见 toolkit.ts） ----------

// 兼容旧引用：路径边界与工具实现都收敛到 toolkit 一份，成员与工作台共用
export { resolveWithin };

// ---------- 成员工具 schema（OpenAI 兼容） ----------

/** 回报通道：不属于执行工具，任何白名单都不能把它剥掉（§4.10.5） */
const SUBMIT_REPORT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "submit_report",
    description:
      "把这一单的结论交回给风铃：text 开头标状态（【完成】/【完成有保留】/【受阻】/【缺上下文】），写结论与未完成项；evidence 列真实存在的证据文件（至少 1 个，没有证据不收）；deliverables 列用户要带走的交付物（会永久保留）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "结论 / 未完成 / 需要升级的说明" },
        evidence: { type: "array", items: { type: "string" }, description: "工作区或只读根里的真实文件路径，至少 1 个" },
        deliverables: {
          type: "array",
          items: { type: "string" },
          description: "交付物路径（用户要带走的东西：报告/表格/图片）；与证据分开，验收后永久保留",
        },
      },
      required: ["text", "evidence"],
    },
  },
};

export function memberToolSchemas(allowed: string[]): ToolSchema[] {
  return [...TOOLKIT_SCHEMAS.filter((t) => allowed.includes(t.function.name)), SUBMIT_REPORT_SCHEMA];
}

// ---------- 成员系统提示词（档案 → 提示词，纯文本编译） ----------

export function memberSystemPrompt(input: MemberRunInput): string {
  const p = input.profile;
  const readRoots = (typeof input.readRoots === "function" ? input.readRoots() : input.readRoots) ?? [];
  const writableRoots = (typeof input.writableRoots === "function" ? input.writableRoots() : input.writableRoots) ?? [];
  return [
    `你是「${p.name}」，岗位：${p.role}。你只对风铃（Lynn）负责，不直接面对用户。`,
    `你的单一目标：${p.goal}`,
    "",
    "【边界（违反即失职）】",
    ...(p.boundaries.length ? p.boundaries.map((b) => `- ${b}`) : ["- （档案未写边界；保守行事，只做简报里明确要求的事）"]),
    ...(p.escalateWhen.trim() ? ["", `【何时必须停手升级】${p.escalateWhen.trim()}——命中就立刻回报，不要硬扛。`] : []),
    ...(p.body.trim()
      ? [
          "",
          "【岗位工作方式（档案正文）】",
          p.body.trim(),
        ]
      : []),
    "",
    "【你的工具】",
    `- 执行工具：${input.tools.filter((t) => (MEMBER_EXEC_TOOLS as readonly string[]).includes(t)).join("、") || "（本次未分配执行工具，只能靠推理完成）"}`,
    "- submit_report：回报通道（终局）。**剩最后 2 轮时必须停手交回**，哪怕没做完也要交：写清做到哪一步、卡在哪、需要什么。不交 = 这张单白跑。",
    "- 你没有 ask_user，不能问用户；口径拿不准就选一种并写明理由。需要升级时在回报正文里标 ESCALATE: 并说明。",
    "",
    "【工作区与文件去向】",
    `工作区：${input.workdir}（**可读可写**）。写文件用工作区内相对路径。`,
    ...(input.scratchDir
      ? [`过程文件（下载/解压/测试输出/缓存）写到：${input.scratchDir}；交付物（用户要带走的报告/表格/图）写到工作区里的 deliverables/ 或简报指定位置。`]
      : []),
    "- 不能写 `.git/` 与 `.lynn/`（项目元数据与风铃配置，工具层直接拒）。",
    "- **删除类命令（del / rm / rmdir / move / 改名 / git clean / git reset --hard）必须用户点头**：会被挂起等批准，被拒就别换写法绕，改成可撤销的覆盖写，或在回报里说明。",
    ...(readRoots.length
      ? [
          `只读授权（用户已批准）：${readRoots.join("、")}。这些目录里的文件可以 read_file / list_dir / office_read_table 读，**写入仍然只能在工作区**；读时用绝对路径。`,
        ]
      : []),
    ...(writableRoots.length
      ? [
          `可写根（用户已批准，仅用于跑命令）：${writableRoots.join("、")}。run_command 可以用 cwd 指到这些目录里跑构建/测试；write_file / edit_file 仍然只能写工作区。`,
        ]
      : []),
    "",
    `【本次任务简报（截止：${input.deadline}）】`,
    input.brief,
    "",
    "【产出契约】",
    `- 交付物：${p.outputContract.deliverable}`,
    "- 交付物在 submit_report 的 deliverables 里列出来（与 evidence 分开）：用户要带走的东西会永久保留；只写进证据不算交付。",
    ...p.outputContract.evidence.map((e) => `- 证据要求：${e}`),
    ...p.outputContract.acceptance.map((a) => `- 验收标准：${a}`),
    "",
    "【回报纪律（§4.10.5 证据原则）】",
    "- 完成后必须调用 submit_report；evidence 至少 1 项，且必须是你真实写进工作区的文件路径——空口不算完成。",
    "- 回报开头标状态，四选一：【完成】做好了且核对过；【完成有保留】做完了但有疑虑，写明疑虑；【受阻】卡住了，写清卡在哪、缺什么；【缺上下文】简报信息不够，写清缺什么——风铃会补了重派。",
    "- 缺关键材料、目标互相矛盾、工具不够用：**第一轮就停手回报**，不要猜着做、不要自行脑补——烂交付不如不交付，停下不会怪你。",
    "- 交回报前自审三问：①简报里的完成标准逐条过了吗？②evidence 里的文件真的存在且是本次产出的吗？③有没有「我觉得应该没问题」但没验证的地方？有就改成【完成有保留】并写明。",
    "- 没做完也要回报：写清楚做到了哪一步、卡在哪里。不要为了好看而虚报。",
  ].join("\n");
}

// ---------- 执行循环 ----------

export async function runMemberTask(input: MemberRunInput): Promise<MemberRunResult> {
  const chat = input.chatFn ?? streamChat;
  const toolkit = new Toolkit(input.workdir, {
    onAudit: input.onAudit,
    onBeforeWrite: input.onBeforeWrite,
    office: input.office,
    browser: input.browser,
    kb: input.kb,
    readRoots: input.readRoots,
    writableRoots: input.writableRoots,
    onBeforeCommand: input.onBeforeCommand,
  });
  const maxTurns = Math.max(1, Math.min(input.maxTurns ?? input.profile.limits?.maxTurns ?? 12, 40));
  const tools = memberToolSchemas(input.tools);
  const messages: ChatMessage[] = [
    { role: "system", content: memberSystemPrompt(input) },
    {
      role: "user",
      content:
        `任务开始，截止 ${input.deadline}。先读一遍简报，用 list_dir/read_file 核对材料是否真的在；` +
        "缺关键材料或目标不清就立刻 submit_report 标【缺上下文】，不要硬做。材料齐了就开工，完成后 submit_report。",
    },
  ];

  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalReport: string | null = null;
  let finalEvidence: string[] = [];
  let finalDeliverables: string[] = [];

  const execTool = async (name: string, rawArgs: string): Promise<string> => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    } catch {
      return `工具参数不是合法 JSON：${rawArgs.slice(0, 200)}`;
    }
    if (name === "submit_report") {
      const text = String(args.text ?? "").trim();
      const evidence = (Array.isArray(args.evidence) ? args.evidence : []).map(String).filter(Boolean);
      if (!text) return "回报正文不能为空。";
      // 证据必须在「工作区 ∪ 用户授权的只读根」里真实存在。
      // 审查类任务的材料本来就在只读根里，不能因为不在工作区就判"没证据"（2026-11-10 修）。
      const roots = typeof input.readRoots === "function" ? input.readRoots() : input.readRoots ?? [];
      const missing = evidence.filter((e) => {
        try {
          return !fs.existsSync(resolveReadable(input.workdir, roots, e).full);
        } catch {
          return true;
        }
      });
      if (missing.length) {
        return `以下证据文件既不在工作区、也不在已授权的只读目录里，不能提交：${missing.join("、")}。先落盘再回报（证据原则 §4.10.5）。`;
      }
      if (!evidence.length) {
        return "evidence 不能为空：至少给 1 个真实文件路径作为证据（§4.10.5）。";
      }
      // 交付物同样要真实存在；证据与交付物分开记，验收时只固化交付物
      const deliverables = (Array.isArray(args.deliverables) ? args.deliverables : []).map(String).filter(Boolean);
      const missingDeliverables = deliverables.filter((e) => {
        try {
          return !fs.existsSync(resolveReadable(input.workdir, roots, e).full);
        } catch {
          return true;
        }
      });
      if (missingDeliverables.length) {
        return `以下交付物不存在，不能提交：${missingDeliverables.join("、")}。先落盘再回报。`;
      }
      finalReport = text;
      finalEvidence = evidence;
      finalDeliverables = deliverables;
      return "回报已收下，本轮执行结束。";
    }
    if (!(MEMBER_EXEC_TOOLS as readonly string[]).includes(name)) {
      return `未知工具：${name}。成员没有这个工具。`;
    }
    if (!input.tools.includes(name)) {
      return `工具 ${name} 不在本次分配清单里（本次只有：${input.tools.join("、")}）。需要的话在回报里写 ESCALATE 说明原因。`;
    }
        try {
      const out = await toolkit.execute(name, args);
      if (name === "write_file" || name === "edit_file") {
        const ch = toolkit.changes().at(-1);
        input.onEvent?.({
          kind: "tool",
          text: (name === "write_file" ? "写入 " : "修改 ") + String(args.path) + (ch ? "（+" + ch.added + "/-" + ch.removed + "）" : ""),
        });
      } else if (name === "run_command") {
        // 写全命令（截 500）：只给 120 字时界面上全是"执行：powershell -NoProfile -Command "try {…"，
        // 用户根本看不出它在干什么
        input.onEvent?.({ kind: "tool", text: "执行：" + String(args.command).slice(0, 500) });
      } else {
        const head = name.startsWith("browser_") ? String(args.url ?? args.target ?? args.selector ?? "") : String(args.path ?? args.name ?? "");
        input.onEvent?.({ kind: "tool", text: `${name}${head ? "：" + head.slice(0, 200) : ""}` });
      }
      return out;
} catch (err) {
      return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  try {
    while (finalReport === null && turns < maxTurns && !input.signal?.aborted) {
      // 先看收件箱：风铃在跑的中途补的指示，这一轮就能进上下文（不用杀掉重跑、不丢已写文件）
      while (input.inbox && input.inbox.length > 0) {
        const note = input.inbox.shift();
        if (!note) break;
        messages.push({ role: "user", content: `【风铃补充指示】${note}` });
        input.onEvent?.({ kind: "note", text: `收到补充指示：${note.slice(0, 120)}` });
      }
      input.onEvent?.({
        kind: "turn",
        text: `第 ${turns + 1} / ${maxTurns} 轮`,
        progress: Math.min(95, Math.round((turns / maxTurns) * 100)),
      });
      turns += 1;
      // 逼近上限就强制收口：不给"再探一轮"的机会，否则 40 轮烧完一张回报都没有
      if (finalReport === null && maxTurns - turns <= 2) {
        messages.push({
          role: "user",
          content:
            "只剩 2 轮了：立刻用 submit_report 交回当前结论。未完成也要交——写清做到哪一步、拿到的证据、卡在哪、需要什么。" +
            "不要再调用其它工具，不要再探索。",
        });
      }
      const result = await chat({
        baseUrl: input.model.baseUrl,
        apiKey: input.model.apiKey,
        model: input.model.model,
        messages,
        tools,
        onDelta: () => {},
        signal: input.signal,
      });
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      if (result.toolCalls.length === 0) {
        // 模型直接说话不调工具：把话喂回去，要求走 submit_report
        messages.push({ role: "assistant", content: result.content });
        messages.push({
          role: "user",
          content: "请把结论与证据用 submit_report 提交（evidence 必须是工作区里真实存在的文件）。",
        });
        continue;
      }
      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.arguments },
        })),
      });
      for (const tc of result.toolCalls) {
        if (input.signal?.aborted) break;
        const outcome = await execTool(tc.name, tc.arguments);
        if (finalReport !== null) {
          return {
            status: "reported",
            report: finalReport,
            evidence: finalEvidence,
            deliverables: finalDeliverables,
            turns,
            promptTokens,
            completionTokens,
          };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
      }
    }
    if (input.signal?.aborted) {
      return {
        status: "aborted",
        report: "已被停止（用户中止）。已写出的文件留在工作区，未提交汇报。",
        evidence: [],
        deliverables: [],
        turns,
        promptTokens,
        completionTokens,
      };
    }
    return {
      status: "turn_limit",
      report: `成员在 ${maxTurns} 个工具轮次内没有提交回报（可能任务过大或卡住）。最后动作见卷宗。`,
      evidence: [],
      deliverables: [],
      turns,
      promptTokens,
      completionTokens,
      error: "turn_limit",
    };
  } catch (err) {
    return {
      status: "error",
      report: `成员执行出错：${err instanceof Error ? err.message : String(err)}`,
      evidence: [],
      deliverables: [],
      turns,
      promptTokens,
      completionTokens,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
