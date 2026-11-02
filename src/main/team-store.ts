import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 团队存储（§4.10.7）—— 成员 = 书面岗位（Markdown + YAML frontmatter）。
 * 用户可直接打开改；我们只定义 v1 的字段与往返，不做 YAML 通用解析。
 *
 * 目录布局：
 *   <dataRoot>/team/<team-id>/team.json              # 名称/成立时间/状态/预算
 *   <dataRoot>/team/<team-id>/members/<name>.md      # 岗位档案
 *   <dataRoot>/team/<team-id>/assignments/<task>.jsonl  # 派单/回报/打回/验收（追加不可改写）
 *   <dataRoot>/team/<team-id>/artifacts/             # 交付物
 *   <dataRoot>/team/<team-id>/reviews/<task>.json    # 验收结论 + 证据索引
 *   <dataRoot>/team/_templates/                      # 可复用团队模板（不含战绩）
 */

// ---------- 成员档案（§4.10.2 字段，抄三家、只加验收契约） ----------

export interface MemberLimits {
  maxTurns: number;
  budgetTokens: number;
  wallClockMin: number;
}

export interface MemberProfile {
  /** 成员名（唯一，文件名由此生成） */
  name: string;
  role: string;
  /** 单一目标（CrewAI：goal 必须单一，收敛行为） */
  goal: string;
  /** 边界：不许做什么（可执行、可判定） */
  boundaries: string[];
  /** 工具白名单——只能收窄不能扩张（§4.10.3 硬约束） */
  tools: string[];
  /** 成员默认中档模型（§4.10.6 成本对策） */
  model: string;
  limits: MemberLimits;
  outputContract: {
    deliverable: string;
    evidence: string[];
    acceptance: string[];
  };
  /** 何时必须升级问风铃（进而问你） */
  escalateWhen: string;
  /** 正文：这个岗位怎么做事的说明（由风铃写，可迭代） */
  body: string;
}

// ---------- 序列化（手写 YAML 子集：只覆盖本 schema 的形状） ----------

function yamlList(items: string[], indent: string): string {
  return items.map((x) => `${indent}- ${JSON.stringify(x)}`).join("\n");
}

export function serializeMemberProfile(p: MemberProfile): string {
  const fm = [
    `name: ${JSON.stringify(p.name)}`,
    `role: ${JSON.stringify(p.role)}`,
    `goal: ${JSON.stringify(p.goal)}`,
    `boundaries:`,
    yamlList(p.boundaries, "  "),
    `tools: [${p.tools.map((t) => JSON.stringify(t)).join(", ")}]`,
    `model: ${JSON.stringify(p.model)}`,
    `limits: { max_turns: ${p.limits.maxTurns}, budget_tokens: ${p.limits.budgetTokens}, wall_clock_min: ${p.limits.wallClockMin} }`,
    `output_contract:`,
    `  deliverable: ${JSON.stringify(p.outputContract.deliverable)}`,
    `  evidence:`,
    yamlList(p.outputContract.evidence, "    "),
    `  acceptance:`,
    yamlList(p.outputContract.acceptance, "    "),
    `escalate_when: ${JSON.stringify(p.escalateWhen)}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${p.body.trim()}\n`;
}

function parseFlowList(s: string): string[] {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((x) => JSON.parse(x.trim()) as string);
}

/**
 * 解析本工具序列化出的档案（自举往返；不承诺解析任意第三方 YAML）。
 * 成员档案是内核数据，第三方岗位说明只允许填岗位段且不得声明工具权限——
 * 白名单字段在导入时单独走内核强制（§4.9 安全约束），所以这里格式紧一点没关系。
 */
export function parseMemberProfile(md: string): MemberProfile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error("成员档案缺少 frontmatter（--- ... ---）");
  const [, fm, body] = m;
  const lines = fm.split(/\r?\n/);

  const str = (key: string): string => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    if (!line) throw new Error(`成员档案缺少字段: ${key}`);
    return JSON.parse(line.slice(key.length + 1).trim()) as string;
  };
  const dashList = (key: string, indent: number): string[] => {
    const re = new RegExp(`^ {${indent}}- (.*)$`);
    const out: string[] = [];
    let inBlock = false;
    for (const l of lines) {
      if (l.startsWith(`${key}:`)) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (re.test(l)) out.push(JSON.parse(l.trim().slice(2)) as string);
        else if (l.trim() !== "" && !l.startsWith(" ")) break;
        else if (l.trim() !== "" && !re.test(l)) break;
      }
    }
    return out;
  };
  const nestedList = (parent: string, key: string): string[] => {
    const re = new RegExp(`^ {4}- (.*)$`);
    const out: string[] = [];
    let inBlock = false;
    for (const l of lines) {
      if (l.startsWith(`  ${key}:`)) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (re.test(l)) out.push(JSON.parse(l.trim().slice(2)) as string);
        else if (l.trim() !== "") break;
      }
    }
    void parent;
    return out;
  };

  const limitsLine = lines.find((l) => l.startsWith("limits:"));
  if (!limitsLine) throw new Error("成员档案缺少字段: limits");
  const lm = /max_turns: (\d+), budget_tokens: (\d+), wall_clock_min: (\d+)/.exec(limitsLine);
  if (!lm) throw new Error("limits 格式不合法");

  return {
    name: str("name"),
    role: str("role"),
    goal: str("goal"),
    boundaries: dashList("boundaries", 2),
    tools: parseFlowList(lines.find((l) => l.startsWith("tools:"))!.slice(6)),
    model: str("model"),
    limits: {
      maxTurns: parseInt(lm[1], 10),
      budgetTokens: parseInt(lm[2], 10),
      wallClockMin: parseInt(lm[3], 10),
    },
    outputContract: {
      deliverable: str("  deliverable").trim(),
      evidence: nestedList("output_contract", "evidence"),
      acceptance: nestedList("output_contract", "acceptance"),
    },
    escalateWhen: str("escalate_when"),
    body: body.trim(),
  };
}

