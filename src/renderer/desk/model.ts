import type {
  Decision,
  FeedCard,
  Member,
  QueueItem,
  SessionSnapshot,
  TaskStatus,
  TaskTrackItem,
  TurnState,
  UsageView,
} from "../../shared/contract";
import { actionOf, groupOf, type JobAction, type JobGroup } from "../../shared/task-groups";

/** 值台数据模型：把内核的指挥板转成"图纸审查室"需要的形状（只做转译，不编造事实） */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "待受理",
  todo: "待派单",
  in_progress: "执行中",
  in_review: "待审查",
  blocked: "卡住",
  done: "已归档",
  canceled: "已取消",
};

/** M3-08：状态文案 key（渲染层用 t() 取词；STATUS_LABEL 保留为中文兜底） */
export const STATUS_KEY: Record<TaskStatus, string> = {
  backlog: "status.backlog",
  todo: "status.todo",
  in_progress: "status.in_progress",
  in_review: "status.in_review",
  blocked: "status.blocked",
  done: "status.done",
  canceled: "status.canceled",
};

/** 阶段流：受理 → 拆解 → 派单 → 执行 → 审查 → 汇报 → 归档 */
export const STAGES = ["受理", "拆解", "派单", "执行", "审查", "汇报", "归档"] as const;

/** M3-08：阶段文案 key（与 STAGES 同序） */
export const STAGE_KEYS = [
  "stage.intake",
  "stage.breakdown",
  "stage.dispatch",
  "stage.execute",
  "stage.review",
  "stage.report",
  "stage.archive",
] as const;

const STAGE_OF: Record<TaskStatus, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 3,
  blocked: 3,
  in_review: 4,
  done: 6,
  canceled: 0,
};

const PHASE_STAGE: Record<TurnState["phase"], number> = {
  idle: 0,
  accepted: 0,
  planning: 1,
  awaiting_plan: 2,
  working: 3,
  review: 4,
  done: 6,
  failed: 3,
};

export interface DeskEvidence {
  level: "ok" | "warn" | "pending";
  title: string;
  detail: string;
  /** artifacts/ 下的相对路径（有就可点开验证） */
  ref?: string;
  verified?: boolean;
}

export interface DeskArtifact {
  name: string;
  section: string;
  head: string[];
  rows: string[][];
  foot: { text: string; warn?: boolean }[];
}

export interface DeskDiffLine {
  t: "ctx" | "add" | "del" | "hunk";
  no: number;
  text: string;
}

export interface DeskDiff {
  file: string;
  hunk: string;
  lines: DeskDiffLine[];
}

export interface DeskJob {
  id: string;
  teamId: string;
  teamName?: string;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  /** 台账分组（唯一来源：shared/task-groups） */
  group: JobGroup;
  /** 这张单需要你做什么：accept / unblock / none */
  action: JobAction;
  stage: number;
  member?: string;
  memberRole?: string;
  at?: string;
  statusNote: string;
  evidenceCount: number;
  evidence: DeskEvidence[];
  artifact?: DeskArtifact;
  diff?: DeskDiff;
  version: number;
  rejections: number;
  rejectLimit: number;
  budget?: { used: number; total: number };
  budgetKind?: "money" | "tokens";
  /** 她预填的打回三要素（来自最近一次打回） */
  rejectDraft?: { what: string; expect: string; deadline: string };
  /** 最近一次汇报（四段式，真实数据） */
  report?: { conclusion: string; evidence: string; unfinished: string; decision: string };
}

export interface DeskMember {
  name: string;
  role: string;
  model: string;
  status: "running" | "delivered" | "idle" | "stuck";
  statusLabel: string;
  jobId?: string;
  jobTitle?: string;
  tools: string[];
  turnLimit?: number;
  progress: number;
  foot: string;
  rejections: number;
  rejectLimit: number;
}

export interface DeskDecision {
  id: string;
  kind: "question" | "plan" | "approval";
  jobId?: string;
  who: string;
  at: string;
  question: string;
  checks: { ok: boolean; text: string }[];
  plan?: Decision["plan"];
}

export interface Desk {
  project: string;
  subdir: string;
  jobs: DeskJob[];
  archived: { id: string; title: string }[];
  members: DeskMember[];
  decision?: DeskDecision;
  tokensUsed: number;
  /** 真实对话流（频道 + 每个工单的往来） */
  feed: FeedCard[];
  turn: TurnState;
  usage: UsageView;
  queue: QueueItem[];
  /** 任务契约是否自动开始（设置页可改） */
  autoStart: boolean;
  /** 当前会话线程与列表（M1-14） */
  thread: { id: string; title: string };
  threads: { id: string; title: string; updatedAt: string }[];
}

const MEMBER_STATUS_LABEL: Record<DeskMember["status"], string> = {
  running: "执行中",
  delivered: "待拍板",
  idle: "空闲",
  stuck: "卡住",
};

