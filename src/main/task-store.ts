import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskStatus } from "../shared/contract";

/**
 * 工单实体（计划书 §4.8 / §4.10.4 / §4.10.5）。
 *
 * 这是界面唯一可信的来源：`status` 是**权威字段**（不是渲染时推的），
 * `version` 做乐观并发，`parent_id` 单亲 + 防环，`evidence` 是进审查的准入依据。
 *
 * 存储：`<dataRoot>/tasks/<id>/task.json`（一任务一目录；artifacts/ 由任务卷宗使用）。
 * 写入一律「临时文件 + rename」，避免半截文件；版本不符直接拒绝，不覆盖别人的写。
 */

export interface EvidenceRef {
  id: string;
  kind: "command" | "file" | "test" | "snapshot" | "artifact";
  label: string;
  /** 可点开验证的对象：文件路径 / 命令 / URL */
  ref?: string;
  /** 由调用方验证过（文件存在 / 命令可复跑 / 快照可取） */
  verified: boolean;
  at: string;
}

export interface ApprovalRecord {
  by: string;
  action: "approve" | "reject";
  at: string;
  note?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  teamId: string;
  status: TaskStatus;
  /** 乐观并发版本，从 1 起 */
  version: number;
  /** 单亲；拆解出的子任务挂父工单 */
  parentId: string | null;
  member?: string;
  evidence: EvidenceRef[];
  /** 打回轮次（同一条问题反复回炉的计数） */
  rejectRounds: number;
  rejectLimit: number;
  /** 用户的显式拍板记录（→ done 的必要条件） */
  approvals: ApprovalRecord[];
  createdAt: string;
  updatedAt: string;
  /** 这一段的 Pi session（追溯用，§4.10.7） */
  sessionId?: string;
  /**
   * 这张单是在哪个会话（线程）里派的。
   * 有了它，换到新会话后旧工单的"往来"才读得回来，也能回答"这单从哪来"。
   */
  threadId?: string;
}

export class TaskConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`工单 ${id} 版本冲突：期望 v${expected}，实际 v${actual}。读最新 → 对账 → 重试一次（不循环）`);
    this.name = "TaskConflictError";
  }
}

export class TaskRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRuleError";
  }
}

/** 合法迁移（§4.10.4 七态）。其余一律拒绝。 */
const LEGAL: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "canceled", "blocked"],
  todo: ["in_progress", "canceled", "blocked"],
  in_progress: ["in_review", "blocked", "canceled"],
  in_review: ["done", "in_progress", "blocked", "canceled"],
  blocked: ["in_progress", "todo", "canceled"],
  done: [],
  canceled: [],
};

export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];

let seq = 0;
function evId(): string {
  seq += 1;
  return `ev-${Date.now().toString(36)}-${seq}`;
}

export class TaskStore {
  constructor(readonly dataRoot: string) {}

  private dir(id: string): string {
    return path.join(this.dataRoot, "tasks", id);
  }

  private file(id: string): string {
    return path.join(this.dir(id), "task.json");
  }

  private write(rec: TaskRecord): void {
    const dir = this.dir(rec.id);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    const tmp = path.join(dir, "task.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf-8");
    fs.renameSync(tmp, this.file(rec.id));
  }

  get(id: string): TaskRecord | null {
    const f = this.file(id);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf-8")) as TaskRecord;
  }

  list(): TaskRecord[] {
    const dir = path.join(this.dataRoot, "tasks");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => this.get(d.name))
      .filter((r): r is TaskRecord => r !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * 归档：已完成/已取消且超过 N 天没动静的工单，整目录移进 `tasks/_archive/`。
   * 从台账消失但仍可搜（目录与卷宗原样保留，不删）。
   */
  archiveOld(olderThanDays = 14, now = Date.now()): string[] {
    const tasksDir = path.join(this.dataRoot, "tasks");
    if (!fs.existsSync(tasksDir)) return [];
    const archiveDir = path.join(tasksDir, "_archive");
    const moved: string[] = [];
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const rec = this.get(entry.name);
      if (!rec) continue;
      if (rec.status !== "done" && rec.status !== "canceled") continue;
      const ageDays = (now - Date.parse(rec.updatedAt)) / 86_400_000;
      if (ageDays < olderThanDays) continue;
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(path.join(tasksDir, entry.name), path.join(archiveDir, entry.name));
      moved.push(entry.name);
    }
    return moved;
  }

