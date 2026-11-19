import * as fs from "node:fs";
import { streamChat, streamChatWithRetry, isQuotaError, type ChatMessage, type ToolSchema } from "./llm";
import { compactKeepRecent, compactThreshold, compactToolHistory, countUnfoldedTools } from "./history-compact";
import type { MemberProfile } from "./team-store";
import { Toolkit, TOOLKIT_SCHEMAS, resolveReadable, resolveWithin, type ToolkitOptions } from "./toolkit";
import { renderLessons, type Lesson } from "./member-pool";
import { memberSurface, searchTools, TOOL_SEARCH_SCHEMA } from "./tool-search";
import { ToolRegistry } from "./tool-registry";

/**
 * 成员运行时（M0-09：单层派单真实执行）。
 *
 * 派单不再只是写 jsonl：assign_task 之后这里用成员档案 + 简报包起一个
 * 真实的工具循环。硬约束在代码里，不靠提示词自律（§4.10.3）：
 *  - 成员可用的执行工具 = 本次分配 ∩ 内置执行工具（管理型 8 件套永远进不来）
 *  - 文件读写被钉死在任务工作区（workspace 逃逸在工具层直接拒绝）
 *  - submit_report 证据可选；提供了就必须真实存在（关键任务的强制点在任务层 evidencePolicy）
 *  - 轮次上限来自档案 limits.maxTurns，超限如实报「未完成」
 *
 * 注：run_command 目前只做 cwd 钉扎 + 超时 + 截断，OS 级隔离是 M1-11
 * （纵深防御，不承诺沙箱）的活，这里不做谎报。
 */

export const MEMBER_EXEC_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  // 2026-11-16：提示词一直教成员「按模式找文件用 glob」，但这两个工具从来没进过执行面
  // （memberToolSchemas 只发白名单 ∩ TOOLKIT_SCHEMAS，而白名单只能填 MEMBER_EXEC_TOOLS 里的名字）
  // → 成员只能用 `Get-ChildItem -Recurse` 扫盘（实测 99 次，占全部命令 12.7%）。
  "glob",
  "grep",
  // 2026-11-17 P4-1：符号四件套。定位代码先看结构（repo_map / find_symbol）、
  // 再只读那一段（read_symbol）、改之前查引用（find_references）——不再整篇读 + grep 猜。
  "repo_map",
  "find_symbol",
  "read_symbol",
  "find_references",
  "run_command",
  "office_read_table",
  "office_write_table",
  "office_write_docx",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_extract",
  "browser_close",
  "kb_add",
  // 外部应用（能力中心 · 连接器）：凭据在核心里，成员只给 app id + 路径/命令
  "app_api",
  "ssh_run",
] as const;

export type MemberChatFn = typeof streamChat;

/**
 * 群内中途发言（2026-11-16）：成员不再"静默跑完、只交一次终局回报"。
 *
 * 这套机制不是自造的，参考的是几个成熟多 agent 项目的做法：
 *  - ChatDev 的 "communicative dehallucination"：执行前先把口径问清，比猜着做完整单便宜得多；
 *  - MetaGPT 的消息总线：消息带类型（cause_by）与来源，只有相关方才被唤醒——不广播全群；
 *  - openspawn / LobeHub 的 agent-communication 纪律：沉默即成功，按打断级别分级，
 *    只有"阻塞级"（提问 / 风险）才叫醒人，进展与结论走频道帖，且每单有硬上限。
 * 所以这里只有 4 种发言，不是自由聊天：update 进展 / finding 结论 / question 疑问 / risk 风险。
 */
export const MEMBER_POST_KINDS = ["update", "finding", "question", "risk"] as const;
export type MemberPostKind = (typeof MEMBER_POST_KINDS)[number];

export interface MemberPost {
  kind: MemberPostKind;
  text: string;
  /** 这条疑问必须风铃答复才能继续（缺省 = 问一句后继续做不依赖它的部分） */
  needAnswer?: boolean;
}

/**
 * 发言硬上限（AutoGen 的教训：群聊没有终止条件就会一直说，直到预算烧完）：
 * 一单最多 8 条、同一轮最多 1 条、同一句不重复、单条 ≤ 600 字。
 * 上限到了就让它把剩下的写进终局回报——那不是"闭嘴"，是把信息落到该落的地方。
 */
const POST_MAX_PER_TASK = 8;
const POST_MAX_CHARS = 600;

/**
 * 简报质量闸（纯函数）：风铃派单前代码层把关，不靠提示词自觉。
 * 合格简报必须能让一个看不到对话的成员独立开工：目标 / 完成标准 / 材料位置 / 限制。
 * 返回 null = 合格；否则返回给风铃的退回说明（含重写模板，一轮就能改对）。
 */
