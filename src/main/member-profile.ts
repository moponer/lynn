// 成员档案规范与校验（2026-11-11）：档案 = 岗位说明书，不是工单。
//
// 背景：实机 31 份档案几乎全部把具体任务写进了 name/role/goal/deliverable/body
// （F:\spiker\...、shutdown.rs、%TEMP%\hermix-eval、阶段2、2 次调用内、G:\实习相关文件），
// 且内核把 `目标：${goal}` 原样复写进 body。成员名同时是文件名、派单匹配键、战绩主键
// 与模板匹配词袋，带任务词就等于每次换人，经验沉淀永远归零，档案也无法跨任务复用。
//
// 分界线：档案写「他能对哪类结果负责、怎么做事」；本次具体做什么、看哪些文件、
// 交什么名字的产物、何时截止，一律进 assign_task 的四段简报。
import type { MemberProfile } from "./team-store";

/** 给模型、给用户、给退回说明共用的同一份原则（不要各处复述出不同版本）。 */
export const MEMBER_PROFILE_RULES = `成员档案 = 岗位说明书，不是工单；写完要能原样用到下一件完全不同的任务上。
只写五类内容：① 能力域（擅长哪类活）② 做事风格/方法论（怎么取证、怎么自检）③ 稳定边界（永远不做什么）④ 通用产出形态（报告/清单/表格的类型，不写文件名）⑤ 升级条件（能力或权限层面）。
严禁写：具体路径/文件名/URL、项目或仓库名、任务/工单/会话 ID、阶段号与轮次、具体数字目标与计数、截止时间、本次验收标准。
名字用通用岗位名（如「代码审查员」「资料盘点员」），不要带任务对象、阶段、编号或 A/B/C 后缀——名字是战绩主键，带任务词就等于每次换人。
具体任务信息一律放进 assign_task 的四段简报【目标】【完成标准】【材料与位置】【限制】。`;

/** 内核生成的档案正文：只讲做事风格，不复写本次目标。 */
export const MEMBER_WORK_STYLE_BODY =
  "按岗位能力域接活：先核对材料与工作区，缺材料立刻回报，不靠猜测补齐；做事留原始证据，结论只写能复核的部分；" +
  "交回报前自审三问——完成标准逐条过、证据真实存在、未验证处已标注。不确定的写不确定，不把没做的说成做完。";

export interface MemberProfileExample {
  name: string;
  role: string;
  goal: string;
  boundaries: string[];
  deliverable: string;
  evidence: string[];
  acceptance: string[];
  escalateWhen: string;
  body: string;
}

/** 合规示例：新招募照这个颗粒度写。同时是校验器的回归夹具。 */
export const EXAMPLE_MEMBER_PROFILES: readonly MemberProfileExample[] = [
  {
    name: "代码审查员",
    role: "源码审查工程师（架构/正确性/性能/安全，只读）",
    goal: "对任意给定代码范围给出可复核的问题清单与改进建议，不改源码",
    boundaries: ["只读，不改任何文件", "每条结论带位置与原文依据，未验证处标注无法确认"],
    deliverable: "一份结构化审查报告：问题清单、证据定位、误报排除说明、优先级建议",
    evidence: ["原文片段与位置", "核对或测试记录"],
    acceptance: ["每条结论都有可复核证据", "未完成项与无法确认项如实列出"],
    escalateWhen: "材料缺失、需要越权访问、或范围无法确认时",
    body:
      "先确认材料范围再动手，逐条核对证据；区分事实与推测，不确定就写不确定；" +
      "交付前自审三问：完成标准逐条过、证据真实存在、未验证处已标注。",
  },
  {
    name: "资料盘点员",
    role: "文件清点与内容提取专员",
    goal: "把任意给定目录的材料盘点成结构化清单与摘要，供指挥者判断下一步",
    boundaries: ["只读，不改动原始材料", "读不到的内容如实标注，不用推测补齐"],
    deliverable: "一份结构化清单（路径/类型/大小）+ 内容摘要 + 信息缺口列表",
    evidence: ["清单与摘要原文", "读取工具的原始返回"],
    acceptance: ["清单条目与目录实际内容一致", "信息缺口单独列出且不臆测"],
    escalateWhen: "目录不可读、需要额外授权、或材料格式无法解析时",
    body:
      "先看目录结构再逐份提取，保持原始顺序与名称；摘要只写材料里真实出现的内容；" +
      "遇到打不开或不认识的格式如实记录，不跳过也不编造。",
  },
  {
    name: "文稿撰写员",
    role: "结构化文档撰写与润色专员",
    goal: "把给定材料整理成结构清晰、可核对的书面产物",
    boundaries: ["不改动输入材料", "不虚构数据、引文与出处", "只在指定工作区落盘"],
    deliverable: "一份结构化文档：结论、依据、未完成项与待确认问题",
    evidence: ["写入回执", "读回核对的原文"],
    acceptance: ["结构与约定一致", "所有数字与引用都能回到材料"],
    escalateWhen: "材料自相矛盾、口径未定、或缺少必要输入时",
    body:
      "先列提纲再写正文；写完必须读回核对，逐项对照材料；" +
      "口径不清就停下来回报，不自行选一种解释继续写。",
  },
];

export interface MemberProfileIssue {
  field: string;
  rule: string;
  snippet: string;
}

type FieldKey =
  | "name"
  | "role"
  | "goal"
  | "boundaries"
  | "deliverable"
  | "evidence"
  | "acceptance"
  | "escalateWhen"
  | "body";

