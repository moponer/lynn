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
import {
  MEMBER_STATE_KEY,
  MEMBER_STATE_LABEL,
  PHASE_STAGE,
  STAGE_KEYS,
  STAGE_OF,
  STAGES,
  STATUS_KEY,
  STATUS_LABEL,
} from "../../shared/lexicon";

/** 值台数据模型：把内核的指挥板转成"图纸审查室"需要的形状（只做转译，不编造事实） */

// 词表只在 shared/lexicon.ts 定义一次；这里转出，渲染层继续从 model 取
export { PHASE_STAGE, STAGE_KEYS, STAGE_OF, STAGES, STATUS_KEY, STATUS_LABEL };
export { MEMBER_STATE_KEY as MEMBER_STATUS_KEY };

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
  /** 这张单是在哪个会话里派的（换会话后回原会话读往来） */
  threadId?: string;
}

export interface DeskMember {
  name: string;
  /** 归属团队：跨团队平铺时，同名的两个成员必须能区分 */
  teamId: string;
  teamName?: string;
  role: string;
  model: string;
  status: "running" | "delivered" | "idle" | "stuck";
  statusLabel: string;
  jobId?: string;
  jobTitle?: string;
  tools: string[];
  /** 工具清单来源：assignment=本单实际授权（比模板窄），template=岗位模板（没有派单记录时） */
  toolSource: "assignment" | "template";
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
  archived: { id: string; title: string; status?: TaskStatus }[];
  members: DeskMember[];
  /** 未解散的团队数：>1 时成员卡要标出归属，否则同名成员分不清 */
  teamCount: number;
  /** 挂起的裁决（问题/契约/审批）——多条都要可见可翻，不能只露第一条（A5） */
  decisions: DeskDecision[];
  tokensUsed: number;
  /** 真在跑的成员单（后端 memberRuns；不是 status=in_progress 的近似） */
  running: string[];
  /** D3：会话级软预算（只在真的配了上限时存在；黄铜 chip 不显示假数据） */
  budget?: { spent: number; soft: number };
  /** 真实对话流（频道 + 每个工单的往来） */
  feed: FeedCard[];
  turn: TurnState;
  usage: UsageView;
  queue: QueueItem[];
  /** 任务契约是否自动开始（设置页可改） */
  autoStart: boolean;
  /** 当前会话线程与列表（M1-14） */
  thread: { id: string; title: string };
  /** C3：会话行带"这个会话里在办 / 已归档的单"计数（后端汇总，前端不猜） */
  threads: { id: string; title: string; updatedAt: string; counts?: { active: number; archived: number } }[];
}

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
    threadId: job.threadId,
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
        // 一张成员卡优先挂"需要你的/在跑的"那张单，其次才是最近归档前的那张
        const mine = jobs.filter((j) => j.member === m.name && j.group !== "archived");
        const job = mine.find((j) => j.action !== "none") ?? mine.find((j) => j.group === "running") ?? mine[0];
        return {
          name: m.name,
          teamId: t.id,
          teamName: t.name,
          role: m.role,
          model: m.model ?? "未指定",
          status: m.status,
          statusLabel: MEMBER_STATE_LABEL[m.status] ?? m.status,
          jobId: job?.id,
          jobTitle: job?.title,
          tools: m.effectiveTools ?? m.toolWhitelist,
          toolSource:
            m.effectiveTools &&
            !(m.effectiveTools.length === m.toolWhitelist.length && m.toolWhitelist.every((x) => m.effectiveTools!.includes(x)))
              ? "assignment"
              : "template",
          turnLimit: m.turnLimit,
          progress:
            snap.turn.member === m.name && typeof snap.turn.progress === "number" ? snap.turn.progress : m.progress,
          // 没用过预算就说"上限"，别用 0/300K 冒充"已经花了 0"
          foot:
            m.budgetTotal > 0
              ? m.budgetUsed > 0
                ? `预算 ${m.budgetUsed}/${m.budgetTotal}K`
                : `预算上限 ${m.budgetTotal}K`
              : "保留编制",
          rejections: m.rejections,
          rejectLimit: m.rejectionLimit,
        };
      }),
    );

  // D3：软预算只在后端真的配了上限（>0）时才存在——0 表示"未设预算"，不画一个假的 0%
  const soft = snap.prefs.softBudgetTokens ?? 0;

  return {
    project: snap.workspace.project,
    subdir: snap.workspace.subdir,
    jobs,
    archived: jobs
      .filter((j) => j.status === "done" || j.status === "canceled")
      .map((j) => ({ id: j.id, title: j.title, status: j.status })),
    members,
    teamCount: board.teams.filter((t) => t.status !== "dissolved").length,
    decisions: board.decisions.map(toDecision),
    tokensUsed: board.tokensUsed,
    running: snap.running ?? [],
    budget: soft > 0 ? { spent: snap.usage.sessionIn + snap.usage.sessionOut, soft } : undefined,
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