export function validateBrief(brief: string, acceptance?: string[]): string | null {
  const text = (brief ?? "").trim();
  const hasAcceptance = Array.isArray(acceptance) && acceptance.filter((a) => String(a).trim()).length > 0;
  const missing: string[] = [];

  /**
   * 大文本直接贴进简报 → 退回并教她分片（2026-11-19 今日复盘）。
   *
   * 实机：写作单把 1200~1800 字成稿规格 + 整套禁用词清单全贴进简报，
   * 10 轮用尽、桌面零产出。复盘自己的结论是「大文本分片写」——但那是
   * **派单侧**该做的：底稿不该整篇塞进简报，应拆成 part 文件让成员读。
   *
   * 判据用「最长连续行」而非总长：简报四段模板本身有几百字正常，
   * 但一段连续正文（>600 字、无换行、不像路径/命令）通常是"把成稿贴进来了"。
   */
  const longestRun = text
    .split("\n")
    .reduce((max, line) => Math.max(max, line.trim().length), 0);
  // 排除：整行像路径/命令/JSON（这类长行是正当的）
  const looksLikePathOrCode = (line: string) =>
    /^[A-Za-z]:[\\/]/.test(line) || /^[{[]/.test(line) || line.includes("\\") || line.includes("/");
  if (longestRun > 600 && !text.split("\n").some((l) => l.trim().length === longestRun && looksLikePathOrCode(l.trim()))) {
    return [
      "简报里有一段超长正文（单行 >600 字），已退回，没有派单。",
      "不要把成稿/长正文整段贴进简报——成员用 write_file 一次写不了这么长，会卡到轮次耗尽仍零产出（实机反复踩）。",
      "正确做法（大产出分片）：",
      "  1) 把正文拆成 2~3 个 part 文件，先用 write_file 落到工作区（如 draft-part1.md / part2.md）；",
      "  2) 简报里只写「读 draft-part1..N.md，核对/改写/合并到 <产物>」，把大内容放在文件里、不放简报里；",
      "  3) 若必须贴，选关键约束（禁用词、字数、格式），不要整篇。",
    ].join("\n");
  }

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
  /**
   * 本次禁区（2026-11-12，借 leader 的"法与情报分家"）：
   * 点名不许做的事——"不许把测试 skip 掉""不许 mock 被测对象"。
   * 这是**法**：违反即不合格，不是建议。与岗位档案的通用边界区分开。
   */
  forbidden?: string[];
  /** 取舍口径：冲突时保什么（如"算得对 > 做得全 > 做得快"）。不给成员就自己猜。 */
  priority?: string;
  /** 任务型态：execute = 要产物；explore = 要结论与依据（调研/选型，别硬凑产物） */
  mode?: "execute" | "explore";
  /**
   * 这个岗位过去的经验（2026-11-17 P3-2 / 08 章 §3）：来自池子的 L2 层。
   * **只进首条 user，绝不进 system**——L2 天天在变，进 system 就等于每轮都付、
   * 而且每次都换前缀（缓存命中率与行为可复现性一起崩）。
   */
  lessons?: readonly Lesson[];
  /** 工具二级加载开关（缺省看 LYNN_LAZY_TOOLS；测试注入用） */
  lazyTools?: boolean;
  /**
   * 本轮只重做这些未过判据（打回后重派时给，2026-11-15）。
   * 没有它，成员会把已通过的部分推翻重做——既费轮次，也让"改了什么"无法核对。
   */
  focus?: string[];
  /** 轮次上限覆盖（派单时指定）；缺省用岗位档案 limits.maxTurns */
  maxTurns?: number;
  /**
   * 墙钟预算（分钟）。轮次之外的另一条硬约束：核实类任务常常把时间全花在读上，
   * 到点才发现一个文件都没写。给中途提醒用（50% / 75% 各催一次"先落盘"）。
   */
  budgetMinutes?: number;
  /** 任务工作区：成员一切文件活动的边界（绝对路径） */
  workdir: string;
  /** 项目名（2026-11-12）：成员要知道自己动的是哪个项目，回报里也得说清 */
  projectName?: string;
  /** 过程文件目录（永远在数据根内，可被清理）；缺省不提示 */
  scratchDir?: string;
  /** 用户授权的只读目录：读可以进，写仍然只能在工作区（函数 = 每次现取，跑到一半授权也生效） */
  readRoots?: string[] | (() => string[]);
  /** 用户授权的可写附加根：只影响命令 cwd；文件写入仍只走工作区 */
  writableRoots?: string[] | (() => string[]);
  /** 删除类命令的审批闸：成员能改代码，但删除必须用户点头（低风险自清理工具层会自己放行） */
  onBeforeCommand?: (command: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 本单开工时间（ms）：用于判定"这些删除目标是不是本单自己造的" */
  runStartedAt?: number;
  /** 权限档=全权时，工作区内删除不再逐次点头（壳注入） */
  autoDeleteInWorkspace?: () => boolean;
  /** 出站闸（审计 #2）：false 时成员的 curl/wget/ssh 类命令直接拒；不传 = 只审计不拦 */
  outboundAllowed?: () => boolean;
  /**
   * 命令沙箱（2026-11-19 第一阶段）：提供时成员命令走 sandbox-exec（Job Object）。
   * 不可用如实降级、回调 onSandboxDegraded。不传 = 直接 execa（旧行为）。
   */
  sandbox?: ToolkitOptions["sandbox"];
  onSandboxDegraded?: (reason: string) => void;
  /**
   * 可注入的技能清单（2026-11-19 修 C1b：成员侧此前**完全不加载技能**）。
   *
   * 只有"技能的 allowed-tools 全部在本次工具集内"的才会被注入——这是**客观判据**，
   * 不靠关键词猜任务类型。注入位置是首条 user（不进 system，保住缓存前缀）。
   * 不传 = 不注入（旧行为，零影响）。
   */
  skills?: readonly { name: string; description: string; allowedTools: readonly string[]; body: string }[];
  model: { baseUrl: string; apiKey: string; model: string };
  /** 测试注入；默认真流式 */
  chatFn?: MemberChatFn;
  /**
   * 进度回调（内核用来发工具卡）。
   * `tool-start` 在工具**开始**时就发——长命令跑 100s 期间界面不能一动不动（实机把"在跑"看成"卡死"）。
   */
  onEvent?: (ev: { kind: "tool" | "tool-start" | "note" | "turn"; text: string; progress?: number }) => void;
  /**
   * 群内中途发言（2026-11-16）：成员说给群里听的一句话（进展/结论/疑问/风险）。
   * 内核负责落卡、按打断级别路由（只有提问与风险才叫醒风铃）与限流；返回值是给成员看的回执。
   */
  onMessage?: (post: MemberPost) => string;
  /** 命令审计回调（M1-11：壳写 audit.jsonl） */
  onAudit?: (ev: {
    kind: "cmd_blocked" | "cmd_net" | "cmd_run" | "cmd_auto";
    command: string;
    why?: string;
    cwd: string;
  }) => void;
  /**
   * 工具调用审计（2026-11-11）：只给内核按类别记日志用，不改变执行语义。
   * 实机「成员跑完未交付」时，只能看到没交回报，看不到它到底调没调工具、调成什么样。
   */
  onToolCall?: (ev: { name: string; args: string; outcome: string; ok: boolean; ms: number }) => void;
  /** 写前通知（M1-12 检查点） */
  onBeforeWrite?: (rel: string, full: string, existed: boolean) => void;
  /**
   * 写盘前的文本改写（2026-11-15 旧「去 AI 味」插件遗留，现已无人注入）。
   * 改写产出会让「交付物 ≠ 通过校验的文本」，保留字段只为兼容旧调用方。
   */
  onWriteContent?: (rel: string, content: string) => string;
  /**
   * 写作规则（2026-11-15 重做）：约束生成的那段文本，拼进成员系统提示词。
   * 空 = 插件没装，成员按原样写。
   */
  writingRules?: string;
  /** office 能力桥接（M2-06）：壳按引擎健康注入；不注入时成员调 office 工具会得到如实提示 */
  office?: ToolkitOptions["office"];
  /** browser 能力桥接（M2-07）：单例控制器；不注入时成员调 browser 工具会得到如实提示 */
  browser?: ToolkitOptions["browser"];
  /** 知识库写入桥接（M2-08） */
  kb?: ToolkitOptions["kb"];
  /** 外部应用桥接（能力中心 · 连接器）：app_api / ssh_run 的实际执行方，未配置时工具如实拒绝 */
  apps?: ToolkitOptions["apps"];
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
  /** 命中缓存的输入 token（端点没报就是 0——不估假命中率，2026-11-13 缓存分析补的可观测） */
  cacheReadTokens: number;
  /** 写入缓存 / 未命中的输入 token（Anthropic 语义；DeepSeek 类为 0） */
  cacheWriteTokens: number;
  /**
   * 这一轮真正写出去的文件（2026-11-16）：轮次用尽/中止时也要如实交回——
   * 成员常常已经把东西写出来了，只是没走 submit_report；那不算零。
   */
  producedFiles: string[];
  error?: string;
}

// ---------- 成员工具实现（官方 L1 工具集，见 toolkit.ts） ----------

// 兼容旧引用：路径边界与工具实现都收敛到 toolkit 一份，成员与工作台共用
export { resolveWithin };

// ---------- 成员工具 schema（OpenAI 兼容） ----------

/** 骨架稿特征：这些词出现在回报正文且没有交付物时，判定为占位稿（2026-11-14） */
const PLACEHOLDER = /\b(TODO|FIXME|TBD)\b|待补充|待完善|占位符|占位文本|待填/;

/** 回报通道：不属于执行工具，任何白名单都不能把它剥掉（§4.10.5） */
const SUBMIT_REPORT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "submit_report",
    description:
      "把这一单的结果交回给风铃：text 开头标状态（【完成】/【完成有保留】/【受阻】/【缺上下文】），写结论、交付了什么与未完成项；deliverables 列用户要带走的产物（会永久保留）；evidence 只做内部核对，可不填。中途进展用 post_message，不要拿它当回报。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "结论 / 未完成 / 需要升级的说明" },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "可选：工作区或只读根里真实存在的文件路径；关键任务风铃会要求，普通任务不强制",
        },
        deliverables: {
          type: "array",
          items: { type: "string" },
          description: "交付物路径（用户要带走的东西：报告/表格/图片）；与证据分开，验收后永久保留",
        },
        checks: {
          type: "array",
          description:
            "对简报里「完成标准」的逐条核对（可选，但建议给）：每条形如 {name:'数字可对账', pass:true, evidence:'report.md 第 3 节'}。风铃验收先看这张表。",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "对应哪一条完成标准" },
              pass: { type: "boolean", description: "过了没有" },
              evidence: { type: "string", description: "在哪能看出来（文件+段落）" },
            },
            required: ["name", "pass"],
          },
        },
      },
      required: ["text", "evidence"],
    },
  },
};

/**
 * 群内中途发言通道（2026-11-16）。与 submit_report 一样不占执行工具白名单：
 * 它是"说话"，不是"干活"，任何岗位都应该能开口（提问/报风险是基本协作能力）。
 */
const POST_MESSAGE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "post_message",
    description:
      "在群里说一句（中途发言，不是回报）：update=进展（做完哪块、下一步）；finding=已确认的结论/推理结果（带一句依据）；question=有疑问，需要风铃答复（她在你下一轮前回）；risk=发现前提不成立、按简报做不下去、或你前面的结论错了（写清错在哪、改成怎么做）。一次只说一件事、1~3 句，只在有信息量时用。",
    parameters: {
      type: "object",
      required: ["kind", "text"],
      properties: {
        kind: { type: "string", enum: [...MEMBER_POST_KINDS] },
        text: {
          type: "string",
          description: `1~3 句人话，≤${POST_MAX_CHARS} 字：结论 / 状态 / 问题本身（不要贴命令输出或整段报告）`,
        },
        needAnswer: {
          type: "boolean",
          description: "仅 question：这条不答复就做不下去时置 true；能继续推进就省略",
        },
      },
    },
  },
};

