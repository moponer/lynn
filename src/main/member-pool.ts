/**
 * 成员池与三层隔离（2026-11-17 P3-2 / 08 章）。
 *
 * 现有代码只有「团队档案」：一个成员生在某支团队里，解散就没了，战绩只能现算、经验无处沉淀。
 * 这里补的是**跨团队的那个人**，并把「岗位说明」与「这个人在任务里学到的东西」彻底分开：
 *
 *   L1 profile.md  岗位说明 —— 只有 promoteLesson()（人工确认）能改，改动必带 version
 *   L2 lessons.jsonl 经验 —— 任务结束自动追加，**永远不写进 system prompt**
 *   L3 任务卷宗 —— 本来就在 tasks/<id>/，这里只按 taskId 引用，不复制
 *
 * 为什么这条隔离是硬需求而不是洁癖：L1 进了 system prompt，是每次调用都要付的前缀。
 * 一旦「任务 A 的教训」自动写进 L1，下一个毫不相干的任务 B 也会背着它，
 * 而且前缀哈希每次都变——缓存命中率与行为可复现性同时崩掉。08 章 §3 的四条硬规则就为此而设。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberProfile } from "./team-store";
import { parseMemberProfile, serializeMemberProfile } from "./team-store";

export type LessonScope = "global" | "project" | "domain";

export interface Lesson {
  id: string;
  memberId: string;
  scope: LessonScope;
  /** scope=domain 时限定领域；其它 scope 忽略 */
  domain?: string;
  /** 触发条件：这条经验在什么场景下有用（关键词，匹配简报用） */
  when: string;
  lesson: string;
  /** 来自哪张单（L2 条目的溯源；也是「同一条别再记一遍」的去重键） */
  evidenceTaskId: string;
  hits: number;
  createdAt: string;
}

export interface PoolMeta {
  memberId: string;
  /** L1 版本号；promoteLesson 才 +1 */
  version: number;
  domain: string;
  hiredAt: string;
  status: "active" | "probation";
  /** 连续失败次数；成功一次清零 */
  consecutiveFailures: number;
  /** L1 最近一次变更的时间（升格或初始招募） */
  l1UpdatedAt: string;
}

export interface PoolStats {
  tasks: number;
  success: number;
  rework: number;
  turns: number;
  tokens: number;
  overBudget: number;
  /** 打回原因计数（08 章 §5 的「打回原因分布」） */
  rejectReasons: Record<string, number>;
}

const EMPTY_STATS: PoolStats = { tasks: 0, success: 0, rework: 0, turns: 0, tokens: 0, overBudget: 0, rejectReasons: {} };

/** 连续失败到这个数进 probation（08 章 §5「连续 3 单失败 → probation，不自动删」） */
export const PROBATION_AFTER = 3;

/** 一次注入多少条经验、多少字（08 章 §4：最多 5 条 ≤600 字） */
const LESSON_LIMIT = 5;
const LESSON_CHAR_BUDGET = 600;

const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf-8").digest("hex");

/** memberId 要稳定：名字可改，ID 不变，战绩与经验才跟得住。用 roleId + 招募时刻派生，冲突再加序号 */
export function makeMemberId(roleId: string, seed: string): string {
  const slug = String(roleId ?? "member").replace(/[^a-z0-9-]/gi, "").slice(0, 12) || "member";
  return `m-${slug}-${sha256(seed).slice(0, 6)}`;
}

export interface HireInput {
  profile: MemberProfile;
  roleId: string;
  domain: string;
  /** 招募来源（团队 id / 模板 id），只进 meta 便于回溯，不参与身份 */
  hiredFrom?: string;
  /** 固定 memberId（导入/测试用） */
  memberId?: string;
}

export interface PooledMember {
  meta: PoolMeta;
  profile: MemberProfile;
  stats: PoolStats;
  lessons: Lesson[];
}

