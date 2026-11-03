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

export interface TeamTemplate {
  name: string;
  sourceTeam: string;
  createdAt: string;
  members: MemberProfile[];
}

export interface AssignmentRecord {
  taskId: string;
  at: string;
  kind: "assign" | "report" | "reject" | "accept" | "escalate";
  member?: string;
  text: string;
  /** Pi session 追溯（M0-13 §4.10.7）：这条记录发生时主会话跑在哪个 Pi session 上 */
  sessionId?: string;
  /** 证据索引（指向任务卷宗 artifacts/） */
  evidence?: string[];
  /** 打回必须可执行（§4.10.5）：哪里不合格/期望是什么/时限 */
  rejectReason?: { what: string; expect: string; deadline: string };
}

/** 成员战绩（M2-14）：历次验收结论聚合——资产，不是日志 */
export interface MemberRecord {
  member: string;
  /** 参与过的任务数（去重） */
  tasks: number;
  accepted: number;
  rejected: number;
  escalations: number;
  lastAcceptAt?: string;
}

/** 导入提案（M2-15）：先给用户看 diff，确认才落库 */
export interface ImportProposal {
  name: string;
  members: { name: string; role: string; tools: string[] }[];
  /** 越权工具被剥掉的告警 */
  warnings: string[];
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