/**
 * 内置工具的**共享注册表**（2026-11-17 P8-1）。
 *
 * 成员运行时不需要文件/命令的副作用，只需要 schema——所以用一个只装 schema 的轻量注册表，
 * 而不是构造完整 Toolkit（那会建目录、读设置）。
 *
 * 顺序按 `TOOLKIT_SCHEMAS` 的声明序（`schemasFor` 保注册顺序）：
 * 成员的工具段在 P2/P4 已经稳定，换顺序等于把前缀缓存全废一次。
 */
const BUILTIN_REGISTRY = (() => {
  const reg = new ToolRegistry();
  for (const schema of TOOLKIT_SCHEMAS) {
    reg.register({
      name: schema.function.name,
      schema,
      // 只用来取 schema；真执行走 Toolkit。这里放一个明确拒绝的实现，
      // 万一有人误用也不会静默成功。
      execute: () => {
        throw new Error(`${schema.function.name} 只能通过 Toolkit 执行`);
      },
      origin: "builtin",
    });
  }
  return reg;
})();

export function memberToolSchemas(allowed: string[], opts: { lazy?: boolean } = {}): ToolSchema[] {
  return [
    ...BUILTIN_REGISTRY.schemasFor(allowed),
    // 二级加载时把 tool_search 一起发下去（它自己必须常驻，否则模型没法发现长尾工具）
    ...(opts.lazy ? [TOOL_SEARCH_SCHEMA] : []),
    SUBMIT_REPORT_SCHEMA,
    POST_MESSAGE_SCHEMA,
  ];
}

/**
 * 工具输出中间截断（2026-11-16 缓存与上下文）：
 * 成员每轮都把整段工具输出塞回上下文，几万字符的一条目录列表会把输入撑爆——
 * 缓存命中率随之掉下来（新增 token 占分母），也更容易在长上下文里复读。
 * 头尾各留一段：开头是"它要的结论"，结尾常是报错/汇总，中间丢掉的补一句怎么取回来。
 */
/** 一单最多搜几次工具：每搜一次工具面变一次 = 一个前缀断点 */
const SEARCH_MAX = 3;

const TOOL_OUTPUT_CAP = 12_000;
export function clipToolOutput(text: string): string {
  const s = String(text ?? "");
  if (s.length <= TOOL_OUTPUT_CAP) return s;
  const head = Math.floor(TOOL_OUTPUT_CAP * 0.6);
  const tail = TOOL_OUTPUT_CAP - head;
  return `${s.slice(0, head)}\n\n…（中间 ${s.length - TOOL_OUTPUT_CAP} 字符已省略，避免上下文与缓存膨胀；要看全就用分页/偏移/更窄的查询取回）…\n\n${s.slice(-tail)}`;
}

// ---------- 成员系统提示词（档案 → 提示词，纯文本编译） ----------

/**
 * 档案里两段**用户可自由书写**的内容要不要设上限，是个真问题（2026-11-17 P3-1b）。
 *
 * 如果把整段正文原样塞进 system，那么「成员 system ≤2.6K」就不是代码能保证的事——
 * 它取决于某个成员档案被写多长。所以这里给硬预算：边界最多 6 条、正文最多 240 字，
 * 超了截断并注明「完整内容见档案」。岗位说明本该是一页纸，写超了是档案该改，不是提示词该胖。
 */
const BOUNDARY_BUDGET = 6;
const BODY_BUDGET = 240;

function clipText(text: string, budget: number): string {
  const s = String(text ?? "").trim();
  if (s.length <= budget) return s;
  return `${s.slice(0, budget)}…（已截断，完整内容见档案）`;
}

