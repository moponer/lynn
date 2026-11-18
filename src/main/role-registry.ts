/**
 * 角色注册表 + 第一道闸（G1 准入，2026-11-17 P3-1 / 07 章）。
 *
 * 事故根源：`create_member.role` 一直是**自由文本**。风铃会写「资深全栈兼文档专家」
 * 这类混合岗位——它匹配不到任何成熟模板，于是退化成一段通用混合提示：
 * 该岗位既没有专门的做事纪律，也没法按角色统计成功率（G4 无从下手）。
 *
 * 这里做三件事，顺序就是闸门的顺序：
 *  1. **注册表**：11 个成员角色（+ 风铃自己）各自的能力域、模板出处、选择指引；
 *  2. **混合检测**：一眼能看出「一个人干两份活」的直接拒，并把最贴近的角色推回去；
 *  3. **解析**：声明了 roleId 就用它；没声明但自由文本能读出来就推断（记 confidence）；
 *     都读不出来才 fallback 到 implementer，并打 `promptFallback` 标记供界面提示。
 *
 * 为什么要把「推断」也做进来：存量团队的成员档案里只有自由文本 role。
 * 只认枚举等于让老团队全部 fallback；先推断、再 fallback，才能既推进契约又不动存量。
 */

/** 成员角色的能力域（与 07 章 §2 一致） */
export type RoleDomain = "coding" | "office" | "research" | "ops" | "general";

export interface RoleSpec {
  roleId: string;
  /** 中文岗位名（界面与退回说明用） */
  name: string;
  domains: RoleDomain[];
  /** 一句话选择指引，会拼进 create_member 的 roleId 描述 */
  desc: string;
  /** 强特征词（权重 3）：出现基本就是这个角色 */
  strong: string[];
  /** 弱特征词（权重 1）：出现的多了才算 */
  weak: string[];
  /** winner 模板的相对路径（相对 prompts/）；自研角色为 null，回落到档案正文 */
  template: string | null;
}

/**
 * 11 个成员角色。**不含 orchestrator**——那是风铃自己，成员永远不该占这个岗位
 * （07 章 §3 的枚举同样只有 11 项，与这里一一对应）。
 */
export const ROLE_REGISTRY: readonly RoleSpec[] = [
  {
    roleId: "implementer",
    name: "开发",
    domains: ["coding"],
    desc: "写代码、改代码、加功能、修 bug、重构；交付物是代码变更或可运行产物",
    strong: ["开发", "编程", "写代码", "代码实现", "后端", "前端", "全栈", "数据工程", "插件工程", "工程师"],
    weak: ["代码", "脚本", "程序", "实现", "重构", "修复", "优化", "调优"],
    template: "adapters/implementer.md",
  },
  {
    roleId: "reviewer-quality",
    name: "质量评审",
    domains: ["coding", "general"],
    desc: "只读评审：找缺陷、测风险、判回归；不改代码，只出问题清单",
    strong: ["质量评审", "质检", "代码审查", "代码审计", "审查员", "评审员"],
    weak: ["审查", "评审", "质量", "缺陷", "风险", "核对"],
    template: "adapters/code-reviewer.md",
  },
  {
    roleId: "reviewer-spec",
    name: "规格评审",
    domains: ["general"],
    desc: "只读评审：判断做出来的东西是否满足最初的需求与验收标准",
    strong: ["规格评审", "需求评审", "方案评审", "对齐检查", "验收把关"],
    weak: ["规格", "需求", "对齐", "符合度", "验收"],
    template: "vendor/superpowers/roles/reviewer-spec.md",
  },
  {
    roleId: "debugger",
    name: "排查",
    domains: ["coding", "ops"],
    desc: "定位根因：从现象往回追到具体那一行/那个配置；不是先改再看",
    strong: ["排查", "调试", "故障定位", "根因", "只读探针", "勘察"],
    weak: ["定位", "debug", "复现", "探针", "诊断"],
    template: "vendor/superpowers/skills/systematic-debugging/SKILL.md",
  },
  {
    roleId: "tester",
    name: "测试",
    domains: ["coding"],
    desc: "写测试、跑测试、判定通过与否；交付物是测试代码或测试结论",
    strong: ["测试工程", "测试用例", "自动化测试", "qa"],
    weak: ["测试", "用例", "验证", "断言", "回归"],
    template: "vendor/superpowers/skills/test-driven-development/SKILL.md",
  },
  {
    roleId: "researcher",
    name: "调研",
    domains: ["research"],
    desc: "找答案：调研、选型、对比、读材料后给结论 + 依据 + 不确定性（不硬凑产物）",
    strong: ["调研", "选型", "研究", "技术选型", "可行性", "竞品"],
    weak: ["分析", "对比", "阅读", "梳理", "探索", "结论"],
    template: "vendor/superpowers/skills/brainstorming/SKILL.md",
  },
  {
    roleId: "writer",
    name: "文档",
    domains: ["office"],
    desc: "写给人看的正文：报告、方案、说明、稿件；要求结构清楚、去 AI 味",
    strong: ["文档撰写", "文稿", "写作", "写稿", "写报告", "文案", "报告撰写", "技术写作", "编辑"],
    weak: ["文档", "撰写", "报告", "正文", "排版", "润色", "校对", "手册", "编写"],
    template: null,
  },
  {
    roleId: "analyst",
    name: "表格",
    domains: ["office"],
    desc: "数据整理与表格：清洗、对账、汇总、清单；交付物是表或数据结论",
    strong: ["数据整理", "数据清洗", "数据分析", "对账", "电子表格", "excel", "盘点", "清点", "图表校对"],
    weak: ["表格", "数据", "整理", "清单", "统计", "汇总", "校对", "提取"],
    template: null,
  },
  {
    roleId: "presenter",
    name: "演示",
    domains: ["office"],
    desc: "做幻灯片与汇报材料：讲清结构、页面能直接给人看",
    strong: ["演示", "幻灯片", "ppt", "汇报材料", "路演"],
    weak: ["演示稿", "版式", "封面", "汇报"],
    template: null,
  },
  {
    roleId: "visual-judge",
    name: "视觉验收",
    domains: ["office"],
    desc: "只看渲染后的页面图：判每页 pass/fail，报素材与版面缺陷；只读不改",
    strong: ["视觉验收", "视觉评审", "页面验收", "排版验收"],
    weak: ["视觉", "版面", "截图评审"],
    template: "adapters/visual-judge.md",
  },
  {
    roleId: "ops",
    name: "运维",
    domains: ["ops"],
    desc: "跑命令与处置环境：部署、巡检、清障；交付物是命令输出或环境状态",
    strong: ["运维", "部署", "服务器", "环境配置", "巡检", "排查"],
    weak: ["命令", "执行", "清理", "迁移", "浏览器", "操作手", "抓取", "爬取"],
    template: "vendor/superpowers/skills/systematic-debugging/SKILL.md",
  },
];

