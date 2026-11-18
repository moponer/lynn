import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRoots, primaryOf, type RootSet } from "./roots";

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
  /** 头像库 id（见 shared/avatars）：用户可在设置→团队里改，招募时自动分配 */
  avatarId?: string;
  /** 常驻验收员岗位（2026-11-15）：只做验收、不参与执行；风铃据此把验收下沉给成员 */
  acceptor?: boolean;
  /** 正文：这个岗位怎么做事的说明（由风铃写，可迭代） */
  body: string;
  /**
   * 注册表角色 id（2026-11-17 P3-1 / 07 章）：由 G1 准入闸解析并落盘。
   * 存量档案没有这个字段——读取时按 role 文本现算，不回头改文件。
   */
  roleId?: string;
  /**
   * 池内 id（2026-11-17 P3-2 / 08 章）：团队只是雇佣关系，人是池子里的那个人。
   * 名字可以改，这个 id 不变，战绩与经验才跟得住。
   */
  memberId?: string;
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
    ...(p.roleId ? [`role_id: ${JSON.stringify(p.roleId)}`] : []),
    ...(p.memberId ? [`member_id: ${JSON.stringify(p.memberId)}`] : []),
    ...(p.acceptor ? [`acceptor: true`] : []),
    ...(p.avatarId ? [`avatar_id: ${JSON.stringify(p.avatarId)}`] : []),
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
    ...(lines.some((l) => l.startsWith("avatar_id:"))
      ? { avatarId: JSON.parse(lines.find((l) => l.startsWith("avatar_id:"))!.slice(10).trim()) as string }
      : {}),
    ...(lines.some((l) => l.startsWith("acceptor:"))
      ? { acceptor: (() => {
          const raw = lines.find((l) => l.startsWith("acceptor:"))!.slice(9).trim();
          return raw === "true";
        })() }
      : {}),
    ...(lines.some((l) => l.startsWith("role_id:"))
      ? { roleId: JSON.parse(lines.find((l) => l.startsWith("role_id:"))!.slice(8).trim()) as string }
      : {}),
    ...(lines.some((l) => l.startsWith("member_id:"))
      ? { memberId: JSON.parse(lines.find((l) => l.startsWith("member_id:"))!.slice(10).trim()) as string }
      : {}),
    body: body.trim(),
  };
}

// ---------- 文件名净化 ----------

export function memberFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`成员名无法生成安全文件名: ${name}`);
  return `${safe}.md`;
}

/**
 * teamId 会直接当目录名用，必须净化——否则 ``../..`` 能把 mkdir 写到数据根之外。
 * 中文/Unicode 放行（用户说的名字可以直接当显示名），但要挡住分隔符与上跳。
 */