export function memberSystemPrompt(input: MemberRunInput): string {
  const p = input.profile;
  /**
   * 按工具面裁剪（2026-11-17 P3-1b / 05 章 §5「领域假设裁剪」）。
   *
   * 判据是**客观的：这件工具在不在本次白名单里**，不是猜"这个人大概用不用得上"。
   * 没发 run_command 的成员，读 500 字 shell 口径就是纯噪音——而且它是每轮都付的。
   * 裁掉之后 office 系成员的 system 会短一大截，coding 系保留（它确实需要）。
   */
  const has = (t: string): boolean => input.tools.includes(t);
  const canRun = has("run_command");
  const canOffice = input.tools.some((t) => t.startsWith("office_"));
  const canExt = has("app_api") || has("ssh_run");
  return [
    `你是「${p.name}」，岗位：${p.role}。你只对风铃（Lynn）负责，不直接面对用户。`,
    `你的单一目标：${p.goal}`,
    "",
    "【边界（违反即失职）】",
    ...(p.boundaries.length
      ? p.boundaries.slice(0, BOUNDARY_BUDGET).map((b) => `- ${b}`)
      : ["- （档案未写边界；保守行事，只做简报里明确要求的事）"]),
    ...(p.escalateWhen.trim() ? ["", `【何时必须停手升级】${p.escalateWhen.trim()}——命中就立刻回报，不要硬扛。`] : []),
    ...(p.body.trim()
      ? [
          "",
          "【岗位工作方式】",
          clipText(p.body, BODY_BUDGET),
        ]
      : []),
    "",
    "【你的工具】",
    // 具体工具清单不写进 system（2026-11-19 C2 缓存修复）：工具集随单变，写进 system 会让
    // 每单整段前缀作废。清单在首条 user 的【本次授权】里给（已有）。这里只说纪律。
    "- submit_report：回报通道（终局）。**剩最后 2 轮必须停手交回**，没做完也交（做到哪、卡在哪、需要什么）。不交 = 这张单白跑。",
    "- post_message：群内中途发言（纪律见【群内发言】）；它不是回报，交活仍用 submit_report。",
    // 实机事故：简报给了 `src/components`，成员却用 `Get-ChildItem -Recurse` 扫整个仓库找 components，
    // 一条命令跑 100s 无输出，用户以为成员死了。
    // 2026-11-16 复核：光在提示词里点名 glob 不够——glob/grep 当时根本不在执行面里，
    // 成员只能退回扫盘（实测此类命令 99 条）。现在两个工具真发下来了，这条才成立。
    "- 找东西别扫盘：目录 list_dir、按模式 glob、搜内容 grep；**定位代码先看结构**（repo_map 看目录里有什么 → find_symbol 按名字搜 → read_symbol 只读那一段 → 改前 find_references 查引用）。**别用 Get-ChildItem -Recurse / dir /s 扫全仓**。",
    "- 命令行要窄：限定目录、只读、一次说清目的；超过 60s 无输出算「可能卡住」，120s 超时终止——超时的命令不算证据。",
    "- 你没有 ask_user，不能问用户；口径拿不准就选一种并写明理由。需要升级时在回报正文标 ESCALATE: 并说明。",
    // 命令载体口径（2026-11-16 按实测补齐）：run_command 的 shell 是 cmd.exe（非 Windows 是 sh），
    // 不是 bash —— 实测成员混用 POSIX 工具与 Windows 通配/反斜杠路径，命令直接失败；
    // 另有 74/88 条 python 命令是 `-c` 内联，多行与中文几乎必被引号层吃掉。
    ...(canRun
      ? [
          "",
          "【命令与脚本（按这套选）】",
    "- shell 是 cmd.exe（非 Windows 是 sh），**不是 bash**：`*.tsx` 不会被展开，反斜杠路径与 POSIX 命令混用会直接失败；要匹配交给 glob / grep。",
    "- 写脚本前先探运行时（`node -v` / `python --version`），用探到的那个，**优先 node**；都没有就如实说做不到。",
    "- 脚本超过一两行就 write_file 落到过程目录再执行，**不要用 `-c` 塞多行**：多行、中文、JSON 引号穿过 shell 几乎必坏。",
          "- 一条命令只做一件事：坏在哪一步才好定位。",
        ]
      : []),
    ...(canExt
      ? [
          // 外部应用（2026-11-15）：凭据在核心里，成员只给 app id + 路径/命令
          "- 外部应用：`app_api` 调已连接的 GitHub / Gitee / AtomGit / 网盘（只给 app id 与路径，令牌由内核带上）；`ssh_run` 跑只读排查命令。两者以只读为主，写操作前先说清对象与影响。",
        ]
      : []),
    ...(canOffice
      ? [
          // 实机事故：用户要 Word，主代理说「没装 python-docx 就做不了」并反问路径。
          // 文档产出是成员能干的活：写脚本 + 跑命令，零依赖也能生成最小 docx。
          "- 文档产出：**Word 优先 office_write_docx**（标题/段落/列表/表格，进程内零依赖）；复杂排版（图片/公式/目录域）才用脚本兜底——python-docx 属这类，先确认能 `import docx`，不能就如实说做不到，**不要手写 OOXML**。Excel 用 office_write_table。PDF 无现成生成工具：写脚本或先出 HTML/Word 再转。",
        ]
      : []),
    "- **内容型产物不许交骨架**：每章至少 2~3 句实质内容。只给标题加一句概括＝骨架稿，会被打回；宁可少写两章也不要每章空的。拼正文时检查 undefined / 空字段——模板变量没取到值会原样印进文档。",
    "",
    "【工作区与文件去向】",
    // 具体工作区/projectName/scratchDir/readRoots/writableRoots 不写进 system（2026-11-19 C2 缓存修复）：
    // 这些每单都不同，写进 system 会让缓存前缀每单作废。取值在首条 user 的【本次授权】里给。
    // system 只讲**跨任务不变**的纪律。
    "- 写文件用工作区内相对路径；过程文件写进过程目录、交付物写进 deliverables/（具体路径见【本次授权】）。写永远只在工作区，只读根随单给。",
    "- 不能写 `.git/` 与 `.lynn/`（工具层直接拒）。",
    "- **删除类命令（del/rm/rmdir/move/改名/git clean/reset --hard）必须用户点头**：被拒就改成可撤销的覆盖写或在回报里说明，别换写法绕。",
    "",
    // 权限/地点边界（2026-11-15）：实机里成员读不到系统目录会反复换路径硬试，
    // 一条路失败十几次，最后交回一张"什么都找不到"的回报——空转的真正来源。
    "",
    "【地点与权限边界（读不到就停手，不要换路径硬试）】",
    "- 读写地点就是工作区（写）与列出的只读根（读）；这两处之外**读不到**，工具层直接拒。",
    "- 读不到时不要换绝对路径、不要换命令绕（cd / 通配符 / 递归搜索都不行）：**最多试两种写法**，仍失败就停手。",
    "- 停手回报：标【缺上下文】或【受阻】，写明「需要授权：<绝对路径>（用途：…）」——风铃会补授权或换材料。",
    "- **授权归风铃，不归你也不归用户**：她判风险后决定给不给。你不能自己扩权（换路径、改配置、调高限额、绕过工具层都不行），也没有「放手」级权限——删除、对外发送永远过闸。",
    "- 同一条命令、同一个路径失败 2 次就停手：重复同样的失败不算努力，只烧轮次。",
    "",
    "【产出契约】",
    `- 交付物：${p.outputContract.deliverable}`,
    "- 交付物列进 submit_report 的 deliverables（与 evidence 分开），写完一个交一个：用户要带走的会永久保留，只写进证据不算交付。",
    "- 验收标准逐条写进 checks（name=哪条、pass=过没过、evidence=在哪能看出来）；没过的如实写 false，不要凑。",
    ...p.outputContract.evidence.map((e) => `- 证据要求：${e}`),
    ...p.outputContract.acceptance.map((a) => `- 验收标准：${a}`),
    "",
    /**
     * 交付纪律（2026-11-16）：日志实测 1451 次工具调用里 write_file 仅 19 次，
     * 成员的真实失败模式是"先核实、后写"，轮次/时间耗尽时零落盘（前面所有阅读作废）。
     * 这段与运行时的"第 3 轮没落盘就催"配合使用。
     */
    "【交付纪律（要产物，不是读完所有材料）】",
    "- **先写后补**：确认第一批事实就先写进目标文件（骨架也算一版），之后覆盖更新。",
    "- **不许只读不写**：整轮只做过 list_dir / read_file / grep 却报告「材料很全」，等于没交活。",
    "- **有缺口也要交**：没写完的标「待补」并说明缺什么——有标注的成品比零落盘强。",
    "",
    /**
     * 群内发言纪律（2026-11-16）：成员在一支真实的工作群里，而不是"黑盒跑完才开口"。
     * 但真实群聊的价值在"有信息量"，不在"话多"——所以同时给硬纪律（每单 8 条 / 每轮 1 条），
     * 代码层也拦（member-runner 的 post_message 分支）。
     */
    "【群内发言（你在真实工作群里，不是只在最后交一次卷宗）】",
    "- 用 post_message 说人话：做完一块说 update；想清楚了说 finding（结论+一句依据）；口径/材料/取舍拿不准说 question；前提不成立或前面结论错了说 risk（错在哪、改成怎么做）。",
    "- **有疑问先问再决定**：口径不清、两源冲突、要不要覆盖已有文件，先 question。答复在你下一轮开头送达——问完别停在那等，继续做不依赖它的部分。",
    "- **别刷屏**（一单 ≤8 条、每轮 ≤1 条）：只有状态真变了 / 结论真有了 / 真卡住了才说。命令输出、逐条阅读进度、下一步打算都不算——界面上已有进度卡。",
    "- 像同事说话：一句结论+一句依据。不写「我正在努力推进」，也别把整段报告粘进群。**中途发言不替代 deliverables**，做完仍必须 submit_report。",
    "",
    "【回报纪律】",
    "- 完成后必须调用 submit_report；evidence 可选：有真实产物就列路径，没有就如实写「无附证据」。**别虚报**——没做完就写做到哪、卡在哪。",
    "- 开头标状态：【完成】做好且核对过；【完成有保留】做完但有疑虑（写明）；【受阻】卡住（卡在哪、缺什么）；【缺上下文】简报不够（缺什么）。",
    "- 缺关键材料、目标矛盾、工具不够用：**第一轮就停手回报**，不要猜着做——烂交付不如不交付，停下不会怪你。",
    "- 交回报前自审三问：①完成标准逐条过了吗？②交付物与证据里的文件真的存在、是本次产出的吗？③有没有「应该没问题」但没验证的地方？有就改成【完成有保留】并写明。",
    // 写作规则（2026-11-15 重做）：约束的是措辞本身，交付物与回报正文都算
    ...(input.writingRules?.trim() ? ["", input.writingRules.trim()] : []),
  ].join("\n");
}

/**
 * 任务级上下文（2026-11-17 P3-1b / 05 章「关键：简报从 system 移到首条 user」）。
 *
 * 为什么必须搬出来：这些内容**每单都不一样**。留在 system prompt 里，
 * 同一个岗位、同一个领域的第二个任务就得把整段 system 重新发一遍、重新按全价算——
 * 而 system 是每次调用最贵的那一段。搬到首条 user 之后，同 role×domain 的成员
 * 在**不同任务之间共享同一段前缀**，这才是把「缓存按角色复用」变成现实的那一步。
 *
 * 内容一条没删，只是换了个位置——位置本身决定了它是不是每轮都要付。
 */