/** 成员可选角色（create_member 的 roleId 枚举） */
export const MEMBER_ROLE_IDS: readonly string[] = ROLE_REGISTRY.map((r) => r.roleId);

/** 没声明也推断不出来时的兜底角色（07 章 §3：不确定就选 implementer 或 researcher） */
export const FALLBACK_ROLE = "implementer";

/** 推断成立的最低分：有一个信号就比没有强；平局（领先不足 1 分）宁可回落也不硬猜 */
const MIN_SCORE = 1;
const MIN_MARGIN = 1;

export function isKnownRoleId(id: unknown): id is string {
  return typeof id === "string" && MEMBER_ROLE_IDS.includes(id);
}

export function roleSpec(roleId: string): RoleSpec | undefined {
  return ROLE_REGISTRY.find((r) => r.roleId === roleId);
}

/** 角色中文名（找不到就原样返回，界面不至于显示空白） */
export function roleName(roleId: string): string {
  return roleSpec(roleId)?.name ?? roleId;
}

/**
 * 混合岗位检测（07 章 §1 要治的就是这个）。
 *
 * 只抓**明确的兼职信号**，不抓「与 / 和」这类连接词——像「文件清点与内容提取专员」
 * 是一个人做一条链路上的两小步，不是两份职业。误杀比漏判更贵：误杀会让风铃反复改档案。
 */
export function isMixedRoleText(text: string): boolean {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  // 「兼」只有在这种搭配里才表示兼职；「兼容 / 兼顾」不算
  if (/(?:兼任|兼做|兼管|兼职|兼修|兼写|兼.{0,4}(?:开发|文档|测试|设计|运维|分析|评审))/.test(s)) return true;
  if (/多面手|全能型|样样都行/.test(s)) return true;
  if (/又.{0,12}又/.test(s)) return true;
  if (/(?:既|一方面|一边).{0,14}(?:又|另一方面|一边)/.test(s)) return true;
  return false;
}

export interface RoleScore {
  roleId: string;
  score: number;
  hits: string[];
}

