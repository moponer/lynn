// 印章组件（2026-11-14）：从 Desk.tsx 拆出的纯展示组件。
//
// 它们不持有业务状态，只吃 decision / job 与三个回调（onPlan / onAnswer / 其它），
// 所以是 Desk 拆分的第一刀——搬出来不会牵动 Sheet/Roster 的编排逻辑。
import { useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtTime, type DeskDecision, type DeskJob } from "./model";

export function SealHead({ k, id }: { k: string; id?: string }) {
  return (
    <div className="sealcard-h">
      <span className="k">{k}</span>
      {id && <span className="mono seal-id">{id}</span>}
    </div>
  );
}

export function SealChecks({ checks, label }: { checks: { ok: boolean; text: string }[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (checks.length === 0) return null;
  // 22 条路径铺满整张卡就是"一坨"：先给 5 条，其余点开；每行单行省略，全文进 title
  const LIMIT = 5;
  const shown = open ? checks : checks.slice(0, LIMIT);
  return (
    <div className="accept">
      <div className="k">
        {label ?? t("seal.acceptance")}
        <span className="n">{checks.length}</span>
      </div>
      <ul>
        {shown.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "bad"} title={c.text}>
            <Icon name={c.ok ? "check" : "warn"} size="sm" />
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
      {checks.length > LIMIT && (
        <button type="button" className="accept-more" onClick={() => setOpen((v) => !v)}>
          {open ? t("seal.checksLess") : t("seal.checksMore", { n: checks.length })}
        </button>
      )}
    </div>
  );
}

/** 任务契约：开始 / 改一版 / 先不做 */
export function PlanSeal({
  decision,
  onPlan,
}: {
  decision: DeskDecision;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string, always?: boolean) => void;
}) {
  const [revise, setRevise] = useState<string | null>(null);
  const t = useT();
  const plan = decision.plan!;
  return (
    <div className="sealcard">
      <SealHead k={t("seal.contract")} id={plan.taskId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{plan.member ?? t("seal.tbd")}</b>
            {plan.deadline ? ` · ${t("seal.deadline", { d: plan.deadline })}` : ""}
            {plan.budgetTokens ? ` · ${t("seal.budget", { k: Math.round(plan.budgetTokens / 1000) })}` : ""}
          </div>
          <div className="ask">{plan.title}</div>
          {/* 项目与落点：用户点「开始」之前就知道这单动的是哪个项目、落在哪个目录 */}
          {(plan.projectName || plan.workspaceRoot) && (
            <div className="seal-proj">
              {plan.projectName && (
                <span className="seal-proj-name">
                  {t("project.label")} · {plan.projectName}
                </span>
              )}
              {plan.workspaceRoot && (
                <span className="mono" title={plan.workspaceRoot}>
                  {plan.workspaceRoot.split(/[\\/]/).filter(Boolean).pop()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <SealChecks checks={decision.checks} />
      {revise === null ? (
        <div className="seal-actions">
          <button type="button" className="btn btn-accept" onClick={() => onPlan(decision.id, "start")}>
            <Icon name="check" size="sm" /> {t("seal.start")}
          </button>
          <button type="button" className="btn" onClick={() => setRevise("")}>
            <Icon name="undo" size="sm" /> {t("seal.revise")}
          </button>
          <button type="button" className="btn btn-reject" onClick={() => onPlan(decision.id, "reject")}>
            {t("seal.later")}
          </button>
        </div>
      ) : (
        <div className="seal-revise">
          <textarea
            className="seal-input"
            value={revise}
            onChange={(e) => setRevise(e.target.value)}
            placeholder={t("seal.revisePlaceholder")}
          />
          <div className="seal-actions">
            <button
              type="button"
              className="btn btn-accept"
              disabled={!revise.trim()}
              onClick={() => onPlan(decision.id, "revise", revise)}
            >
              {t("seal.reviseSubmit")}
            </button>
            <button type="button" className="btn" onClick={() => setRevise(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 工具审批：批准这一动作，或拒绝（拒绝不算错误轮） */
export function ApprovalSeal({
  decision,
  onPlan,
}: {
  decision: DeskDecision;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string, always?: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.approveHead")} id={decision.jobId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">{t("seal.permAskMode")}</div>
          <div className="ask">{decision.question}</div>
        </div>
      </div>
      <div className="seal-actions">
        <button type="button" className="btn btn-accept" onClick={() => onPlan(decision.id, "start")}>
          <Icon name="check" size="sm" /> {t("seal.allow")}
        </button>
        <button type="button" className="btn btn-reject" onClick={() => onPlan(decision.id, "reject")}>
          {t("seal.reject")}
        </button>
        {decision.family ? (
          <button
            type="button"
            className="btn seal-allow-family"
            onClick={() => onPlan(decision.id, "start", undefined, true)}
          >
            {t("seal.allowFamily")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 她的问题：回答会作为新一回合的输入回到模型 */
export function QuestionSeal({
  decision,
  onAnswer,
}: {
  decision: DeskDecision;
  onAnswer: (id: string, text: string) => void;
}) {
  const [text, setText] = useState("");
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.questionHead")} id={decision.jobId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">{decision.who}</div>
          <div className="ask">{decision.question}</div>
        </div>
      </div>
      <textarea
        className="seal-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("seal.answerPlaceholder")}
      />
      <div className="seal-actions">
        <button type="button" className="btn btn-accept" disabled={!text.trim()} onClick={() => onAnswer(decision.id, text)}>
          {t("seal.submitAnswer")}
        </button>
      </div>
    </div>
  );
}

/** 工单交付：验收 / 打回都在印章完成（E3：两条路合一，不再为打回跳全屏审查台；审查台降级为查看页） */
export function AcceptSeal({
  job,
  onAccept,
  onReject,
  onOpenReview,
}: {
  job: DeskJob;
  onAccept: () => void;
  onReject: (reason: { what: string; expect: string; deadline: string }) => void;
  onOpenReview?: () => void;
}) {
  const t = useT();
  const [rejecting, setRejecting] = useState(false);
  // 预填她留下的打回三要素草稿：改完直接发，不从零写
  const [what, setWhat] = useState(job.rejectDraft?.what ?? "");
  const [expect, setExpect] = useState(job.rejectDraft?.expect ?? "");
  const [deadline, setDeadline] = useState(job.rejectDraft?.deadline ?? "15 分钟");
  const canReject = what.trim() !== "" && expect.trim() !== "" && deadline.trim() !== "";
  return (
    <div className="sealcard">
      <SealHead k={t("seal.acceptHead")} id={job.id} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{job.member ?? t("seal.member")}</b> {t("seal.submitted")}
            {job.at ? ` · ${fmtTime(job.at)}` : ""}
          </div>
          <div className="ask">{job.title}</div>
        </div>
      </div>
      <SealChecks
        checks={job.evidence.filter((e) => e.verified).map((e) => ({ ok: true, text: e.title }))}
        label={t("seal.verifiedEvidence")}
      />
      {rejecting ? (
        <div className="seal-reject">
          {[
            { k: t("seal.rejectWhat"), v: what, set: setWhat, ph: t("seal.rejectWhatPh"), rows: 2 },
            { k: t("seal.rejectExpect"), v: expect, set: setExpect, ph: t("seal.rejectExpectPh"), rows: 2 },
            { k: t("seal.rejectDeadline"), v: deadline, set: setDeadline, ph: t("seal.rejectDeadlinePh"), rows: 1 },
          ].map((f) => (
            <label className="seal-field" key={f.k}>
              <span>{f.k}</span>
              <textarea
                className="seal-input"
                value={f.v}
                rows={f.rows}
                onChange={(e) => f.set(e.target.value)}
                placeholder={f.ph}
              />
            </label>
          ))}
          <div className="seal-actions">
            <button
              type="button"
              className="btn btn-reject"
              disabled={!canReject}
              onClick={() => onReject({ what: what.trim(), expect: expect.trim(), deadline: deadline.trim() })}
            >
              <Icon name="undo" size="sm" /> {t("seal.rejectGo")}
            </button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="seal-actions">
          <button type="button" className="btn btn-accept" onClick={onAccept}>
            <Icon name="check" size="sm" /> {t("seal.accept")}
          </button>
          <button type="button" className="btn btn-reject" onClick={() => setRejecting(true)}>
            <Icon name="undo" size="sm" /> {t("seal.rejectRedo")}
          </button>
        </div>
      )}
      {onOpenReview && !rejecting && (
        <button type="button" className="seal-review-link" onClick={onOpenReview}>
          {t("seal.openReview")}
        </button>
      )}
      <div className="rounds">
        <span>{t("seal.rounds")}</span>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`sq${i < job.rejections ? " on" : ""}`} />
        ))}
        <span className="rounds-note">
          {job.rejections >= job.rejectLimit
            ? t("seal.roundsFull")
            : t("seal.roundsUsed", { a: job.rejections, b: job.rejectLimit })}
        </span>
      </div>
    </div>
  );
}

/**
 * 卡住（blocked）：她连续两个节点没交新证据。
 * 这里不能出现"验收归档"——没有交付物，收下就是在没有证据的情况下把单推成 done。
 */
export function BlockedSeal({ job }: { job: DeskJob }) {
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.blockedHead")} id={job.id} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{job.member ?? t("seal.member")}</b>
            {job.at ? ` · ${fmtTime(job.at)}` : ""}
          </div>
          <div className="ask">{t("seal.blockedBody")}</div>
          {/* 真实成因（用户手动停机 / 没交回报 / 打回 3 轮 / 进程重启对账）由工单记录提供 */}
          {job.statusNote && <div className="ask ask-sub">{job.statusNote}</div>}
        </div>
      </div>
      <div className="rounds">
        <span className="rounds-note">{t("seal.blockedNote")}</span>
      </div>
    </div>
  );
}

export function SealGlyph({ big }: { big?: boolean }) {
  const c = "var(--seal)";
  return (
    <div className="seal-glyph" style={big ? { width: 84, height: 84 } : undefined}>
      <svg viewBox="0 0 100 100">
        <g transform="rotate(-7 50 50)" opacity="0.92">
          <rect x="6" y="6" width="88" height="88" rx="5" fill="none" stroke={c} strokeWidth="5.5" />
          <rect x="13" y="13" width="74" height="74" rx="3" fill="none" stroke={c} strokeWidth="1.3" opacity="0.65" />
          {[
            ["等", 33, 43],
            ["你", 67, 43],
            ["拍", 33, 79],
            ["板", 67, 79],
          ].map(([t, x, y]) => (
            <text
              key={t as string}
              x={x as number}
              y={y as number}
              textAnchor="middle"
              fontFamily="Noto Sans SC, sans-serif"
              fontSize="26"
              fontWeight="700"
              fill={c}
            >
              {t}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