export function memberTaskIntro(input: MemberRunInput): string {
  const parts: string[] = [`【本次任务简报（截止：${input.deadline}）】\n${input.brief}`];
  if (input.forbidden?.length) {
    parts.push(
      [
        "【本次禁区（法：违反即不合格，不是建议）】",
        ...input.forbidden.map((f) => `- ${f}`),
        "- 这些是这次任务的硬红线：别用「绕过」的方式凑指标（例如改断言、加 skip、放宽阈值、mock 被测对象）。",
      ].join("\n"),
    );
  }
  if (input.priority?.trim()) parts.push(`【取舍口径（冲突时保什么）】${input.priority.trim()}`);
  if (input.mode === "explore") {
    parts.push(
      [
        "【本次是探索型任务（调研/选型/找方案）】",
        "- 要的是**结论 + 依据 + 不确定性**，不是「产物齐全」：别为了交差硬凑文件。",
        "- 别把猜测写成事实：不确定的地方明说「未验证」，比编一个像样的答案有用。",
      ].join("\n"),
    );
  }
  if (input.focus?.length) {
    parts.push(
      [
        "【本轮只重做这些未过项（上一轮打回的）】",
        ...input.focus.map((f) => `- ${f}`),
        "- 已经通过的部分**不要推翻重做**：保持原样，把力气放在上面这几条。改完在回报里逐条说明改了什么、在哪能看出来。",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ---------- 执行循环 ----------

/** 成员最多注入几个技能（多了会把首条 user 撑爆，反而挤掉简报重点） */
const MEMBER_SKILL_LIMIT = 2;
/** 技能正文总字数上限 */
const MEMBER_SKILL_BUDGET = 2_000;

/**
 * 给成员注入技能（2026-11-19 修 C1b）。
 *
 * ## 为什么之前是空的
 *
 * `member-runner` 里**完全没有技能加载逻辑**：技能只被风铃读（`kernel.discoverSkills`
 * 写进 `dataRoot/skills`），成员从来看不到。于是"text-check / csv-analysis / text-diff"
 * 这类**讲成员工具**的预置技能，风铃读了也调不到（她只有管理工具），成员又根本收不到——
 * 三段能力等于全部悬空。
 *
 * ## 判据为什么是 allowed-tools 而不是关键词
 *
 * 猜任务类型（"这单是不是写作"）只能靠关键词，错一次就注入错技能、白占上下文。
 * 而"技能声明的 allowed-tools 是否**全部**在本次工具集里"是**客观事实**：
 * 成员手上没有那个工具，就算注入技能它也做不了——反过来说，工具都在，技能就能落地。
 *
 * ## 位置
 *
 * 注入首条 user（不进 system）：技能随单变，塞进 system 会把缓存前缀每单打散。
 */
export function renderMemberSkills(
  skills: readonly { name: string; description: string; allowedTools: readonly string[]; body: string }[] | undefined,
  tools: readonly string[],
): string {
  if (!skills?.length) return "";
  const have = new Set(tools);
  const matched: string[] = [];
  let used = 0;
  for (const s of skills) {
    if (matched.length >= MEMBER_SKILL_LIMIT) break;
    // 客观判据：技能要求的工具必须全在本次工具集里（submit_report/post_message 是固定通道）
    const need = s.allowedTools.filter(Boolean).filter((t) => t !== "submit_report" && t !== "post_message");
    if (!need.length || !need.every((t) => have.has(t))) continue;
    const body = String(s.body ?? "").trim();
    if (!body) continue;
    const room = MEMBER_SKILL_BUDGET - used;
    if (room < 200) break;
    const clipped = body.length <= room ? body : `${body.slice(0, room)}…（技能正文已截断）`;
    matched.push(`### ${s.name}\n${s.description}\n\n${clipped}`);
    used += clipped.length;
  }
  if (!matched.length) return "";
  return ["【可用技能（本次工具集覆盖的技能，按它做能少走弯路）】", ...matched].join("\n\n");
}

export async function runMemberTask(input: MemberRunInput): Promise<MemberRunResult> {
  /**
   * 成员的单轮调用**必须有重试**（2026-11-16 日志复盘：此前默认直连 `streamChat`，
   * 一次 429 或一次超时就把整单打成 error，风铃再重派 → 从零读一遍材料）。
   * 注入点（测试/整链路）仍然优先。
   */
  const chat = input.chatFn ?? streamChatWithRetry;
  const toolkit = new Toolkit(input.workdir, {
    onAudit: input.onAudit,
    onBeforeWrite: input.onBeforeWrite,
    onWriteContent: input.onWriteContent,
    office: input.office,
    browser: input.browser,
    kb: input.kb,
    apps: input.apps,
    readRoots: input.readRoots,
    // 自清理分级：本单开工后新造的文件删除不打扰用户；全权档连工作区内删除也放行
    runStartedAt: input.runStartedAt,
    autoDeleteInWorkspace: input.autoDeleteInWorkspace,
    outboundAllowed: input.outboundAllowed,
    // 命令沙箱（2026-11-19 第一阶段）：jobonly 就够给内存/进程上限 + 干净强杀
    sandbox: input.sandbox,
    onSandboxDegraded: input.onSandboxDegraded,
    // 停机要能连正在跑的命令一起杀，否则最长等满 120s 超时
    signal: () => input.signal,
    writableRoots: input.writableRoots,
    onBeforeCommand: input.onBeforeCommand,
  });
  const maxTurns = Math.max(1, Math.min(input.maxTurns ?? input.profile.limits?.maxTurns ?? 12, 40));
  /**
   * 工具面（2026-11-17 P4-2）：热路径常驻 + 长尾按需。
   * `unlocked` 只增不减；每解锁一次工具面变一次（一次前缀断点），
   * 所以搜索次数有上限（见 execTool 里的 tool_search 分支）。
   */
  const lazyOn = input.lazyTools ?? (process.env.LYNN_LAZY_TOOLS !== "0");
  const unlocked = new Set<string>();
  let surface = memberSurface(input.tools, unlocked, lazyOn);
  let tools = memberToolSchemas(surface.names, { lazy: surface.lazy });
  let searchCount = 0;
  /**
   * 授权清单放在**第一句话**里（2026-11-16 实机：「启动阶段没交代权限，做一半才发现写不了」）。
   * 系统提示词里也有同样的信息，但那是背景；成员第一眼要看到的就是"我能写哪、只能读哪、
   * 用哪几件工具、几轮、缺权限该在什么时候停手"——这些直接决定它会不会白跑一趟。
   */
  const rootsNow = (): string[] => (typeof input.readRoots === "function" ? input.readRoots() : input.readRoots) ?? [];
  const initialRoots = rootsNow();
  const authLines = [
    ...(input.projectName ? [`- 项目：${input.projectName}（回报和交付物里要让人看得出是哪个项目）`] : []),
    `- 写入范围：${input.workdir}（只有这里可写；.git/ 与 .lynn/ 除外）`,
    ...(input.scratchDir
      ? [`- 过程目录（下载/解压/测试输出/缓存）：${input.scratchDir}`]
      : []),
    `- 只读范围：${initialRoots.length ? initialRoots.join("、") : "无额外授权（工作区之外读不到）"}`,
    `- 本次工具：${input.tools.join("、") || "（无执行工具）"} + submit_report`,
    `- 轮次上限：${maxTurns} 轮（剩最后 2 轮必须停手交回，哪怕没做完）`,
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: memberSystemPrompt(input) },
    {
      role: "user",
      content: [
        `任务开始，截止 ${input.deadline}。`,
        `【本次授权】\n${authLines}`,
        // 任务级内容（简报/禁区/取舍/探索型/重做项）：每单都不同，所以只在这里出现一次
        memberTaskIntro(input),
        // 技能（2026-11-19 C1b）：只注入"allowed-tools 全在本次工具集内"的技能
        renderMemberSkills(input.skills, input.tools),
        "先读一遍简报，用 list_dir/read_file 核对材料是否真的在；缺关键材料、缺权限或目标不清就立刻 submit_report 标【缺上下文】" +
          "（写明「需要授权：<绝对路径>」），不要换路径硬试、不要猜着做。材料齐了就开工，完成后 submit_report。",
        // 经验放最后：前面几段是每单都一样的骨架，接在后面不会把稳定前缀推开
        renderLessons(input.lessons ?? []),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  /**
   * 中途补授权（2026-11-16）：只读根是函数现取的，但系统提示词只构造一次——
   * 用户跑到一半批准了目录，成员其实读得到、却不知道自己能读。
   * 这里在轮次边界比对一次，只在真变化时补一句（不变化就不加，前缀缓存不破）。
   */
  let knownRoots = initialRoots.slice();
  /**
   * 这一轮真正写出去的文件（2026-11-16）：日志实测 1451 次工具调用里 write_file 只有 19 次，
   * 成员把时间全花在读上，最后什么都没落盘。这里记住写成功的文件：
   *  - 早写提醒（第 3 轮还没有任何写入就催它先落一版）；
   *  - 收尾时把"已写出的文件"如实交回，别让已经产出的东西随轮次一起归零。
   */
  const writtenFiles: string[] = [];
  let nudgedWrite = false;
  let nudgedHalfTime = false;
  let nudgedLateTime = false;
  /** 连续模型失败次数（单轮超时/瞬时限流）：在同一个 run 里续跑，不把整单作废 */
  let modelFailures = 0;
  /**
   * token 预算闸（2026-11-16 日志复盘）。
   * limits.budgetTokens 此前只用于编制表显示（budgetUsed/budgetTotal），执行时从不校验——
   * 实机出现单张单烧 135 万 prompt tokens（预算写着 30 万）后才因轮次耗尽退出。
   * 现在到额就强制收尾：再给一轮"只交回报"，不给继续勘察的机会。
   */
  const tokenBudget = Math.max(0, input.profile.limits?.budgetTokens ?? 0);
  let budgetStop = false;
  /** 预算到额进入"最后一轮收尾"（2026-11-19 C5）：本轮跑完仍未交回报才判停 */
  let budgetClosing = false;
  /** 折叠提示只报一次：每轮都报会把「进度」卡刷满 */
  let foldedNoticed = false;
  const runStartedAt = input.runStartedAt ?? Date.now();
  const budgetMs = Math.max(0, (input.budgetMinutes ?? input.profile.limits?.wallClockMin ?? 0) * 60_000);

  /**
   * 交付物兜底（2026-11-16）：成员写了文件却忘了在 deliverables 里列，
   * 结果产物在磁盘上、风铃与用户都看不到（实机："动手做了、界面上一个产物都没有"）。
   * 它自己列了就用它的；没列就按实际写盘补录（只补看起来是成品的，临时文件不算）。
   */
  const deliverablesOut = (listed: string[]): string[] =>
    listed.length
      ? listed
      : writtenFiles.filter((f) => !/\.(tmp|bak|log|lock)$/i.test(f)).slice(0, 8);

  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let finalReport: string | null = null;
  let finalEvidence: string[] = [];
  let finalDeliverables: string[] = [];
  /**
   * 中途发言的硬闸（2026-11-16）：每单 8 条、每轮 1 条、同句不重复。
   * 这些数字不是审美，是"终止条件"——AutoGen 的群聊教训：没有上限的对话会一直说到预算烧完。
   */
  let postedCount = 0;
  let lastPostTurn = -1;
  const postedKeys = new Set<string>();

  const execTool = async (name: string, rawArgs: string): Promise<string> => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    } catch {
      return `工具参数不是合法 JSON：${rawArgs.slice(0, 200)}`;
    }
    /**
     * 工具二级加载（2026-11-17 P4-2）：搜到的长尾工具从**下一轮**起可调。
     *
     * 为什么不让它直接执行：模型还没看到参数 schema，硬调只会传错参。
     * 为什么要有次数上限：每解锁一次工具面就变一次，等于一个前缀断点；
     * 反复搜会把缓存收益吃光，也会让成员陷入"搜工具"而不是"干活"。
     */
    if (name === "tool_search") {
      if (!surface.lazy) {
        return "本次工具面很小，已经全部发给你了，不需要搜——直接用现有工具。（搜了也只是白花一轮）";
      }
      if (searchCount >= SEARCH_MAX) {
        return `搜索次数到上限（${SEARCH_MAX} 次）。用现有工具继续干；确实缺工具就在回报里写 ESCALATE 说明要什么。`;
      }
      searchCount += 1;
      const query = String(args.query ?? "").trim();
      if (!query) return "query 不能为空：说清你要做什么（如「写 Word 文档」「抓网页」）。";
      const hiddenSchemas = TOOLKIT_SCHEMAS.filter((s) => surface.hidden.includes(s.function.name));
      const hits = searchTools(query, hiddenSchemas);
      if (!hits.length) {
        return (
          `没搜到匹配的工具（还有 ${surface.hidden.length} 件没加载：${surface.hidden.join("、")}）。` +
          "换种说法再说一次，或用现有工具干、在回报里说明缺什么。"
        );
      }
      for (const h of hits) unlocked.add(h.name);
      surface = memberSurface(input.tools, unlocked, true);
      tools = memberToolSchemas(surface.names, { lazy: true });
      return (
        `已加载 ${hits.map((h) => `${h.name}（${h.why}）`).join("、")}。**下一轮起可以直接调用**；` +
        `还没加载的：${surface.hidden.join("、") || "（无）"}。`
      );
    }
    /**
     * 群内中途发言（2026-11-16）：不碰文件、不算执行工具，是一次"说话"。
     * 落卡 / 路由叫醒 / 同单疑问合并都交给内核的 onMessage；这里只管形状与频率闸。
     */
    if (name === "post_message") {
      const kind = String(args.kind ?? "").trim() as MemberPostKind;
      if (!(MEMBER_POST_KINDS as readonly string[]).includes(kind)) {
        return `kind 只能是 ${MEMBER_POST_KINDS.join(" / ")}（收到：${kind || "空"}）。`;
      }
      const text = String(args.text ?? "").trim().replace(/\n{3,}/g, "\n\n");
      if (!text) return "发言正文不能为空：一句话说清结论 / 状态 / 问题。";
      if (text.length > POST_MAX_CHARS) {
        return `太长（${text.length} 字）：群里的发言压到 ${POST_MAX_CHARS} 字内，细节留给回报与交付物。`;
      }
      if (postedCount >= POST_MAX_PER_TASK) {
        return `这一单已经发过 ${POST_MAX_PER_TASK} 条中途发言了：别再刷屏，把剩下的进展与结论写进 submit_report。`;
      }
      if (lastPostTurn === turns) return "同一轮只说一句：把要说的话合成一条再发（另一条留到下一轮）。";
      // 去重只看正文（同一句话换个 kind 重发也是刷屏）
      if (postedKeys.has(text)) return "这句刚刚说过了，不重复发。";
      postedKeys.add(text);
      postedCount += 1;
      lastPostTurn = turns;
      const receipt = input.onMessage?.({ kind, text, needAnswer: args.needAnswer === true });
      return receipt?.trim() || "已记录。";
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
      // 2026-11-11：证据改为可选——普通任务不再因为没交文件被挡在回报门外；
      // 关键任务的强制点在任务层 evidencePolicy（无证据不进审查），不在这里重复卡一次。
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
      /**
       * 骨架稿拦截（2026-11-14）：实机出现过"四行标题 + TODO"的稿子被当成交付。
       * 只在**没有交付物**时判——文档里正常讨论 TODO（写技术文档）不算；
       * 交不出东西又要说"完成"，才该被挡回去补。
       */
      if (PLACEHOLDER.test(text) && deliverables.length === 0) {
        return (
          "这看起来还是骨架稿：正文里有占位符（TODO / 待补充 / 占位），而且没有交付物。" +
          "把内容补全、产出落盘后再交；确实做不完就标【受阻】写清卡在哪，别拿占位稿当完成。"
        );
      }
      // 核对清单的形状校验（2026-11-14）：不合规整条拒，让它按格式重报，而不是收一份乱表
      // 核对清单（2026-11-14）：把「完成标准逐条过了吗」变成结构化的表，风铃验收先看这张表，
      // 而不是从一段自然语言里猜。形状固定且极简（name/pass/evidence），所以手写校验——
      // 为此引入 schema 库不值当；不合规整条拒收，让它按格式重报一次。
      const rawChecks = Array.isArray(args.checks) ? args.checks : [];
      if (rawChecks.length > 20) return "核对清单最多 20 条，只留关键的。";
      const checks: { name: string; pass: boolean; evidence?: string }[] = [];
      for (const [i, c] of rawChecks.entries()) {
        if (typeof c !== "object" || c === null || Array.isArray(c)) {
          return `checks[${i}] 必须是对象 {name, pass, evidence?}。`;
        }
        const row = c as Record<string, unknown>;
        const cname = String(row.name ?? "").trim();
        const pass = row.pass;
        const ev = String(row.evidence ?? "").trim();
        if (!cname) return `checks[${i}] 缺 name（写清对的是哪条完成标准）。`;
        if (typeof pass !== "boolean") return `checks[${i}].pass 必须是 true 或 false。`;
        checks.push({ name: cname, pass, ...(ev ? { evidence: ev } : {}) });
      }
      finalReport = checks.length
        ? `${text}\n\n核对清单：\n${checks
            .map((c) => `- ${c.pass ? "[过]" : "[未过]"} ${c.name}${c.evidence ? `（${c.evidence}）` : ""}`)
            .join("\n")}`
        : text;
      finalEvidence = evidence;
      finalDeliverables = deliverables;
      return "回报已收下，本轮执行结束。";
    }
    if (!(MEMBER_EXEC_TOOLS as readonly string[]).includes(name)) {
      // 只说"没有这个工具"会让它接着猜下一个名字（实测出现 read_dir 这种凭印象拼的名字）。
      // 把这次真实可用的名字摆出来，一轮就能改对。
      const mine = input.tools.filter((t) => (MEMBER_EXEC_TOOLS as readonly string[]).includes(t));
      return `未知工具：${name}。本次可用的是：${[...mine, "post_message", "submit_report"].join("、")}（post_message 是群内发言，submit_report 是回报）。`;
    }
    if (!input.tools.includes(name)) {
      return `工具 ${name} 不在本次分配清单里（本次只有：${input.tools.join("、")}）。需要的话在回报里写 ESCALATE 说明原因。`;
    }
    try {
      // 先报"开始"：一条命令跑 100s 时，只在返回后打点会让界面完全静止（实机被当成卡死）
      const head =
        name === "run_command"
          ? String(args.command ?? "")
          : name.startsWith("browser_")
            ? String(args.url ?? args.target ?? args.selector ?? "")
            : String(args.path ?? args.name ?? "");
      input.onEvent?.({ kind: "tool-start", text: `${name}${head ? "：" + head.slice(0, 400) : ""}` });
      /**
       * 长命令期间让进度条也动（2026-11-19 修 C7）。
       *
       * 问题：progress 只在每轮 `turn` 事件里更新（turns/maxTurns），一条跑 100s 的命令
       * 期间进度条完全不动，用户看到"卡住"（实机把在跑看成卡死的经典形态）。
       * 修法：命令执行期间每 2s 推一次**时间插值**进度——从本轮基准往上爬，最多到
       * "下一轮之前"，命令结束立刻停。这样进度条一直在动，也不会越过下一轮的真实值。
       */
      const out = await (async () => {
        const base = Math.min(95, Math.round((turns / Math.max(1, maxTurns)) * 100));
        const step = Math.max(1, Math.round(95 / Math.max(1, maxTurns)));
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const frac = Math.min(0.95, (Date.now() - startedAt) / 120_000); // 以命令超时 120s 作预期上限
          const p = Math.min(base + step - 1, Math.round(base + step * frac));
          input.onEvent?.({ kind: "turn", text: `第 ${turns} / ${maxTurns} 轮（${name} 执行中）`, progress: p });
        }, 2_000);
        (timer as { unref?: () => void }).unref?.();
        try {
          return await toolkit.execute(name, args);
        } finally {
          clearInterval(timer);
        }
      })();
      if (name === "write_file" || name === "edit_file") {
        const ch = toolkit.changes().at(-1);
        const rel = String(args.path ?? "");
        if (rel && !writtenFiles.includes(rel)) writtenFiles.push(rel);
        input.onEvent?.({
          kind: "tool",
          text: (name === "write_file" ? "写入 " : "修改 ") + rel + (ch ? "（+" + ch.added + "/-" + ch.removed + "）" : ""),
        });
      } else if (name === "run_command") {
        // 写全命令（截 500）：只给 120 字时界面上全是"执行：powershell -NoProfile -Command "try {…"，
        // 用户根本看不出它在干什么
        input.onEvent?.({ kind: "tool", text: "执行：" + String(args.command).slice(0, 500) });
      } else {
        input.onEvent?.({ kind: "tool", text: `${name}${head ? "：" + head.slice(0, 200) : ""}` });
      }
      return clipToolOutput(out);
    } catch (err) {
      return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  try {
    /**
     * 预算收尾语义修正（2026-11-19 修 P1 C5）：
     * 旧实现：预算到额设 budgetStop=true，而 while 条件含 `!budgetStop` → 立刻退出，
     * 那句"别再调工具、立刻 submit_report"的收尾指令根本没被处理，直接把成果判成 turn_limit 丢掉。
     * 现在：budgetClosing 表示"本轮已进入收尾（已下达交回报指令）"，本轮照常跑（模型据此交回报），
     * 跑完若仍没交回报才判停。这样"预算到额给一轮收口机会"才真正成立。
     */
    while (finalReport === null && turns < maxTurns && !budgetStop && !input.signal?.aborted) {
      // token 预算闸：到额就进入最后一轮收尾（下达交回报指令，本轮照跑）
      if (tokenBudget > 0 && promptTokens + completionTokens >= tokenBudget && !budgetClosing) {
        budgetClosing = true;
        messages.push({
          role: "user",
          content:
            `本单 token 预算已用尽（已用约 ${Math.round((promptTokens + completionTokens) / 1000)}K / ` +
            `${Math.round(tokenBudget / 1000)}K）。**不要再调用任何工具**，立刻用 submit_report 交回当前已确认的结论；` +
            "未完成也要交——写清做到哪一步、拿到什么、还差什么。",
        });
        input.onEvent?.({ kind: "note", text: "token 预算用尽：要求立刻交回报" });
      }
      /**
       * 分代折叠（2026-11-17 缓存修复 B2）。
       *
       * 此前每轮都折：折叠 = 改写历史 = **每轮一个缓存断点**，省下的重放又按全价付回去，
       * 成员命中率被压到 81.5%。现在只在「未折叠结果 ≥ 12 条」时折一次（约每 6 轮），
       * 两次折叠之间前缀完全稳定；折叠后清掉已读记忆，想重看仍能拿到全文。
       */
      const comp =
        countUnfoldedTools(messages) >= compactThreshold()
          ? compactToolHistory(messages, { keepRecent: compactKeepRecent() })
          : { messages, folded: 0, savedChars: 0 };
      if (comp.folded > 0) {
        messages.splice(0, messages.length, ...comp.messages);
        toolkit.forgetReads();
        if (!foldedNoticed) {
          foldedNoticed = true;
          input.onEvent?.({
            kind: "note",
            text: `早期工具结果已折叠 ${comp.folded} 条（省约 ${Math.round(comp.savedChars / 1000)}K 字符），需要重看会重新给出全文`,
          });
        }
      }
      // 先看收件箱：风铃在跑的中途补的指示，这一轮就能进上下文（不用杀掉重跑、不丢已写文件）
      while (input.inbox && input.inbox.length > 0) {
        const note = input.inbox.shift();
        if (!note) break;
        messages.push({ role: "user", content: `【风铃补充指示】${note}` });
        input.onEvent?.({ kind: "note", text: `收到补充指示：${note.slice(0, 120)}` });
      }
      // 只读授权变化（用户中途批准）→ 只补这一句，不重排系统提示词
      const rootsNext = rootsNow();
      const addedRoots = rootsNext.filter((r) => !knownRoots.includes(r));
      if (addedRoots.length) {
        knownRoots = rootsNext.slice();
        messages.push({
          role: "user",
          content: `【授权更新】新批准可读的目录：${addedRoots.join("、")}。现在可以用绝对路径读它们了；写入仍然只能在 ${input.workdir}。`,
        });
        input.onEvent?.({ kind: "note", text: `授权更新：可读 ${addedRoots.join("、")}` });
      }
      input.onEvent?.({
        kind: "turn",
        text: `第 ${turns + 1} / ${maxTurns} 轮`,
        progress: Math.min(95, Math.round((turns / maxTurns) * 100)),
      });
      turns += 1;
      const lastTurn = maxTurns - turns <= 0;
      /**
       * 早写提醒（2026-11-16 实机根因）：成员的失败模式不是"做不出结论"，而是
       * **先核实、后写**——35 个任务、1451 次工具调用里只有 19 次写文件，
       * 结果轮次/时间耗尽时一个文件都没有，前面所有阅读全部作废。
       * 第 3 轮还没落盘就明确要求先交一版（覆盖写不算错，正文可以边读边补）。
       */
      if (
        finalReport === null &&
        !nudgedWrite &&
        turns >= 3 &&
        writtenFiles.length === 0 &&
        input.tools.includes("write_file")
      ) {
        nudgedWrite = true;
        messages.push({
          role: "user",
          content:
            "你已经跑了 3 轮、还没写出任何文件。这一单要的是**产物**，不是读完所有材料：现在就把已确认的部分写进目标文件" +
            "（write_file 会覆盖同一路径，先写骨架 + 已确定的条目完全可以），之后再边读边补。\n" +
            "宁可先交一版再改，也不要攒到最后一次性写——轮次或时间一到，没落盘的内容等于没做。",
        });
        input.onEvent?.({ kind: "note", text: "提醒：3 轮还没落盘，要求先写一版" });
      }
      /**
       * 时间预算提醒（2026-11-16）：轮次之外的另一条硬约束。日志里"45 分钟用尽、三个分片一个都没落盘"
       * 就是全程在核实、没人提醒它时间到了。50% 催"先写一版"，75% 催"停掉新核实、收尾提交"。
       */
      if (finalReport === null && budgetMs > 0) {
        const usedMs = Date.now() - runStartedAt;
        const usedPct = usedMs / budgetMs;
        const leftMin = Math.max(1, Math.round((budgetMs - usedMs) / 60_000));
        if (usedPct >= 0.75 && !nudgedLateTime) {
          nudgedLateTime = true;
          messages.push({
            role: "user",
            content:
              `时间只剩约 ${leftMin} 分钟：**停掉新的核实面**，把已经确认的内容写进文件并 submit_report。` +
              "没写完的段落标注「待补」——交一版有缺口的成品，比一个字都没落盘强。",
          });
          input.onEvent?.({ kind: "note", text: `时间提醒：还剩约 ${leftMin} 分钟，要求收尾落盘` });
        } else if (usedPct >= 0.5 && !nudgedHalfTime) {
          nudgedHalfTime = true;
          messages.push({
            role: "user",
            content:
              `时间已用一半（约剩 ${leftMin} 分钟）：先把已确认的部分写成文件，再继续核实剩下的。` +
              "不要等到最后一次性写——那时候通常已经没时间了。",
          });
          input.onEvent?.({ kind: "note", text: "时间提醒：已过半，要求先落盘一版" });
        }
      }
      // 逼近上限就强制收口：不给"再探一轮"的机会，否则轮次烧完一张回报都没有
      if (finalReport === null && !lastTurn && maxTurns - turns <= 2) {
        messages.push({
          role: "user",
          content:
            "只剩 2 轮了：立刻用 submit_report 交回当前结论。未完成也要交——写清做到哪一步、拿到的证据、卡在哪、需要什么。" +
            "不要再调用其它工具，不要再探索。",
        });
      }
      // 最后一轮：工具面收口改由提示词执行（不再改 tools 集合——那会让整段前缀缓存作废）
      if (finalReport === null && lastTurn) {
        messages.push({
          role: "user",
          content:
            "这是最后一轮：**不要再用任何工具**，直接 submit_report 交回当前结论。" +
            "未完成也要交——写清做到哪一步、拿到什么、卡在哪、需要什么。",
        });
      }
      let result: Awaited<ReturnType<typeof chat>>;
      try {
        result = await chat({
          baseUrl: input.model.baseUrl,
          apiKey: input.model.apiKey,
          model: input.model.model,
          messages,
          /**
           * 工具定义**整段保持不变**（2026-11-16 缓存修复）：
           * 此前最后一轮把 tools 收窄成只剩 submit_report，工具段在请求最前面，
           * 一变就等于把整段前缀缓存作废——每单最后一轮必然全量重算，命中率被系统性拉低。
           * 收口改由「只剩 N 轮」的提示词强约束（下面），语义一样，缓存不再断。
           */
          tools,
          onDelta: () => {},
          signal: input.signal,
        });
      } catch (err) {
        // 用户停 / 群终止：立刻收口，不重试
        if (input.signal?.aborted) throw err;
        // 额度用尽（套餐上限/欠费）不是"这一轮运气不好"：重跑没有意义，如实结束整单
        if (isQuotaError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        modelFailures += 1;
        if (modelFailures > 2) throw err;
        /**
         * 续跑而不是报废（2026-11-16 日志复盘：单轮 120s 硬超时把已经读了 20 轮的单砍断，
         * 重派后从零再来，一张单跑了 6 次）。这里保留 messages 与已写文件，只补一句交代：
         * 不要重复已做过的读取，接着做；再失败就直接交当前结论。
         */
        messages.push({
          role: "user",
          content:
            `上一轮模型请求失败：${msg.slice(0, 300)}。这是第 ${modelFailures} 次失败。` +
            "不要重复已经做过的读取与命令，接着往下做；如果再失败，直接用 submit_report 交回当前已确认的结论" +
            "（未完成也要交，写清做到哪一步、卡在哪）。",
        });
        input.onEvent?.({ kind: "note", text: `模型请求失败，本单续跑（第 ${modelFailures} 次）：${msg.slice(0, 80)}` });
        continue;
      }
      modelFailures = 0;
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      cacheReadTokens += result.cacheRead ?? 0;
      cacheWriteTokens += result.cacheWrite ?? 0;
      if (result.toolCalls.length === 0) {
        if (lastTurn && result.content.trim()) {
          // 最后一轮它选择了口述：这段就是它的回报，别丢（丢了等于这一单白跑）
          finalReport = result.content.trim();
          break;
        }
        /**
         * 预算收尾轮仍只说话不交回报（2026-11-19 C5）：不再喂回继续（那样会拿预算外轮次空转），
         * 直接把这段口述当回报收下——总比丢成 turn_limit 强。没有内容就判停。
         */
        if (budgetClosing) {
          if (result.content.trim()) {
            finalReport = result.content.trim();
            break;
          }
          budgetStop = true;
          break;
        }
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
        const startedAt = Date.now();
        const outcome = await execTool(tc.name, tc.arguments);
        if (input.onToolCall) {
          const text = String(outcome ?? "");
          /**
           * 工具结果的成功/失败判定（2026-11-19 修 C6）。
           *
           * 现实约束：工具返回的是**字符串**，没有结构化 ok 字段，只能看开头。
           * 之前的名单漏了真实存在的失败前缀（命令超时 / 命令执行失败 / 命令已被停止 /
           * 用户拒绝），这些会被误记成"成功"，而巡检的"撞墙"判断依赖这个计数。
           * 这里把 toolkit / member-runner 里真实会出现的失败开头全列上（含 English 兜底）。
           *
           * 已知局限（诚实）：内容恰好以"失败"开头的**正常产出**会被误判失败。
           * 要彻底解决得让工具返回 `{ok, text}` 结构化结果，属后续重构。
           */
          const ok = !/^(?:已拒绝|用户拒绝|失败|错误|工具执行失败|工具超时|路径越界|未知工具|命令超时|命令执行失败|命令已被用户停止|命令已被用户终止|无法|不存在)/.test(
            text.trim(),
          );
          try {
            input.onToolCall({
              name: tc.name,
              args: String(tc.arguments ?? ""),
              outcome: text,
              ok,
              ms: Date.now() - startedAt,
            });
          } catch {
            /* 审计失败不能影响执行 */
          }
        }
        if (finalReport !== null) {
          return {
            status: "reported",
            report: finalReport,
            evidence: finalEvidence,
            deliverables: deliverablesOut(finalDeliverables),
            turns,
            promptTokens,
            completionTokens,
            cacheReadTokens,
            cacheWriteTokens,
            producedFiles: writtenFiles.slice(),
          };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: outcome });
      }
      /**
       * 预算收尾兜底（2026-11-19 C5）：已进入 budgetClosing 本轮仍未交回报 →
       * 不再给它下一轮（否则喂回循环会拿预算外的轮次空转）。置 budgetStop 让 while 退出，
       * 由下面 turn_limit 分支收尾（该分支已保留 writtenFiles 兜底作品）。
       */
      if (budgetClosing && finalReport === null) {
        budgetStop = true;
      }
    }
    if (finalReport !== null) {
      // 最后一轮口述收口（没走 submit_report）：照样算交回，证据/交付物为空
      return {
        status: "reported",
        report: finalReport,
        evidence: finalEvidence,
        deliverables: deliverablesOut(finalDeliverables),
        turns,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
        producedFiles: writtenFiles.slice(),
      };
    }
    if (input.signal?.aborted) {
      return {
        status: "aborted",
        report: "已被停止（用户中止）。已写出的文件留在工作区，未提交汇报。",
        evidence: [],
        deliverables: deliverablesOut([]),
        turns,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
        producedFiles: writtenFiles.slice(),
      };
    }
    return {
      status: "turn_limit",
      report: budgetStop
        ? `成员的 token 预算（${Math.round(tokenBudget / 1000)}K）用尽前没有提交回报。最后动作见卷宗。`
        : `成员在 ${maxTurns} 个工具轮次内没有提交回报（可能任务过大或卡住）。最后动作见卷宗。`,
      evidence: [],
      deliverables: [],
      turns,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      producedFiles: writtenFiles.slice(),
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
      cacheReadTokens,
      cacheWriteTokens,
      producedFiles: writtenFiles.slice(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