  /**
   * 从台账彻底删掉一张单：`tasks/<id>/` 整目录（task.json + 卷宗 + artifacts + 工作区）一起删。
   * 不可恢复——界面必须二次确认；执行中的单不许删（先停成员）。
   */
  remove(id: string): void {
    const rec = this.mustGet(id);
    if (rec.status === "in_progress") {
      throw new TaskRuleError("这张单还在执行中：先停成员，再取消或删除");
    }
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** 归档带里的工单（界面「归档带」用；只读） */
  archived(): TaskRecord[] {
    const dir = path.join(this.dataRoot, "tasks", "_archive");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const f = path.join(dir, d.name, "task.json");
        return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as TaskRecord) : null;
      })
      .filter((r): r is TaskRecord => r !== null);
  }

  /** 建立工单：状态从 backlog 起，版本 1。父子关系在建单时定，之后不可改（单亲） */
  create(input: {
    id: string;
    title: string;
    teamId: string;
    parentId?: string;
    member?: string;
    threadId?: string;
  }): TaskRecord {
    if (this.get(input.id)) throw new TaskRuleError(`工单已存在: ${input.id}`);
    if (input.parentId) {
      const parent = this.get(input.parentId);
      if (!parent) throw new TaskRuleError(`父工单不存在: ${input.parentId}`);
      // parent 链不允许回到自己（新建时 id 不可能已在链上，但保留防御）
      this.assertNoCycle(input.id, input.parentId);
    }
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id: input.id,
      title: input.title,
      teamId: input.teamId,
      status: "backlog",
      version: 1,
      parentId: input.parentId ?? null,
      member: input.member,
      evidence: [],
      rejectRounds: 0,
      rejectLimit: 3,
      approvals: [],
      createdAt: now,
      updatedAt: now,
      threadId: input.threadId,
    };
    this.write(rec);
    return rec;
  }

  /** 条件写：expectedVersion 不符即拒绝（乐观并发，不覆盖别人的写） */
  private commit(rec: TaskRecord, expectedVersion?: number): TaskRecord {
    if (expectedVersion !== undefined && rec.version !== expectedVersion) {
      // rec 已是磁盘最新；调用方拿旧版本写
      throw new TaskConflictError(rec.id, expectedVersion, rec.version);
    }
    rec.version += 1;
    rec.updatedAt = new Date().toISOString();
    this.write(rec);
    return rec;
  }

  private mustGet(id: string): TaskRecord {
    const rec = this.get(id);
    if (!rec) throw new TaskRuleError(`工单不存在: ${id}`);
    return rec;
  }

  private assertNoCycle(id: string, parentId: string | null): void {
    let cur: string | null = parentId;
    const seen = new Set<string>([id]);
    while (cur) {
      if (seen.has(cur)) throw new TaskRuleError(`父子关系成环：${id} → ${parentId}`);
      seen.add(cur);
      cur = this.get(cur)?.parentId ?? null;
    }
  }

  /**
   * 状态迁移（唯一入口）。三类前置校验钉在这里（§4.10.5）：
   *  - → in_review：必须已有 ≥1 项**已验证**证据；
   *  - → done：必须有用户的显式拍板记录；
   *  - 打回：走 reject()，轮次 +1，满 3 轮强制升级（转 blocked）。
   */
  transition(
    id: string,
    to: TaskStatus,
    opts: { expectedVersion?: number; member?: string; sessionId?: string; threadId?: string } = {},
  ): TaskRecord {
    const rec = this.mustGet(id);
    if (opts.expectedVersion !== undefined && rec.version !== opts.expectedVersion) {
      throw new TaskConflictError(id, opts.expectedVersion, rec.version);
    }
    if (rec.status === to) return rec;
    if (!LEGAL[rec.status].includes(to)) {
      throw new TaskRuleError(`不允许的迁移：${rec.status} → ${to}（七态见 §4.10.4）`);
    }
    if (to === "in_review") {
      const ok = rec.evidence.filter((e) => e.verified);
      if (ok.length === 0) throw new TaskRuleError("进审查前必须附 ≥1 项已验证证据（无证据不算完成，§4.10.5）");
    }
    if (to === "done") {
      if (!rec.approvals.some((a) => a.action === "approve")) {
        throw new TaskRuleError("进归档前必须有用户的显式拍板记录（§4.10.5）");
      }
    }
    rec.status = to;
    if (opts.member) rec.member = opts.member;
    if (opts.sessionId) rec.sessionId = opts.sessionId;
    if (opts.threadId) rec.threadId = opts.threadId;
    return this.commit(rec);
  }

  /** 记 Pi session id：这个工单这一段是哪个会话跑的（§4.10.7 / 规范 §6.5） */
  setSessionId(id: string, sessionId: string): TaskRecord {
    const rec = this.mustGet(id);
    if (rec.sessionId === sessionId) return rec;
    rec.sessionId = sessionId;
    return this.commit(rec);
  }

  /** 登记证据（不迁移状态；verified 由调用方验证后传入） */
  addEvidence(
    id: string,
    ev: Omit<EvidenceRef, "id" | "at">,
    opts: { expectedVersion?: number } = {},
  ): TaskRecord {
    const rec = this.mustGet(id);
    rec.evidence.push({ ...ev, id: evId(), at: new Date().toISOString() });
    return this.commit(rec, opts.expectedVersion);
  }

  /**
   * 打回：轮次 +1；满 rejectLimit 轮时不再循环，转 blocked 并标记升级（由调用方去问用户）。
   * 返回 escalated 表示「必须升级问你」。
   */
  reject(
    id: string,
    reason: { what: string; expect: string; deadline: string; member?: string },
    opts: { expectedVersion?: number } = {},
  ): { record: TaskRecord; escalated: boolean } {
    const rec = this.mustGet(id);
    if (rec.status !== "in_review") {
      throw new TaskRuleError(`只有 in_review 可以打回，当前 ${rec.status}`);
    }
    if (!reason.what.trim() || !reason.expect.trim() || !reason.deadline.trim()) {
      throw new TaskRuleError("打回必须写清：哪里不合格 / 期望是什么 / 多久内重交（§4.10.5）");
    }
    rec.rejectRounds += 1;
    rec.approvals.push({
      by: "lynn",
      action: "reject",
      at: new Date().toISOString(),
      note: JSON.stringify(reason),
    });
    const escalated = rec.rejectRounds >= rec.rejectLimit;
    rec.status = escalated ? "blocked" : "in_progress";
    return { record: this.commit(rec, opts.expectedVersion), escalated };
  }

  /** 用户拍板：只记审批，不改状态；随后由 transition(...,"done") 生效 */
  approve(id: string, by = "user", note?: string, opts: { expectedVersion?: number } = {}): TaskRecord {
    const rec = this.mustGet(id);
    if (!rec.evidence.some((e) => e.verified)) {
      throw new TaskRuleError("无证据不能拍板归档（§4.10.5）");
    }
    rec.approvals.push({ by, action: "approve", at: new Date().toISOString(), note });
    return this.commit(rec, opts.expectedVersion);
  }

  /** 供内核集成：没有工单就补建，并推到 in_progress（派单即开工） */
  ensureInProgress(input: {
    id: string;
    title: string;
    teamId: string;
    member?: string;
    threadId?: string;
  }): TaskRecord {
    const existing = this.get(input.id);
    if (existing) {
      // 老工单补上会话归属（派单时没记过的，下一次开工补记）
      if (input.threadId && !existing.threadId) {
        existing.threadId = input.threadId;
        this.commit(existing);
      }
      if (existing.status === "backlog" || existing.status === "todo") {
        const r1 = this.transition(input.id, existing.status === "backlog" ? "todo" : "in_progress", { member: input.member });
        return r1.status === "todo" ? this.transition(input.id, "in_progress", { member: input.member }) : r1;
      }
      return existing;
    }
    const rec = this.create(input);
    this.transition(rec.id, "todo");
    return this.transition(rec.id, "in_progress", { member: input.member });
  }
}