export class MemberPool {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "members");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private memberDir(memberId: string): string {
    if (!/^m-[a-z0-9-]+$/i.test(memberId)) throw new Error(`memberId 不合法：${memberId}`);
    return path.join(this.dir, memberId);
  }

  private l1File(memberId: string): string {
    return path.join(this.memberDir(memberId), "profile.md");
  }

  private metaFile(memberId: string): string {
    return path.join(this.memberDir(memberId), "meta.json");
  }

  private lessonsFile(memberId: string): string {
    return path.join(this.memberDir(memberId), "lessons.jsonl");
  }

  private recordFile(memberId: string): string {
    return path.join(this.memberDir(memberId), "record.json");
  }

  /** L1 的指纹。**跨任务不变的验收口径就是它**——只要没人走 promoteLesson，这个值不许变。 */
  l1Hash(memberId: string): string {
    return sha256(fs.readFileSync(this.l1File(memberId), "utf8"));
  }

  /** 招募：把岗位说明写进池子。同一份 profile 重复招募会得到同一个 memberId（幂等）。 */
  hire(input: HireInput): { memberId: string; version: number; created: boolean } {
    const seed = input.memberId ?? `${input.roleId}|${input.profile.name}|${input.hiredFrom ?? ""}`;
    const memberId = input.memberId ?? this.uniqueId(makeMemberId(input.roleId, seed), input.profile.name);
    const dir = this.memberDir(memberId);
    const meta = this.readMeta(memberId);
    if (meta) {
      // 已在池子里：不覆盖 L1（覆盖等于绕过升格流程改岗位说明）
      return { memberId, version: meta.version, created: false };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.l1File(memberId), serializeMemberProfile({ ...input.profile, roleId: input.roleId }), "utf-8");
    const now = new Date().toISOString();
    const next: PoolMeta = {
      memberId,
      version: 1,
      domain: input.domain,
      hiredAt: now,
      status: "active",
      consecutiveFailures: 0,
      l1UpdatedAt: now,
    };
    fs.writeFileSync(this.metaFile(memberId), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    fs.writeFileSync(this.recordFile(memberId), `${JSON.stringify(EMPTY_STATS, null, 2)}\n`, "utf-8");
    if (!fs.existsSync(this.lessonsFile(memberId))) fs.writeFileSync(this.lessonsFile(memberId), "", "utf-8");
    return { memberId, version: 1, created: true };
  }

  /** 同名成员已在池子里就换一个后缀，别把两个不同的人合成一个 */
  private uniqueId(candidate: string, name: string): string {
    if (!fs.existsSync(this.memberDir(candidate))) return candidate;
    // 同名同角色同来源 → 视为同一个人（幂等）；被同名别人占了 → 加序号
    const meta = this.readMeta(candidate);
    if (meta) {
      try {
        const p = parseMemberProfile(fs.readFileSync(this.l1File(candidate), "utf8"));
        if (p.name === name) return candidate;
      } catch {
        /* 坏文件就换 id */
      }
    }
    for (let i = 2; i < 100; i += 1) {
      const alt = `${candidate}-${i}`;
      if (!fs.existsSync(this.memberDir(alt))) return alt;
    }
    throw new Error(`memberId 冲突无法解决：${candidate}`);
  }

  private readMeta(memberId: string): PoolMeta | null {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile(memberId), "utf8")) as PoolMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: PoolMeta): void {
    fs.writeFileSync(this.metaFile(meta.memberId), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  }

  private readStats(memberId: string): PoolStats {
    try {
      return { ...EMPTY_STATS, ...(JSON.parse(fs.readFileSync(this.recordFile(memberId), "utf8")) as PoolStats) };
    } catch {
      return { ...EMPTY_STATS, rejectReasons: {} };
    }
  }

  /** 读一个人在池子里的全部状态（L1 + L2 + 战绩） */
  get(memberId: string): PooledMember {
    const meta = this.readMeta(memberId);
    if (!meta) throw new Error(`成员不在池子里：${memberId}`);
    return {
      meta,
      profile: parseMemberProfile(fs.readFileSync(this.l1File(memberId), "utf8")),
      stats: this.readStats(memberId),
      lessons: this.readLessons(memberId),
    };
  }

  /** 列出池子（断网可用：纯本地目录遍历） */
  list(filter: { roleId?: string; domain?: string; status?: PoolMeta["status"] } = {}): PooledMember[] {
    const out: PooledMember[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.startsWith("m-")) continue;
      try {
        const m = this.get(name);
        if (filter.domain && m.meta.domain !== filter.domain) continue;
        if (filter.status && m.meta.status !== filter.status) continue;
        if (filter.roleId && m.profile.roleId !== filter.roleId) continue;
        out.push(m);
      } catch {
        /* 坏条目跳过，不让一个人的坏文件毁掉整个池子 */
      }
    }
    return out.sort((a, b) => a.meta.memberId.localeCompare(b.meta.memberId));
  }

  private readLessons(memberId: string): Lesson[] {
    const file = this.lessonsFile(memberId);
    if (!fs.existsSync(file)) return [];
    const out: Lesson[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      try {
        out.push(JSON.parse(s) as Lesson);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  }

  private writeLessons(memberId: string, lessons: Lesson[]): void {
    fs.writeFileSync(
      this.lessonsFile(memberId),
      lessons.map((l) => JSON.stringify(l)).join("\n") + (lessons.length ? "\n" : ""),
      "utf-8",
    );
  }

  /**
   * 追加一条经验（L2）。**这是任务结束时唯一允许的写入**。
   * 同成员 + 同 taskId + 同 when 已存在就只把 hits+1，不重复记（否则同一张单反复重派会灌水）。
   */
  appendLesson(
    memberId: string,
    input: { scope: LessonScope; domain?: string; when: string; lesson: string; evidenceTaskId: string },
  ): { lesson: Lesson; duplicated: boolean } {
    if (!this.readMeta(memberId)) throw new Error(`成员不在池子里：${memberId}`);
    const lessons = this.readLessons(memberId);
    const dup = lessons.find(
      (l) => l.evidenceTaskId === input.evidenceTaskId && l.when === input.when && l.lesson === input.lesson,
    );
    if (dup) {
      dup.hits += 1;
      this.writeLessons(memberId, lessons);
      return { lesson: dup, duplicated: true };
    }
    const lesson: Lesson = {
      id: `l-${String(lessons.length + 1).padStart(3, "0")}`,
      memberId,
      scope: input.scope,
      ...(input.domain ? { domain: input.domain } : {}),
      when: input.when,
      lesson: input.lesson,
      evidenceTaskId: input.evidenceTaskId,
      hits: 1,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    lessons.push(lesson);
    this.writeLessons(memberId, lessons);
    return { lesson, duplicated: false };
  }

  /**
   * 按「领域 + 简报关键词」挑经验注入（08 章 §4）。
   *
   * 匹配是有意的窄：`global` 永远算命中；`domain` 要求领域一致；`project` 要求 when 里的词
   * 出现在简报里。异域任务**不注入**（08 章 §7：任务 B 异域 → 不注入，成员仍可被雇佣）——
   * 把 coding 的坑塞给写文档的成员，等于用一条错误经验污染它的判断。
   */
  pickLessons(
    memberId: string,
    input: { domain?: string; brief?: string; limit?: number; maxChars?: number },
  ): Lesson[] {
    const lessons = this.readLessons(memberId);
    const brief = String(input.brief ?? "").toLowerCase();
    const limit = input.limit ?? LESSON_LIMIT;
    const budget = input.maxChars ?? LESSON_CHAR_BUDGET;

    const eligible = lessons.filter((l) => {
      if (l.scope === "global") return true;
      if (l.scope === "domain") return !l.domain || !input.domain ? true : l.domain === input.domain;
      // project：靠 when 里的关键词命中简报
      return l.when
        .split(/[、,，/\s]+/)
        .filter(Boolean)
        .some((k) => brief.includes(k.toLowerCase()));
    });

    // 命中的多 → 先注入（同一批里按 hits 降序，同等 hits 按新的在前）
    const ranked = eligible.sort((a, b) => b.hits - a.hits || (a.createdAt < b.createdAt ? 1 : -1));
    const picked: Lesson[] = [];
    let used = 0;
    for (const l of ranked) {
      if (picked.length >= limit) break;
      const cost = l.lesson.length + l.when.length + 4;
      if (used + cost > budget) continue;
      picked.push(l);
      used += cost;
    }
    if (picked.length) {
      // 引用计数：真被注入过才算 hit（08 章 §3 规则 3「重复命中 hits++」）
      const byId = new Map(lessons.map((l) => [l.id, l]));
      for (const p of picked) {
        const row = byId.get(p.id);
        if (row) row.hits += 1;
      }
      this.writeLessons(memberId, lessons);
    }
    return picked;
  }

  /**
   * 升格：把一条 L2 经验写进 L1。**这是全仓唯一允许改 L1 的入口。**
   *
   * 为什么必须带 version + 调用方确认：L1 进 system prompt，改动等于换掉所有会话的前缀，
   * 也会改变这个成员此后每一次的表现。08 章 §8「污染检查：L1 变更必须带 version + golden diff」
   * 靠的就是「只有这一个门 + 版本必变」。
   */
  promoteLesson(
    memberId: string,
    lessonId: string,
    opts: { confirmedBy: string; goldenDiff?: string },
  ): { version: number; l1Hash: string } {
    const meta = this.readMeta(memberId);
    if (!meta) throw new Error(`成员不在池子里：${memberId}`);
    if (!opts?.confirmedBy) throw new Error("升格 L1 必须写明确认人（人工确认，不是自动写）");
    const lessons = this.readLessons(memberId);
    const lesson = lessons.find((l) => l.id === lessonId);
    if (!lesson) throw new Error(`没有这条经验：${lessonId}`);

    const profile = parseMemberProfile(fs.readFileSync(this.l1File(memberId), "utf8"));
    // 专有信息一律不许进 L1（08 章 §3 规则 4）：客户名、临时路径、项目代号
    const leak = /(?:[A-Za-z]:[\\/]|\\\\|%[A-Za-z_]+%|~\/|\/home\/|\/Users\/|tasks\/|\bsrc\/)/.exec(lesson.lesson);
    if (leak) throw new Error(`经验里含专有信息（${leak[0]}），不许升格进 L1——把路径换成通用说法再升`);

    const body = profile.body.trim();
    const marker = "【已升格经验】";
    const nextBody = body.includes(marker)
      ? `${body}\n- ${lesson.lesson}`
      : `${body}\n\n${marker}\n- ${lesson.lesson}`;
    fs.writeFileSync(this.l1File(memberId), serializeMemberProfile({ ...profile, body: nextBody }), "utf-8");
    const nextMeta: PoolMeta = { ...meta, version: meta.version + 1, l1UpdatedAt: new Date().toISOString() };
    this.writeMeta(nextMeta);
    this.writeLessons(memberId, lessons.filter((l) => l.id !== lessonId));
    return { version: nextMeta.version, l1Hash: this.l1Hash(memberId) };
  }

  /**
   * 记一单结果（L3 的聚合视图，不复制卷宗）。
   * 连续失败到 PROBATION_AFTER 进 probation——只标记、不删除（08 章 §5：淘汰不是自动删）。
   */
  recordOutcome(
    memberId: string,
    outcome: { ok: boolean; rework?: number; turns?: number; tokens?: number; overBudget?: boolean; rejectReason?: string },
  ): PoolMeta {
    const meta = this.readMeta(memberId);
    if (!meta) throw new Error(`成员不在池子里：${memberId}`);
    const stats = this.readStats(memberId);
    stats.tasks += 1;
    if (outcome.ok) stats.success += 1;
    stats.rework += Math.max(0, outcome.rework ?? 0);
    stats.turns += Math.max(0, outcome.turns ?? 0);
    stats.tokens += Math.max(0, outcome.tokens ?? 0);
    if (outcome.overBudget) stats.overBudget += 1;
    if (outcome.rejectReason) {
      stats.rejectReasons[outcome.rejectReason] = (stats.rejectReasons[outcome.rejectReason] ?? 0) + 1;
    }
    fs.writeFileSync(this.recordFile(memberId), `${JSON.stringify(stats, null, 2)}\n`, "utf-8");

    const failures = outcome.ok ? 0 : meta.consecutiveFailures + 1;
    const nextMeta: PoolMeta = {
      ...meta,
      consecutiveFailures: failures,
      status: failures >= PROBATION_AFTER ? "probation" : meta.status === "probation" && outcome.ok ? "active" : meta.status,
    };
    this.writeMeta(nextMeta);
    return nextMeta;
  }

  /**
   * 推荐候选（08 章 §5「成功率 × 经验覆盖 × 成本」，输出候选 3 人）。
   *
   * 分数刻意简单可解释：成功率打底，经验覆盖率加成，token 成本扣分。
   * 不搞黑箱权重——风铃要在群里解释「为什么推荐他」，说不清的排序等于没有。
   */
  rankCandidates(filter: { roleId?: string; domain?: string; limit?: number } = {}): {
    member: PooledMember;
    score: number;
    why: string;
  }[] {
    const pool = this.list({ roleId: filter.roleId, domain: filter.domain, status: "active" });
    const scored = pool.map((m) => {
      const s = m.stats;
      const successRate = s.tasks > 0 ? s.success / s.tasks : 0.5; // 没跑过 = 中性，不奖不罚
      const reworkRate = s.tasks > 0 ? s.rework / s.tasks : 0;
      const avgTokens = s.tasks > 0 ? s.tokens / s.tasks : 0;
      const lessonCoverage = Math.min(1, m.lessons.length / 5);
      // 成本项：单任务 22 万 token 记满扣分（08 章基线 224K/单）
      const costPenalty = Math.min(1, avgTokens / 220_000);
      const score = successRate * (1 + 0.15 * lessonCoverage) - 0.2 * reworkRate - 0.25 * costPenalty;
      const why =
        s.tasks > 0
          ? `${s.success}/${s.tasks} 成功、返工 ${s.rework}、平均 ${Math.round(avgTokens / 1000)}K tokens、经验 ${m.lessons.length} 条`
          : "还没有战绩（新成员）";
      return { member: m, score: Math.round(score * 1000) / 1000, why };
    });
    return scored.sort((a, b) => b.score - a.score || a.member.meta.memberId.localeCompare(b.member.meta.memberId)).slice(0, filter.limit ?? 3);
  }

  /** 导出（08 章 §8「断网可列出、雇佣、导出」）：一份自包含 JSON，可离线带走 */
  exportAll(): { version: number; exportedAt: string; members: (PooledMember & { l1Hash: string })[] } {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      members: this.list().map((m) => ({ ...m, l1Hash: this.l1Hash(m.meta.memberId) })),
    };
  }

  /** 导入：只接受没有的 memberId，绝不覆盖已有 L1（那是绕过升格） */
  importAll(data: { members: (PooledMember & { l1Hash?: string })[] }): { imported: string[]; skipped: string[] } {
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const m of data.members ?? []) {
      try {
        if (this.readMeta(m.meta.memberId)) {
          skipped.push(m.meta.memberId);
          continue;
        }
        const dir = this.memberDir(m.meta.memberId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.l1File(m.meta.memberId), serializeMemberProfile(m.profile), "utf-8");
        fs.writeFileSync(this.metaFile(m.meta.memberId), `${JSON.stringify(m.meta, null, 2)}\n`, "utf-8");
        fs.writeFileSync(this.recordFile(m.meta.memberId), `${JSON.stringify(m.stats, null, 2)}\n`, "utf-8");
        this.writeLessons(m.meta.memberId, m.lessons);
        imported.push(m.meta.memberId);
      } catch {
        skipped.push(m?.meta?.memberId ?? "(unknown)");
      }
    }
    return { imported, skipped };
  }
}

