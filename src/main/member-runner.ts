import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { streamChat, type ChatMessage, type ToolSchema } from "./llm";
import type { MemberProfile } from "./team-store";

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

export const MEMBER_EXEC_TOOLS = ["read_file", "write_file", "list_dir", "run_command"] as const;

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

// ---------- 成员工具实现（全部在代码层强制边界） ----------

/** 解析成员给的路径：必须落在工作区内，逃逸一律拒绝 */
export function resolveWithin(workdir: string, target: string): string {
  const base = path.resolve(workdir);
  const full = path.resolve(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`路径越界：${target} 不在任务工作区内。成员只能访问工作区里的文件。`);
  }
  return full;
}

function toolReadFile(workdir: string, args: Record<string, unknown>): string {
  const full = resolveWithin(workdir, String(args.path ?? ""));
  if (!fs.existsSync(full)) throw new Error(`文件不存在：${args.path}`);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) throw new Error(`${args.path} 是目录，请用 list_dir`);
  const body = fs.readFileSync(full, "utf-8");
  if (body.length > 200_000) {
    return body.slice(0, 200_000) + `\n…（已截断，共 ${stat.size} 字节）`;
  }
  return body;
}

function toolWriteFile(workdir: string, args: Record<string, unknown>): string {
  const full = resolveWithin(workdir, String(args.path ?? ""));
  const content = String(args.content ?? "");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return `已写入 ${args.path}（${Buffer.byteLength(content, "utf-8")} 字节）。`;
}

function toolListDir(workdir: string, args: Record<string, unknown>): string {
  const full = resolveWithin(workdir, args.path === undefined || args.path === "" ? "." : String(args.path));
  if (!fs.existsSync(full)) throw new Error(`目录不存在：${args.path ?? "."}`);
  const entries = fs.readdirSync(full, { withFileTypes: true });
  if (!entries.length) return "（空目录）";
  return entries
    .map((e) => `${e.isDirectory() ? "[目录]" : "      "} ${e.name}`)
    .join("\n");
}

function toolRunCommand(workdir: string, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) return Promise.resolve("命令为空。");
  const timeoutMs = 120_000;
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: path.resolve(workdir),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        const cut = (s: string) => {
          const t = s ?? "";
          return t.length > 8000 ? t.slice(0, 8000) + `…（截断，共 ${t.length} 字符）` : t;
        };
        if (err && !stdout && !stderr) {
          if ((err as Error & { killed?: boolean }).killed) {
            resolve(`命令超时（${timeoutMs / 1000}s）被终止：${command}`);
          } else {
            resolve(`命令执行失败：${err.message}`);
          }
          return;
        }
        const parts = [
          stdout ? `stdout:\n${cut(stdout)}` : null,
          stderr ? `stderr:\n${cut(stderr)}` : null,
          err ? `exit code: ${err.code ?? "非零"}` : "exit code: 0",
        ].filter(Boolean);
        resolve(parts.join("\n"));
      },
    );
  });
}

// ---------- 成员工具 schema（OpenAI 兼容） ----------

export function memberToolSchemas(allowed: string[]): ToolSchema[] {
  const defs: Record<string, ToolSchema> = {
    read_file: {
      type: "function",
      function: {
        name: "read_file",
        description: "读取工作区内一个文本文件的全部内容（超过 200KB 截断）。",
        parameters: { type: "object", properties: { path: { type: "string", description: "工作区内相对路径" } }, required: ["path"] },
      },
    },
    write_file: {
      type: "function",
      function: {
        name: "write_file",
        description: "把完整内容写入工作区内一个文件（目录不存在会自动创建；覆盖同名文件）。",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "工作区内相对路径" }, content: { type: "string", description: "完整文件内容" } },
          required: ["path", "content"],
        },
      },
    },
    list_dir: {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出工作区内一个目录的条目（默认根目录）。",
        parameters: { type: "object", properties: { path: { type: "string", description: "工作区内相对路径，可省略" } }, required: [] },
      },
    },
    run_command: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "在工作区目录里执行一条 shell 命令（120 秒超时；输出截断）。只用于完成任务必需的核算/转换，不得联网下载、不装依赖。",
        parameters: { type: "object", properties: { command: { type: "string", description: "要执行的命令" } }, required: ["command"] },
      },
    },
    submit_report: {
      type: "function",
      function: {
        name: "submit_report",
        description:
          "向风铃提交回报（终局动作，提交后本轮执行结束）。text=做了什么与结论；evidence=证据文件相对路径列表（至少 1 项，必须真实存在于工作区）。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "回报正文：做了什么、关键口径、未完成的部分" },
            evidence: { type: "array", items: { type: "string" }, description: "证据文件（工作区内相对路径）" },
          },
          required: ["text", "evidence"],
        },
      },
    },
  };
  // 白名单只约束执行工具；submit_report 是成员唯一的回报通道，永远在
  return allowed.filter((t) => defs[t]).map((t) => defs[t]).concat(defs.submit_report);
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
      switch (name) {
        case "read_file":
          return toolReadFile(input.workdir, args);
        case "write_file": {
          const r = toolWriteFile(input.workdir, args);
          input.onEvent?.({ kind: "tool", text: `写入 ${String(args.path)}` });
          return r;
        }
        case "list_dir":
          return toolListDir(input.workdir, args);
        case "run_command":
          return await toolRunCommand(input.workdir, args);
        default:
          return `未知工具：${name}`;
      }
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