/** 按特征词打分（强词 3 分、弱词 1 分；英文不分大小写） */
export function scoreRoles(text: string): RoleScore[] {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const out: RoleScore[] = [];
  for (const spec of ROLE_REGISTRY) {
    let score = 0;
    const hits: string[] = [];
    for (const k of spec.strong) {
      if (lower.includes(k.toLowerCase())) {
        score += 3;
        hits.push(k);
      }
    }
    for (const k of spec.weak) {
      if (lower.includes(k.toLowerCase())) {
        score += 1;
        hits.push(k);
      }
    }
    if (score > 0) out.push({ roleId: spec.roleId, score, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId));
}

export type RoleSource = "declared" | "inferred" | "fallback";

export interface RoleResolution {
  roleId: string;
  source: RoleSource;
  /** 0..1；declared 恒为 1，fallback 恒为 0 */
  confidence: number;
  /** 命中混合岗位特征 */
  mixed: boolean;
  /** 混合时的建议角色（最贴近的那个） */
  suggestion?: string;
  /** 参与打分的特征词（诊断用） */
  hits: string[];
}

/**
 * 解析成员角色。顺序：声明值 → 自由文本推断 → 兜底。
 * `mixed=true` 时调用方**必须拒绝招募**（G1），并把 suggestion 写进退回说明。
 */
export function resolveRole(input: { roleId?: string | null; role?: string | null }): RoleResolution {
  const declared = typeof input.roleId === "string" ? input.roleId.trim() : "";
  const text = String(input.role ?? "").trim();
  const mixed = isMixedRoleText(text);
  const scores = scoreRoles(text);
  const top = scores[0];
  const second = scores[1];

  if (isKnownRoleId(declared)) {
    return {
      roleId: declared,
      source: "declared",
      confidence: 1,
      mixed: mixed && !top ? false : mixed,
      suggestion: mixed ? declared : undefined,
      hits: top?.hits ?? [],
    };
  }

  const decisive = top && top.score >= MIN_SCORE && (!second || top.score - second.score >= MIN_MARGIN);
  if (decisive) {
    const confidence = Math.min(1, Math.round((top.score / 6) * 100) / 100);
    return {
      roleId: top.roleId,
      source: "inferred",
      confidence,
      mixed,
      suggestion: mixed ? top.roleId : undefined,
      hits: top.hits,
    };
  }

  return {
    roleId: FALLBACK_ROLE,
    source: "fallback",
    confidence: 0,
    mixed,
    suggestion: mixed ? (top?.roleId ?? FALLBACK_ROLE) : undefined,
    hits: top?.hits ?? [],
  };
}

/** 为一段自由文本推荐角色（混合检测的退回说明、以及界面上的「你想说的是不是…」） */
export function suggestRole(text: string): RoleScore | null {
  return scoreRoles(text)[0] ?? null;
}

/** G1 退回说明：点名「哪两个岗位被捏在一起了」+ 给可照抄的改法 */
export function mixedRoleRejection(text: string, suggestion: string | null): string {
  const hint = suggestion && isKnownRoleId(suggestion) ? suggestion : FALLBACK_ROLE;
  const spec = roleSpec(hint);
  return (
    `岗位写成了混合角色：「${text}」。一个成员只允许一个主角色——混合岗位匹配不到任何成熟模板，` +
    `只会退化成通用提示，也没法按角色统计战绩（07 章 §4 G1）。\n` +
    `最贴近的角色是 \`${hint}\`（${spec?.name ?? hint}：${spec?.desc ?? ""}）。\n` +
    `改法：\`role\` 写一个岗位名（如「代码审查员」），\`roleId\` 填 \`${hint}\`；真正的多角色需求请拆成两名成员。`
  );
}

/**
 * 招募成功后的角色提示（附在 create_member 的返回值里）。
 *
 * fallback 必须**说出来**而不是悄悄发生：07 章 §4 要求 G2 失败时打 `promptFallback`
 * 并在界面标注。悄悄回落等于让风铃以为这个成员拿到了岗位纪律，实际是通用模板。
 */
export function roleGateNote(res: RoleResolution): string {
  if (res.source === "declared") return `\n角色：${res.roleId}（${roleName(res.roleId)}）。`;
  if (res.source === "inferred") {
    return (
      `\n角色：按岗位名推断为 ${res.roleId}（${roleName(res.roleId)}，置信 ${res.confidence}）。` +
      "若不是这个角色，下次招募显式传 roleId。"
    );
  }
  return (
    `\n⚠ 岗位名没匹配到注册表，已回落到 ${res.roleId}（${roleName(res.roleId)}），promptFallback=true——` +
    "这个成员拿到的是通用模板，不是该岗位的专门纪律。下次请显式传 roleId（可选：" +
    MEMBER_ROLE_IDS.join("、") +
    "）。"
  );
}