/** M3-08：成员状态文案 key */
export const MEMBER_STATUS_KEY: Record<DeskMember["status"], string> = {
  running: "memberStatus.running",
  delivered: "memberStatus.delivered",
  idle: "memberStatus.idle",
  stuck: "memberStatus.stuck",
};

function evidenceOf(job: TaskTrackItem): DeskEvidence[] {
  // 只列真实证据；没有就是空链（渲染层显示空态，绝不编造"未附"三件套）
  return (job.evidence ?? []).map((e) => ({
    level: e.verified ? "ok" : "warn",
    title: e.label || e.ref,
    detail: e.verified ? `已验证 · ${e.ref}` : `未验证 · ${e.ref}`,
    ref: e.ref,
    verified: e.verified,
  }));
}

/** ISO 时间 → 本地短时间（界面不裸露 2026-11-03T10:33:13.816Z 这种原始值） */
export function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function reportOf(feed: FeedCard[], taskId: string): DeskJob["report"] {
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const c = feed[i];
    if (c.jobId === taskId && c.report) return c.report;
  }
  return undefined;
}

function toJob(job: TaskTrackItem, teamName?: string, member?: Member, feed: FeedCard[] = [], turn?: TurnState): DeskJob {
  const onThisTask = turn && turn.taskId === job.id && turn.phase !== "idle" ? PHASE_STAGE[turn.phase] : undefined;
  return {
    id: job.id,
    teamId: job.teamId,
    teamName,
    title: job.title,
    status: job.status,
    statusLabel: STATUS_LABEL[job.status] ?? job.status,
    group: groupOf(job.status),
    action: actionOf(job.status),
    stage: onThisTask ?? STAGE_OF[job.status] ?? 0,
    member: job.member,
    memberRole: member?.role,
    at: job.at,
    statusNote: job.statusNote,
    evidenceCount: job.evidenceCount ?? 0,
    evidence: evidenceOf(job),
    version: job.version ?? 1,
    rejections: job.rejectRounds ?? 0,
    rejectLimit: 3,
    budget: member ? { used: member.budgetUsed, total: member.budgetTotal } : undefined,
    budgetKind: "tokens",
    rejectDraft: job.rejectDraft,
    report: reportOf(feed, job.id),
  };
}

function toDecision(d: Decision): DeskDecision {
  return {
    id: d.id,
    kind: d.kind ?? "question",
    jobId: d.jobId,
    who: d.from,
    at: d.at ?? "",
    question: d.title + (d.detail ? `——${d.detail}` : ""),
    checks: d.checks ?? [],
    plan: d.plan,
  };
}

export function deskFromSnapshot(snap: SessionSnapshot): Desk {
  const board = snap.board;
  const teamNames = new Map(board.teams.map((t) => [t.id, t.name]));
  const memberOf = (name?: string): Member | undefined => {
    if (!name) return undefined;
    for (const t of board.teams) {
      const m = t.members.find((x) => x.name === name);
      if (m) return m;
    }
    return undefined;
  };

  const jobs = board.track.map((t) => toJob(t, teamNames.get(t.teamId), memberOf(t.member), snap.feed, snap.turn));

  const members: DeskMember[] = board.teams
    .filter((t) => t.status !== "dissolved")
    .flatMap((t) =>
      t.members.map((m) => {
        const job = jobs.find((j) => j.member === m.name && j.status !== "done");
        return {
          name: m.name,
          role: m.role,
          model: m.model ?? "未指定",
          status: m.status,
          statusLabel: MEMBER_STATUS_LABEL[m.status] ?? m.status,
          jobId: job?.id,
          jobTitle: job?.title,
          tools: m.toolWhitelist,
          turnLimit: m.turnLimit,
          progress:
            snap.turn.member === m.name && typeof snap.turn.progress === "number" ? snap.turn.progress : m.progress,
          foot: m.budgetTotal > 0 ? `预算 ${m.budgetUsed}/${m.budgetTotal}K` : "保留编制",
          rejections: m.rejections,
          rejectLimit: m.rejectionLimit,
        };
      }),
    );

  const first = board.decisions[0];

  return {
    project: snap.workspace.project,
    subdir: snap.workspace.subdir,
    jobs,
    archived: jobs
      .filter((j) => j.status === "done" || j.status === "canceled")
      .map((j) => ({ id: j.id, title: j.title })),
    members,
    decision: first ? toDecision(first) : undefined,
    tokensUsed: board.tokensUsed,
    feed: snap.feed,
    turn: snap.turn,
    usage: snap.usage,
    queue: snap.queue,
    autoStart: snap.prefs.autoStart,
    // 老快照/预览数据可能没有 thread 字段：兜底成空线程，不让整页崩在白屏
    thread: snap.thread ?? { id: "", title: "新会话" },
    threads: snap.threads ?? [],
  };
}