  teamExists(teamId: string): boolean {
    return fs.existsSync(path.join(this.teamDir(teamId), "team.json"));
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

  // ---------- 编制模板（M1-08）：解散时保留，下一次同类任务直接复用 ----------

  templatesDir(): string {
    return path.join(this.dataRoot, "team", "_templates");
  }

  /** 把一支队伍的成员档案存成模板（不含战绩/进度，只留可复用的编制） */
  saveTemplate(teamId: string, name?: string): { name: string; file: string; members: number } {
    const teamFile = path.join(this.teamDir(teamId), "team.json");
    if (!fs.existsSync(teamFile)) throw new Error(`团队不存在: ${teamId}`);
    const rec = JSON.parse(fs.readFileSync(teamFile, "utf-8")) as TeamRecord;
    const members = this.listMembers(teamId);
    if (!members.length) throw new Error(`团队 ${teamId} 没有成员，存成模板也没用`);
    const template: TeamTemplate = {
      name: (name?.trim() || rec.name || teamId).slice(0, 40),
      sourceTeam: teamId,
      createdAt: new Date().toISOString(),
      members,
    };
    const file = path.join(this.templatesDir(), `${memberFileName(template.name).replace(/\.md$/, "")}.json`);
    fs.mkdirSync(this.templatesDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(template, null, 2), "utf-8");
    return { name: template.name, file, members: members.length };
  }

  listTemplates(): TeamTemplate[] {
    const dir = this.templatesDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as TeamTemplate;
        } catch {
          return null;
        }
      })
      .filter((t): t is TeamTemplate => Boolean(t?.members?.length))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findTemplate(nameOrId: string): TeamTemplate | null {
    const q = nameOrId.trim();
    if (!q) return null;
    return this.listTemplates().find((t) => t.name === q || t.sourceTeam === q) ?? null;
  }

  /**
   * 按任务标题猜模板：模板名/成员角色/岗位目标里的二字词与标题求交，
   * 取命中最多的一套；命中为 0 就不猜（宁可不复用，也不乱套编制）。
   */
  matchTemplate(text: string): TeamTemplate | null {
    if (!text.trim()) return null;
    let best: { t: TeamTemplate; score: number } | null = null;
    for (const t of this.listTemplates()) {
      const bag = [t.name, ...t.members.map((m) => `${m.name}${m.role}${m.goal}`)].join("");
      let score = 0;
      for (let i = 0; i + 2 <= text.length; i += 1) {
        const pair = text.slice(i, i + 2);
        if (bag.includes(pair)) score += 1;
      }
      if (score > 0 && (!best || score > best.score)) best = { t, score };
    }
    return best && best.score >= 2 ? best.t : null;
  }

  /** 用模板起一支队（成员档案原样写入，不带上一单的进度/战绩） */
  instantiateTemplate(nameOrId: string, teamId: string, teamName?: string): { template: string; members: number } {
    const t = this.findTemplate(nameOrId);
    if (!t) throw new Error(`没有这套编制模板：${nameOrId}（先用 dissolve_team keep=true 存一套）`);
    if (fs.existsSync(path.join(this.teamDir(teamId), "team.json"))) {
      throw new Error(`团队 ${teamId} 已存在，不能再用模板覆盖`);
    }
    this.createTeam(teamId, teamName?.trim() || t.name);
    for (const m of t.members) this.writeMember(teamId, m);
    return { template: t.name, members: t.members.length };
  }

  // ---------- 模板导出/导入（M2-15）：第三方岗位说明不得扩权 ----------

  /** 导出模板到指定文件（用户可分享的 JSON） */
  exportTemplate(nameOrId: string, outFile: string): { ok: boolean; file?: string; error?: string } {
    const t = this.findTemplate(nameOrId);
    if (!t) return { ok: false, error: `没有这套编制模板：${nameOrId}` };
    try {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify({ kind: "lynn-team-template", version: 1, ...t }, null, 2), "utf-8");
      return { ok: true, file: outFile };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 导入第三方岗位说明：**白名单只收窄不扩张**——
   *  - 工具白名单不在内置执行工具集内的项剔除并告警（管理型工具一律剥掉）；
   *  - diff 给用户确认（新增了哪些成员、每个成员留了哪些工具）；
   *  - 确认后才写入 _templates（可 instantiate）。
   */
  importTemplate(jsonText: string, execTools: readonly string[]): { proposal: ImportProposal; commit: () => { name: string; members: number } } {
    let parsed: { kind?: string; name?: string; sourceTeam?: string; members?: MemberProfile[] };
    try {
      parsed = JSON.parse(jsonText) as typeof parsed;
    } catch (err) {
      throw new Error(`不是合法的模板 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.kind && parsed.kind !== "lynn-team-template") {
      throw new Error(`不是风铃团队模板（kind=${parsed.kind}）`);
    }
    const members = (parsed.members ?? []).filter((m) => m && m.name);
    if (!members.length) throw new Error("模板里没有成员（members 为空）");
    if (members.length > 6) throw new Error(`模板编制 ${members.length} 人超过 6 人上限（§4.10.6 组织膨胀防线）`);

    const warnings: string[] = [];
    const stripped = members.map((m) => {
      const kept = (m.tools ?? []).filter((t) => execTools.includes(t));
      const removed = (m.tools ?? []).filter((t) => !execTools.includes(t));
      if (removed.length) warnings.push(`「${m.name}」的越权工具已剥掉：${removed.join("、")}`);
      return { ...m, tools: kept };
    });

    const name = String(parsed.name ?? "导入编制").slice(0, 40);
    const proposal: ImportProposal = {
      name,
      members: stripped.map((m) => ({ name: m.name, role: m.role, tools: m.tools })),
      warnings,
    };
    const commit = (): { name: string; members: number } => {
      const template: TeamTemplate = {
        name,
        sourceTeam: String(parsed.sourceTeam ?? "imported"),
        createdAt: new Date().toISOString(),
        members: stripped,
      };
      fs.mkdirSync(this.templatesDir(), { recursive: true });
      const file = path.join(this.templatesDir(), `${memberFileName(template.name).replace(/\.md$/, "")}.json`);
      fs.writeFileSync(file, JSON.stringify(template, null, 2), "utf-8");
      return { name: template.name, members: stripped.length };
    };
    return { proposal, commit };
  }

  dissolveTeam(teamId: string): void {
    const file = path.join(this.teamDir(teamId), "team.json");
    if (!fs.existsSync(file)) throw new Error(`团队不存在: ${teamId}`);
    const rec = JSON.parse(fs.readFileSync(file, "utf-8")) as TeamRecord;
    rec.status = "dissolved";
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  }

  // ---------- 班底档案资产化（M2-14）：花名册 = 岗位档案 + 历次验收战绩 ----------

  /** 单个成员的战绩：扫 assignments/*.jsonl 汇总（记录追加不可改写，聚合只读） */
  memberRecord(teamId: string, member: string): MemberRecord {
    const dir = path.join(this.teamDir(teamId), "assignments");
    const rec: MemberRecord = { member, tasks: 0, accepted: 0, rejected: 0, escalations: 0 };
    if (!fs.existsSync(dir)) return rec;
    const seen = new Set<string>();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter((x) => x.trim())) {
        let r: AssignmentRecord;
        try {
          r = JSON.parse(line) as AssignmentRecord;
        } catch {
          continue;
        }
        if (r.member !== member) continue;
        seen.add(r.taskId);
        if (r.kind === "accept") rec.accepted += 1;
        else if (r.kind === "reject") rec.rejected += 1;
        else if (r.kind === "escalate") rec.escalations += 1;
        if (r.kind === "accept" && (!rec.lastAcceptAt || r.at > rec.lastAcceptAt)) rec.lastAcceptAt = r.at;
      }
    }
    rec.tasks = seen.size;
    return rec;
  }

  /** 花名册：团队 + 成员档案 + 各自战绩（解散的队伍也保留——档案是资产） */
  roster(teamId: string): { team: TeamRecord; members: { profile: MemberProfile; record: MemberRecord }[] } {
    const file = path.join(this.teamDir(teamId), "team.json");
    if (!fs.existsSync(file)) throw new Error(`团队不存在: ${teamId}`);
    const team = JSON.parse(fs.readFileSync(file, "utf-8")) as TeamRecord;
    const members = this.listMembers(teamId).map((profile) => ({ profile, record: this.memberRecord(teamId, profile.name) }));
    return { team, members };
  }

  /** 所有团队一览（含解散），供花名册索引 */
  listTeams(): TeamRecord[] {
    const dir = path.join(this.dataRoot, "team");
    if (!fs.existsSync(dir)) return [];
    const out: TeamRecord[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const f = path.join(dir, d.name, "team.json");
      if (!fs.existsSync(f)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(f, "utf-8")) as TeamRecord);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