interface LeakRule {
  rule: string;
  re: RegExp;
  fields: readonly FieldKey[];
}

const ALL: readonly FieldKey[] = [
  "name", "role", "goal", "boundaries", "deliverable", "evidence", "acceptance", "escalateWhen", "body",
];

/**
 * 任务信息特征。刻意只抓「一眼就是本次任务」的硬信号，
 * 不抓「报告/清单/证据/材料」这类岗位词，避免把正常岗位说明书误杀。
 */
const LEAK_RULES: readonly LeakRule[] = [
  {
    rule: "具体路径/盘符/环境变量目录",
    re: /(?:[A-Za-z]:[\\/]|\\\\|%[A-Za-z_]+%|~\/|\/(?:home|Users|tmp)\/|tasks[\\/]<taskId>|tasks[\\/][a-z0-9-]+[\\/])/i,
    fields: ALL,
  },
  {
    rule: "具体文件名或扩展名",
    re: /\b[A-Za-z0-9_.-]+\.(?:rs|ts|tsx|js|mjs|cjs|json|md|csv|xlsx|xls|docx|pdf|py|toml|yaml|yml|log|txt|html|css|sh|ps1|conf)\b/i,
    fields: ALL,
  },
  {
    rule: "任务/工单/会话 ID 或校验码",
    re: /\b(?:task|team|th|session|plan)-[a-z0-9-]{4,}\b|\bHERMIX[- ]?\d+\b|校验码/i,
    fields: ALL,
  },
  {
    rule: "阶段号/轮次/本次调用配额",
    re: /阶段\s*\d|第\s*\d+\s*[轮步版]|\d+\s*次(?:调用|工具|命令)|最多\s*\d+\s*次|仅\s*\d+\s*次|\d+\s*个工具轮次/i,
    fields: ALL,
  },
  {
    rule: "本次任务限定词/截止时间",
    re: /本次|这次|本轮|上一单|当前任务|截止(?:时间)?|具体时间|deadline/i,
    fields: ALL,
  },
  {
    rule: "具体计数目标/本次验收读数",
    re: /文件数|依赖总数|准确总数|报出总数|可验证\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+\s*项/i,
    fields: ALL,
  },
  {
    rule: "把本次目标复写进档案正文",
    re: /岗位由风铃在任务中招募|目标：/,
    fields: ["body"],
  },
  {
    rule: "任务马甲式名字（编号/字母后缀/阶段名）",
    re: /(?:[0-9]+$|[A-Za-z]$|[（(]?第\s*\d+\s*[轮版][）)]?$|阶段\s*\d)/,
    fields: ["name"],
  },
];

function fieldsOf(p: MemberProfile): { key: FieldKey; value: string }[] {
  return [
    { key: "name", value: p.name },
    { key: "role", value: p.role },
    { key: "goal", value: p.goal },
    { key: "boundaries", value: p.boundaries.join("\n") },
    { key: "deliverable", value: p.outputContract.deliverable },
    { key: "evidence", value: p.outputContract.evidence.join("\n") },
    { key: "acceptance", value: p.outputContract.acceptance.join("\n") },
    { key: "escalateWhen", value: p.escalateWhen },
    { key: "body", value: p.body },
  ];
}

/**
 * 纯函数：返回全部违规项；空数组 = 合规。
 * `skipName` 只给历史档案清洗用：名字同时是战绩主键，改名会断链，清洗时保留但如实报告。
 * 新增成员必须走默认（检名字）。
 */
export function validateMemberProfile(p: MemberProfile, opts?: { skipName?: boolean }): MemberProfileIssue[] {
  const issues: MemberProfileIssue[] = [];
  for (const field of fieldsOf(p)) {
    if (opts?.skipName && field.key === "name") continue;
    const text = String(field.value ?? "");
    if (!text.trim()) continue;
    for (const r of LEAK_RULES) {
      if (!r.fields.includes(field.key)) continue;
      r.re.lastIndex = 0;
      const m = r.re.exec(text);
      if (!m) continue;
      const at = Math.max(0, m.index - 18);
      issues.push({
        field: field.key,
        rule: r.rule,
        snippet: text.slice(at, Math.min(text.length, m.index + m[0].length + 22)).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return issues;
}

/** 退回说明：点名违规字段 + 给可照抄的合规示例，让风铃一轮就能改对。 */
export function memberProfileRejection(issues: readonly MemberProfileIssue[]): string {
  const ex = EXAMPLE_MEMBER_PROFILES[0];
  const lines = issues
    .slice(0, 8)
    .map((i) => `- ${i.field}：${i.rule} → 「${i.snippet}」`)
    .join("\n");
  return (
    `成员档案不合格，已退回，没有招募。档案是岗位说明书，不能混入本次任务信息。\n` +
    `${MEMBER_PROFILE_RULES}\n\n命中：\n${lines}\n\n` +
    `照这个颗粒度重写（示例）：\n` +
    `name: ${ex.name}\nrole: ${ex.role}\ngoal: ${ex.goal}\n` +
    `boundaries: ${ex.boundaries.join(" / ")}\n` +
    `deliverable: ${ex.deliverable}\nacceptance: ${ex.acceptance.join(" / ")}\n` +
    `escalateWhen: ${ex.escalateWhen}\nbody: ${ex.body}\n\n` +
    `本次要看哪个目录、哪个文件、交什么名字的产物、什么时候交，全部写进 assign_task 简报。`
  );
}
