import * as fs from "node:fs";
import { streamChat, type ChatMessage, type ToolSchema } from "./llm";
import type { MemberProfile } from "./team-store";
import { Toolkit, TOOLKIT_SCHEMAS, resolveWithin, type ToolkitOptions } from "./toolkit";

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
] as const;

export type MemberChatFn = typeof streamChat;

export interface MemberRunInput {
  profile: MemberProfile;
  brief: string;
  deadline: string;
  /** 本次分配的工具集（调用方已按「只能收窄」校验过与岗位白名单的包含关系） */
  tools: string[];
  /** 任务工作区：成员一切文件活动的边界（绝对路径） */
  workdir: string;
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
}

export interface MemberRunResult {
  status: "reported" | "turn_limit" | "error";
  report: string;
  evidence: string[];
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
      "把这一单的结论交回给风铃：text 写结论与未完成项，evidence 列工作区内真实存在的文件路径（至少 1 个，没有证据不收）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "结论 / 未完成 / 需要升级的说明" },
        evidence: { type: "array", items: { type: "string" }, description: "工作区内相对路径，至少 1 个" },
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
  return [
    `你是「${p.name}」，岗位：${p.role}。你只对风铃（Lynn）负责，不直接面对用户。`,
    `你的单一目标：${p.goal}`,
    "",
    "【边界（违反即失职）】",
    ...(p.boundaries.length ? p.boundaries.map((b) => `- ${b}`) : ["- （档案未写边界；保守行事，只做简报里明确要求的事）"]),
    "",
    "【你的工具】",
    `- 执行工具：${input.tools.filter((t) => (MEMBER_EXEC_TOOLS as readonly string[]).includes(t)).join("、") || "（本次未分配执行工具，只能靠推理完成）"}`,
    "- submit_report：回报通道（终局）。",
    "- 你没有 ask_user，不能问用户；口径拿不准就选一种并写明理由。需要升级时在回报正文里标 ESCALATE: 并说明。",
    "",
    "【工作区】",
    `所有文件操作都被限制在任务工作区内（工具层强制）。你收到的路径一律按工作区内相对路径处理。`,
    "",
    `【本次任务简报（截止：${input.deadline}）】`,
    input.brief,
    "",
    "【产出契约】",
    `- 交付物：${p.outputContract.deliverable}`,
    ...p.outputContract.evidence.map((e) => `- 证据要求：${e}`),
    ...p.outputContract.acceptance.map((a) => `- 验收标准：${a}`),
    "",
    "【回报纪律（§4.10.5 证据原则）】",
    "- 完成后必须调用 submit_report；evidence 至少 1 项，且必须是你真实写进工作区的文件路径——空口不算完成。",
    "- 没做完也要回报：写清楚做到了哪一步、卡在哪里。不要为了好看而虚报。",
  ].join("\n");
}

// ---------- 执行循环 ----------

export async function runMemberTask(input: MemberRunInput): Promise<MemberRunResult> {
  const chat = input.chatFn ?? streamChat;
  const toolkit = new Toolkit(input.workdir, { onAudit: input.onAudit, onBeforeWrite: input.onBeforeWrite, office: input.office, browser: input.browser });
  const maxTurns = Math.max(1, Math.min(input.profile.limits?.maxTurns ?? 12, 40));
  const tools = memberToolSchemas(input.tools);
  const messages: ChatMessage[] = [
    { role: "system", content: memberSystemPrompt(input) },
    { role: "user", content: `任务开始。简报如系统提示所述，截止 ${input.deadline}。完成后 submit_report。` },
  ];

  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalReport: string | null = null;
  let finalEvidence: string[] = [];

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
      // 证据必须在工作区真实存在（成员侧前置执行证据原则）
      const missing = evidence.filter((e) => !fs.existsSync(resolveWithin(input.workdir, e)));
      if (missing.length) {
        return `以下证据文件在工作区不存在，不能提交：${missing.join("、")}。先落盘再回报（证据原则 §4.10.5）。`;
      }
      if (!evidence.length) {
        return "evidence 不能为空：至少给 1 个真实文件路径作为证据（§4.10.5）。";
      }
      finalReport = text;
      finalEvidence = evidence;
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
        input.onEvent?.({ kind: "tool", text: "执行：" + String(args.command).slice(0, 120) });
      }
      return out;
} catch (err) {
      return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  try {
    while (finalReport === null && turns < maxTurns) {
      input.onEvent?.({
        kind: "turn",
        text: `第 ${turns + 1} / ${maxTurns} 轮`,
        progress: Math.min(95, Math.round((turns / maxTurns) * 100)),
      });
      turns += 1;
      const result = await chat({
        baseUrl: input.model.baseUrl,
        apiKey: input.model.apiKey,
        model: input.model.model,
        messages,
        tools,
        onDelta: () => {},
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
        const outcome = await execTool(tc.name, tc.arguments);
        if (finalReport !== null) {
          return {
            status: "reported",
            report: finalReport,
            evidence: finalEvidence,
            turns,
            promptTokens,
            completionTokens,
          };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
      }
    }
    return {
      status: "turn_limit",
      report: `成员在 ${maxTurns} 个工具轮次内没有提交回报（可能任务过大或卡住）。最后动作见卷宗。`,
      evidence: [],
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
      turns,
      promptTokens,
      completionTokens,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