export interface RoleStat {
  roleId: string;
  members: number;
  probation: number;
  tasks: number;
  success: number;
  successRate: number;
  rework: number;
  avgTurns: number;
  avgTokens: number;
  /** 打回原因 Top3（08 章 §5 的「打回原因分布」） */
  topRejectReasons: { reason: string; count: number }[];
}

/**
 * 按 roleId 聚合战绩（G4，07 章 §4「按 roleId 统计成功率/返工/轮次/token」）。
 *
 * 为什么按角色而不是按人：单个人的样本太小，一次失败就能把成功率打到 50%，
 * 据此判断"这个人不行"只会冤枉人；按角色聚合才有统计意义——它回答的是
 * "这类岗位在我们的编排下普遍顺不顺"，这正是换模板门禁（08 章 §5）需要的口径。
 */
export function roleStats(pool: MemberPool): RoleStat[] {
  const byRole = new Map<string, RoleStat>();
  for (const m of pool.list()) {
    const roleId = m.profile.roleId ?? "unclassified";
    const row =
      byRole.get(roleId) ??
      ({
        roleId,
        members: 0,
        probation: 0,
        tasks: 0,
        success: 0,
        successRate: 0,
        rework: 0,
        avgTurns: 0,
        avgTokens: 0,
        topRejectReasons: [],
      } satisfies RoleStat);
    row.members += 1;
    if (m.meta.status === "probation") row.probation += 1;
    row.tasks += m.stats.tasks;
    row.success += m.stats.success;
    row.rework += m.stats.rework;
    // 轮次与 token 先累加，最后按 tasks 求平均
    row.avgTurns += m.stats.turns;
    row.avgTokens += m.stats.tokens;
    for (const [reason, count] of Object.entries(m.stats.rejectReasons ?? {})) {
      const hit = row.topRejectReasons.find((r) => r.reason === reason);
      if (hit) hit.count += count;
      else row.topRejectReasons.push({ reason, count });
    }
    byRole.set(roleId, row);
  }
  for (const row of byRole.values()) {
    row.successRate = row.tasks > 0 ? Math.round((row.success / row.tasks) * 1000) / 10 : 0;
    row.avgTurns = row.tasks > 0 ? Math.round(row.avgTurns / row.tasks) : 0;
    row.avgTokens = row.tasks > 0 ? Math.round(row.avgTokens / row.tasks) : 0;
    row.topRejectReasons = row.topRejectReasons.sort((a, b) => b.count - a.count).slice(0, 3);
  }
  return [...byRole.values()].sort((a, b) => b.tasks - a.tasks || a.roleId.localeCompare(b.roleId));
}