export function assertValidTeamId(teamId: string): string {
  const id = teamId.trim();
  if (!id) throw new Error("团队 ID 不能为空");
  if (id === "." || id === ".." || id.includes("..")) throw new Error(`团队 ID 不合法：${teamId}`);
  if (/[\\/:*?"<>|\x00-\x1f]/.test(id)) throw new Error(`团队 ID 不能包含路径分隔符或控制字符：${teamId}`);
  if (id.length > 64) throw new Error(`团队 ID 不能超过 64 个字符：${teamId}`);
  return id;
}

/**
 * 系统生成团队 ID（§4.10.3 修正）：ID 是内部主键，不该由人给。
 * 名字里全是 ASCII 就退化成可读 slug，否则 `team-<时间36>-<随机>`。
 */
export function generateTeamId(name?: string, taken?: (id: string) => boolean): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  for (let i = 0; i < 50; i += 1) {
    const tail = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
    const id = slug ? `${slug}-${tail}` : `team-${tail}`;
    if (!taken || !taken(id)) return id;
  }
  throw new Error("生成团队 ID 失败（重名过多），请重试");
}

// ---------- TeamStore ----------

export interface TeamRecord {
  id: string;
  name: string;
  createdAt: string;
  /** 在职 | 暂停 | 已解散 */
  status: "active" | "paused" | "dissolved";
  budgetTokens: number;
  /**
   * 团队默认根（建队时从会话快照）：后续任务省略 workspace 时继承它。
   * 模板不带根——模板复用的是"人"，不是某个项目的路径。
   */
  roots?: RootSet;
  /**
   * 这个群（会话）就是这支队的群（2026-11-12 群聊模式）。
   * 之前靠"最近一张单的 threadId == 当前会话"猜同一条任务线，猜错就把别群的人塞进来；
   * 显式绑定后："本群成员"= 这支队，"其他团队"= 别的群，两者不再混。
   */
  threadId?: string;
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

/** 本单实际授权（§4.10.3 min(模板, 分配)）：从 assign 记录解析；坏行/缺字段返回 null（回落岗位模板） */
export function effectiveToolsOf(rec: AssignmentRecord): string[] | null {
  if (rec.kind !== "assign") return null;
  try {
    const parsed = JSON.parse(rec.text) as { tools?: unknown };
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0 && parsed.tools.every((t) => typeof t === "string")) {
      return parsed.tools as string[];
    }
  } catch {
    /* 坏行不炸 */
  }
  return null;
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

  /**
   * 成员列表缓存（2026-11-16「未响应」）：
   * listMembers 每次都要 readdir + 逐个 readFileSync + 解析档案。而一次快照里
   * 它会被调用很多遍（团队卡、群成员名单、验收员判定、@ 解析各一次），成员越多越贵。
   * 按"写入代数 + 短 TTL"缓存；代数存在模块级（按数据根），
   * 这样内核与壳层/测试各自的实例写成员后，彼此的缓存都会失效。
   */
  private static readonly MEMBER_CACHE = new Map<string, { tick: number; at: number; list: MemberProfile[] }>();
  private static readonly MEMBER_TICK = new Map<string, number>();
  private static readonly MEMBER_TTL_MS = 300;

  private invalidateMembers(): void {
    TeamStore.MEMBER_TICK.set(this.dataRoot, (TeamStore.MEMBER_TICK.get(this.dataRoot) ?? 0) + 1);
    for (const k of [...TeamStore.MEMBER_CACHE.keys()]) {
      if (k.startsWith(`${this.dataRoot}::`)) TeamStore.MEMBER_CACHE.delete(k);
    }
  }

  teamDir(teamId: string): string {
    // 目录名就是主键：不做净化等于把数据根暴露给 `../..`
    return path.join(this.dataRoot, "team", assertValidTeamId(teamId));
  }

  createTeam(id: string, name: string, budgetTokens = 1_000_000, threadId?: string): TeamRecord {
    const safeId = assertValidTeamId(id);
    const rec: TeamRecord = {
      id: safeId,
      name,
      createdAt: new Date().toISOString(),
      status: "active",
      budgetTokens,
      ...(threadId ? { threadId } : {}),
    };
    const dir = this.teamDir(safeId);
    fs.mkdirSync(path.join(dir, "members"), { recursive: true });
    fs.mkdirSync(path.join(dir, "assignments"), { recursive: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "reviews"), { recursive: true });
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(rec, null, 2));
    this.invalidateMembers();
    return rec;
  }

  teamExists(teamId: string): boolean {
    // 非法 ID 一律当"不存在"，让调用方走自动建队/如实报错，而不是抛异常打断工具轮
    try {
      return fs.existsSync(path.join(this.teamDir(teamId), "team.json"));
    } catch {
      return false;
    }
  }

  readTeam(teamId: string): TeamRecord {
    const file = path.join(this.teamDir(teamId), "team.json");
    if (!fs.existsSync(file)) throw new Error(`团队不存在: ${teamId}`);
    return JSON.parse(fs.readFileSync(file, "utf-8")) as TeamRecord;
  }

  /**
   * 绑定这支队属于哪个群（2026-11-12 群聊模式）。
   * 只在未绑定或本来就属于这个群时写——不让旧队的归属被别群悄悄改掉。
   */
  bindThread(teamId: string, threadId: string): TeamRecord {
    const rec = this.readTeam(teamId);
    if (rec.threadId) return rec; // 已绑定（同一群或别的群）都不改
    rec.threadId = threadId;
    fs.writeFileSync(path.join(this.teamDir(teamId), "team.json"), JSON.stringify(rec, null, 2), "utf-8");
    return rec;
  }

  /** 记团队默认根（建队时从会话快照；任务省略 workspace 时继承） */
  setRoots(teamId: string, roots: RootSet): TeamRecord {
    const rec = this.readTeam(teamId);
    const normalized = normalizeRoots(roots) ?? { extras: [] };
    rec.roots = normalized;
    fs.writeFileSync(path.join(this.teamDir(teamId), "team.json"), JSON.stringify(rec, null, 2));
    return rec;
  }

  /** 团队默认主根（没记过 = 空串，由调用方回退到会话/默认工作区） */
  workspaceOf(teamId: string): string {
    try {
      return primaryOf(this.readTeam(teamId).roots);
    } catch {
      return "";
    }
  }

  /** 在职团队（自动建队/隐式绑定只看这些；解散的队留着当资产，不能派活） */
  activeTeams(): TeamRecord[] {
    return this.listTeams().filter((t) => t.status === "active");
  }

  writeMember(teamId: string, p: MemberProfile): string {
    const file = path.join(this.teamDir(teamId), "members", memberFileName(p.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeMemberProfile(p), "utf-8");
    this.invalidateMembers();
    return file;
  }

  readMember(teamId: string, name: string): MemberProfile {
    const file = path.join(this.teamDir(teamId), "members", memberFileName(name));
    return parseMemberProfile(fs.readFileSync(file, "utf-8"));
  }

  listMembers(teamId: string): MemberProfile[] {
    const key = `${this.dataRoot}::${teamId}`;
    const tick = TeamStore.MEMBER_TICK.get(this.dataRoot) ?? 0;
    const now = Date.now();
    const hit = TeamStore.MEMBER_CACHE.get(key);
    if (hit && hit.tick === tick && now - hit.at < TeamStore.MEMBER_TTL_MS) return hit.list.slice();
    const dir = path.join(this.teamDir(teamId), "members");
    if (!fs.existsSync(dir)) return [];
    const list = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseMemberProfile(fs.readFileSync(path.join(dir, f), "utf-8")));
    TeamStore.MEMBER_CACHE.set(key, { tick, at: now, list });
    return list.slice();
  }

  /**
   * 用户手动改岗位：只放行"角色 / 单一目标 / 岗位说明正文"三段。
   * 工具白名单不在这里改——扩权必须走模板导入的收窄校验，避免界面变成提权入口。
   */
  updateMember(
    teamId: string,
    name: string,
    patch: { role?: string; goal?: string; body?: string; avatarId?: string },
  ): MemberProfile {
    const p = this.readMember(teamId, name);
    const next: MemberProfile = {
      ...p,
      ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.avatarId !== undefined ? { avatarId: patch.avatarId } : {}),
    };
    if (!next.role) throw new Error("角色不能为空（这一列是成员卡上显示的身份）");
    if (!next.goal) throw new Error("单一目标不能为空（成员据此收敛行为）");
    this.writeMember(teamId, next);
    return next;
  }

  /** 删成员：只删岗位档案；派单/回报记录留在 assignments 里当审计资产 */
  removeMember(teamId: string, name: string): void {
    const file = path.join(this.teamDir(teamId), "members", memberFileName(name));
    if (!fs.existsSync(file)) throw new Error(`团队 ${teamId} 里没有成员「${name}」`);
    const rest = this.listMembers(teamId).filter((p) => p.name !== name);
    // 空编制 = 既派不了活又占着"在职团队"：要清空请直接解散，别留半截状态
    if (rest.length === 0) throw new Error("这是团队最后一名成员：要清空编制请直接解散团队");
    fs.unlinkSync(file);
    this.invalidateMembers();
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