// ---------- 文件名净化 ----------

export function memberFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`成员名无法生成安全文件名: ${name}`);
  return `${safe}.md`;
}

// ---------- TeamStore ----------

export interface TeamRecord {
  id: string;
  name: string;
  createdAt: string;
  /** 在职 | 暂停 | 已解散 */
  status: "active" | "paused" | "dissolved";
  budgetTokens: number;
}

export interface AssignmentRecord {
  taskId: string;
  at: string;
  kind: "assign" | "report" | "reject" | "accept" | "escalate";
  member?: string;
  text: string;
  /** 证据索引（指向任务卷宗 artifacts/） */
  evidence?: string[];
  /** 打回必须可执行（§4.10.5）：哪里不合格/期望是什么/时限 */
  rejectReason?: { what: string; expect: string; deadline: string };
}

export class TeamStore {
  constructor(readonly dataRoot: string) {}

  teamDir(teamId: string): string {
    return path.join(this.dataRoot, "team", teamId);
  }

  createTeam(id: string, name: string, budgetTokens = 1_000_000): TeamRecord {
    const rec: TeamRecord = {
      id,
      name,
      createdAt: new Date().toISOString(),
      status: "active",
      budgetTokens,
    };
    const dir = this.teamDir(id);
    fs.mkdirSync(path.join(dir, "members"), { recursive: true });
    fs.mkdirSync(path.join(dir, "assignments"), { recursive: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "reviews"), { recursive: true });
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(rec, null, 2));
    return rec;
  }

  writeMember(teamId: string, p: MemberProfile): string {
    const file = path.join(this.teamDir(teamId), "members", memberFileName(p.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeMemberProfile(p), "utf-8");
    return file;
  }

  readMember(teamId: string, name: string): MemberProfile {
    const file = path.join(this.teamDir(teamId), "members", memberFileName(name));
    return parseMemberProfile(fs.readFileSync(file, "utf-8"));
  }

  listMembers(teamId: string): MemberProfile[] {
    const dir = path.join(this.teamDir(teamId), "members");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseMemberProfile(fs.readFileSync(path.join(dir, f), "utf-8")));
  }

  /** 派单/回报/打回/验收记录：追加写，永不改写（§4.10.7） */
  appendAssignment(teamId: string, rec: AssignmentRecord): void {
    const file = path.join(this.teamDir(teamId), "assignments", `${rec.taskId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
  }

  readAssignments(teamId: string, taskId: string): AssignmentRecord[] {
    const file = path.join(this.teamDir(teamId), "assignments", `${taskId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AssignmentRecord);
  }

  /** 打回上限检查：同一 taskId 内第几次打回（§4.10.5 上限 3 轮） */
  rejectCount(teamId: string, taskId: string): number {
    return this.readAssignments(teamId, taskId).filter((r) => r.kind === "reject").length;
  }

  dissolveTeam(teamId: string): void {
    const file = path.join(this.teamDir(teamId), "team.json");
    if (!fs.existsSync(file)) throw new Error(`团队不存在: ${teamId}`);
    const rec = JSON.parse(fs.readFileSync(file, "utf-8")) as TeamRecord;
    rec.status = "dissolved";
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  }
}