/** 经验注入文本（放首条 user，不进 system——L2 一旦进 system 就是每轮都付的前缀） */
export function renderLessons(lessons: readonly Lesson[]): string {
  if (!lessons.length) return "";
  return (
    "【这个岗位过去的经验（供参考，不是本次任务的额外要求）】\n" +
    lessons.map((l) => `- 当${l.when}：${l.lesson}（来自 ${l.evidenceTaskId}）`).join("\n")
  );
}

/**
 * 从一单的结局里提炼 L2 经验（纯规则，不调模型）。
 *
 * 只提炼「下次能照做」的东西；提炼不出来就不写——宁可不记，也不要写一句
 * 「要注意质量」这种谁也执行不了的废话，那种条目会很快把 5 条注入额度吃光。
 */
export function lessonsFromOutcome(input: {
  memberId: string;
  taskId: string;
  domain: string;
  ok: boolean;
  exitStatus?: string;
  turns?: number;
  maxTurns?: number;
  reworkFocus?: readonly string[];
}): { scope: LessonScope; domain?: string; when: string; lesson: string }[] {
  const out: { scope: LessonScope; domain?: string; when: string; lesson: string }[] = [];
  if (input.exitStatus === "turn_limit" && typeof input.turns === "number" && typeof input.maxTurns === "number") {
    out.push({
      scope: "domain",
      domain: input.domain,
      when: "按轮次派单 / 内容型任务",
      lesson: `${input.domain} 类任务 ${input.turns} 轮就用完了（上限 ${input.maxTurns}），轮次要给到 ${
        Math.ceil((input.turns * 1.5) / 5) * 5
      } 以上`,
    });
  }
  if (!input.ok && input.reworkFocus?.length) {
    out.push({
      scope: "domain",
      domain: input.domain,
      when: "交回报前自检",
      lesson: `上次被打回在这几条：${input.reworkFocus.slice(0, 3).join("；")}——同类任务先在自检里逐条过`,
    });
  }
  return out;
}