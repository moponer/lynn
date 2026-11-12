import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskStatus } from "../shared/contract";
import type { Root } from "./roots";
import type { EvidencePolicy } from "./task-scale";

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

/**
 * 任务工作区（2026-11-10 工作区模型）：
 *  - project：在用户项目里干活（root = 会话主根），生成物进 deliverables
 *  - sandbox：不碰用户项目（root = tasks/<id>/workspace），删起来干净
 * scratch 永远在数据根内，可被清理；deliverables 是交付物，永不被自动删。
 */
export interface TaskWorkspaceRecord {
  mode: "project" | "sandbox";
  root: string;
  /** 生成物目录（项目模式在项目内 deliverables/<taskId>/，沙箱模式在 workspace/deliverables/） */
  deliverablesDir?: string;
  /** 过程文件目录（永远在数据根内） */
  scratchDir?: string;
  /** 任务级附加根（用户在这张单上追加的只读/可写目录） */
  roots?: Root[];
}

/** 验收固化的交付物（task.json 里的权威清单） */
export interface DeliverableRef {
  /** 交付时相对工作区的路径 */
  path: string;
  /** 卷宗内副本（artifacts/x）或外部绝对路径（超阈值/只读根证据只登记引用） */
  ref: string;
  bytes?: number;
  at: string;
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
  /**
   * 这张单由谁验收：
   *   lynn —— 派给团队成员的活，风铃自己验（不合格就打回重做，她 accept 即归档）
   *   user —— 风铃交付给你的最终结果，只有你能拍板（§4.10.5 只对这一级生效）
   * 缺省按 user 处理：老单与风铃自己干的活都走用户终审，不会因为新字段被偷偷归档。
   */
  reviewer?: "lynn" | "user";
  createdAt: string;
  updatedAt: string;
  /** 这一段的 Pi session（追溯用，§4.10.7） */
  sessionId?: string;
  /**
   * 这张单是在哪个会话（线程）里派的。
   * 有了它，换到新会话后旧工单的"往来"才读得回来，也能回答"这单从哪来"。
   */
  threadId?: string;
  /**
   * 本单的只读授权目录（用户显式授予）：读可以在这些目录里，写永远只能在工作区。
   * 审查外部项目靠它，且授权只由用户发起（模型不能自我扩权）。
   */
  readRoots?: string[];
  /**
   * 成员的读写工作区（= 派单时会话的工作区 / 项目目录）。
   * 开发类任务要能真改代码，所以这里**可写**；删除类命令另走用户审批。
   * 没记过就退回 `<dataRoot>/tasks/<id>/workspace/`（老单）。
   */
  workspaceRoot?: string;
  /** 任务工作区的新形态（2026-11-10）；缺省时由 workspaceRoot 推导（老单） */
  workspace?: TaskWorkspaceRecord;
  /** 验收固化的交付物清单（与证据分开；交付物永久保留） */
  deliverables?: DeliverableRef[];
  /**
   * 为什么停在当前状态（人话）。blocked 有四种成因——用户手动停机、成员没交回报、
   * 打回 3 轮、进程重启对账——界面上不能再一律显示"连续两个节点没有新证据"。
   */
  statusNote?: string;
  /**
   * 卡住的成因（机读）。statusNote 是给人看的一句话，这里是给统计/筛选/巡检分桶用的：
   * 只有分开才知道"是系统崩了"还是"用户自己停的"还是"质量不达标"，不能一锅算"卡住 N"。
   * 离开 blocked 时清空，避免陈旧的成因跟着工单走。
   */
  blockedReason?: "user_stop" | "no_report" | "reject_limit" | "reconcile" | "crash";
  /**
   * 证据策略（2026-11-11）：
   * - optional（缺省）：无证据也能进审查/归档，只标注「无证据回报」——避免小任务被证据卡死；
   * - required：关键任务（审计/对账/安全/可复跑）仍强制 ≥1 项已验证证据。
   */
  evidencePolicy?: EvidencePolicy;
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
  /* 归档可被用户重开：风铃代验可能判错，锁死的单用户收不了场，所以留这条唯一退路 */
  done: ["in_progress"],
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
  /**
   * `onChange`：工单落盘后的回调（2026-11-11）。Kernel 用它做事件驱动心跳——
   * 工单状态一变就评估一次，不用等分钟级定时器；测试里不传，行为不变。
   */
  constructor(readonly dataRoot: string, private readonly hooks?: { onChange?: () => void }) {}

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
    // 落盘后通知（Kernel 用来做秒级事件心跳；测试不传则完全无副作用）
    this.hooks?.onChange?.();
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
    try {
      // Windows 上刚写过的文件常被短暂占用（EBUSY/EPERM）：给几次重试，别让用户点一次失败一次
      fs.rmSync(this.dir(id), { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      throw new TaskRuleError(
        /EBUSY|EPERM|ENOTEMPTY/.test(code)
          ? `删除失败：${id} 的目录被占用（可能成员刚写过文件）。等两秒再试，或先「取消」这张单。`
          : `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    workspaceRoot?: string;
    workspace?: TaskWorkspaceRecord;
    evidencePolicy?: EvidencePolicy;
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
      workspaceRoot: input.workspaceRoot ?? input.workspace?.root,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.evidencePolicy ? { evidencePolicy: input.evidencePolicy } : {}),
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
    opts: {
      expectedVersion?: number;
      member?: string;
      sessionId?: string;
      threadId?: string;
      /** 这次迁移的人话原因（界面按它区分"卡住"的成因），写进 TaskRecord.statusNote */
      note?: string;
      /** 迁移到 blocked 时的机读成因（统计/巡检分桶用）；离开 blocked 时自动清空 */
      blockedReason?: TaskRecord["blockedReason"];
    } = {},
  ): TaskRecord {
    const rec = this.mustGet(id);
    if (opts.expectedVersion !== undefined && rec.version !== opts.expectedVersion) {
      throw new TaskConflictError(id, opts.expectedVersion, rec.version);
    }
    if (rec.status === to) return rec;
    if (!LEGAL[rec.status].includes(to)) {
      throw new TaskRuleError(`不允许的迁移：${rec.status} → ${to}（七态见 §4.10.4）`);
    }
    // 证据策略（2026-11-11）：只有关键任务强制；普通任务无证据也能进审查，
    // 由界面标注「无证据回报」，不再因为缺一项证据把整张单堵死在执行中。
    if (to === "in_review" && rec.evidencePolicy === "required") {
      const ok = rec.evidence.filter((e) => e.verified);
      if (ok.length === 0) throw new TaskRuleError("关键任务进审查前必须附 ≥1 项已验证证据（审计/对账/安全类，§4.10.5）");
    }
    if (to === "done") {
      if (!rec.approvals.some((a) => a.action === "approve")) {
        throw new TaskRuleError("进归档前必须有用户的显式拍板记录（§4.10.5）");
      }
    }
    rec.status = to;
    // 卡住成因只在 blocked 上成立；一经离开就清掉，避免旧成因挂在新状态上被误统计
    if (to === "blocked") {
      if (opts.blockedReason) rec.blockedReason = opts.blockedReason;
    } else {
      rec.blockedReason = undefined;
    }
    if (opts.note) rec.statusNote = opts.note;
    if (opts.member) rec.member = opts.member;
    if (opts.sessionId) rec.sessionId = opts.sessionId;
    if (opts.threadId) rec.threadId = opts.threadId;
    return this.commit(rec);
  }

  /** 记这张单的读写工作区（派单时定；老单在首次开工时补记） */
  setWorkspaceRoot(id: string, root: string): TaskRecord {
    const rec = this.mustGet(id);
    if (rec.workspaceRoot === root) return rec;
    rec.workspaceRoot = path.resolve(root);
    return this.commit(rec);
  }

  /** 换这张单的工作区记录（审查快照切沙箱时用；与 workspaceRoot 镜像一起写） */
  setWorkspace(id: string, ws: TaskWorkspaceRecord): TaskRecord {
    const rec = this.mustGet(id);
    const next = { ...ws, root: path.resolve(ws.root) };
    rec.workspace = next;
    rec.workspaceRoot = next.root;
    return this.commit(rec);
  }

  /** 记交付物清单（验收固化；与证据分开） */
  setDeliverables(id: string, items: DeliverableRef[]): TaskRecord {
    const rec = this.mustGet(id);
    rec.deliverables = items;
    return this.commit(rec);
  }

  /** 设置/撤销只读授权目录（只由用户侧的授权入口调用） */
  setReadRoots(id: string, roots: string[]): TaskRecord {
    const rec = this.mustGet(id);
    rec.readRoots = roots.length ? [...new Set(roots)] : undefined;
    return this.commit(rec);
  }

  /** 调整证据策略：关键任务事后可升 required，普通任务可降 optional（不改其它状态） */
  setEvidencePolicy(id: string, policy: EvidencePolicy): TaskRecord {
    const rec = this.mustGet(id);
    if (rec.evidencePolicy === policy) return rec;
    rec.evidencePolicy = policy;
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
    // 满额升级才叫"质量不达标卡住"；没满额是重做，成因清空
    rec.blockedReason = escalated ? "reject_limit" : undefined;
    rec.statusNote = escalated
      ? `打回 ${rec.rejectRounds} 轮仍未达标（上限 ${rec.rejectLimit}）：${reason.what}`
      : `打回第 ${rec.rejectRounds} 轮重做：${reason.what}`;
    return { record: this.commit(rec, opts.expectedVersion), escalated };
  }

  /** 用户拍板：只记审批，不改状态；随后由 transition(...,"done") 生效 */
  approve(id: string, by = "user", note?: string, opts: { expectedVersion?: number } = {}): TaskRecord {
    const rec = this.mustGet(id);
    if (rec.evidencePolicy === "required" && !rec.evidence.some((e) => e.verified)) {
      throw new TaskRuleError("关键任务无证据不能拍板归档（§4.10.5）");
    }
    rec.approvals.push({ by, action: "approve", at: new Date().toISOString(), note });
    return this.commit(rec, opts.expectedVersion);
  }

  /** 记这张单的验收人（成员单交给风铃，最终交付留给你） */
  setReviewer(id: string, reviewer: "lynn" | "user"): TaskRecord {
    const rec = this.mustGet(id);
    if (rec.reviewer === reviewer) return rec;
    rec.reviewer = reviewer;
    return this.commit(rec);
  }

  /** 供内核集成：没有工单就补建，并推到 in_progress（派单即开工） */
  ensureInProgress(input: {
    id: string;
    title: string;
    teamId: string;
    member?: string;
    threadId?: string;
    workspaceRoot?: string;
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
