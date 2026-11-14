// 审查台（2026-11-14）：从 Desk.tsx 拆出。装配函数 toReviewCase 与用例类型一起搬过来。
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtTime } from "./model";
import type { Desk, DeskJob, OpenPreview } from "./model";
import { SealGlyph } from "./Seals";
import { TopRail } from "./TopRail";

export function ReviewDesk({
  desk,
  job,
  onBack,
  onApprove,
  onReject,
  onPreview,
}: {
  desk: Desk;
  job: DeskJob;
  onBack: () => void;
  onApprove: () => void;
  onReject: (reason: { what: string; expect: string; deadline: string }) => void;
  onPreview?: OpenPreview;
}) {
  const r = reviewOf(job);
  const [what, setWhat] = useState(r.reject.what);
  const [expect, setExpect] = useState(r.reject.expect);
  const [deadline, setDeadline] = useState(r.reject.deadline);
  const [sent, setSent] = useState(false);
  const t = useT();

  // Esc = 返回值台（审查台唯一的深页面，必须有键盘出口）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const ac = r.ac;
  const canReject = what.trim() !== "" && expect.trim() !== "" && deadline.trim() !== "";

  return (
    <div className="scene">
      <TopRail
        desk={desk}
        permission="ask"
        onPermission={() => {}}
        onOpenSettings={() => {}}
        mode="review"
        onBack={onBack}
      />
      <div className="body">
        <aside className="ledger" style={{ width: 230 }}>
          <div className="ledger-head">
            <span className="h-cap">验收包</span>
            <span className="h-count">
              {job.id} · v{job.version}
            </span>
          </div>
          <div className="ledger-scroll" style={{ paddingTop: 4 }}>
            <div className="grp-label" style={{ paddingTop: 8 }}>
              成员
            </div>
            <div className="job on">
              <div className="job-top">
                <span className="job-id">交付人</span>
                <span className="st st-wait">{job.action === "none" ? "风铃在验" : "等你拍板"}</span>
              </div>
              <div className="job-title">
                {job.member ?? "风铃"} · {job.memberRole ?? "调度"}
              </div>
              <div className="job-meta">
                <span className="mono">{fmtTime(job.at)}</span>
              </div>
            </div>

            <div className="grp-label">验收标准 · {ac.length}</div>
            {ac.map((c, i) => (
              <div className="job" key={i}>
                <div className="job-top">
                  <span className="job-id">AC-{i + 1}</span>
                  <span className={`st ${c.ok ? "st-done" : "st-wait"}`}>{c.ok ? "满足" : "存疑"}</span>
                </div>
                <div className="job-title">{c.text}</div>
              </div>
            ))}

            {job.artifact && (
              <>
                <div className="grp-label">产物 · 1</div>
                <div className="job">
                  <div className="job-top">
                    <span className="job-id">FILE</span>
                    <span className="st st-done">已入库</span>
                  </div>
                  <div className="job-title">{job.artifact.name}</div>
                </div>
              </>
            )}

            <div className="grp-label">简报包 · {job.member ?? "成员"}收到的</div>
            <div className="job">
              <div className="job-top">
                <span className="job-id">BRIEF</span>
                <span className="st st-done">已投递</span>
              </div>
              <div className="job-title">{job.statusNote}</div>
            </div>

            {/* 次要出口：主出口在顶栏「返回值台」+ Esc；这里不再用斜体空态样式伪装 */}
            <div className="grp-label" style={{ paddingTop: 10 }}>
              <a onClick={onBack} style={{ color: "var(--blue)", cursor: "pointer" }}>
                ← {t("top.back")}
              </a>
            </div>
          </div>
        </aside>

        <main className="center">
          <div className="sheet-wrap">
            <div className="sheet">
              <div className="sheet-head">
                <div className="sheet-eyebrow">
                  <span>验收包 · {job.id}</span>
                  <span style={{ opacity: 0.4 }}>/</span>
                  <span>提交于 {fmtTime(job.at)}</span>
                  <span style={{ opacity: 0.4 }}>/</span>
                  <span>无证据不算完成</span>
                </div>
                <h1 className="sheet-title">{job.title}</h1>
                <div className="sheet-sub">{job.statusNote}</div>
              </div>

              <div className="sheet-body">
                <div className="work" style={{ paddingTop: 16 }}>
                  <div className="rev-pair">
                      <div>
                        <div className="h-cap" style={{ marginBottom: 8 }}>
                          {r.product.title}
                        </div>
                        <div className="diff" style={{ marginTop: 0 }}>
                          <div className="f">
                            <span className="s">{r.product.note.split("　")[0]}</span>
                            <span>{r.product.note.split("　")[1] ?? ""}</span>
                          </div>
                          {r.product.lines.map((l, i) => (
                            <div key={i} className="l">
                              <span className="ln">{l.no}</span>
                              {l.text}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="h-cap" style={{ marginBottom: 8 }}>
                          {r.source.title}
                        </div>
                        <div className="diff" style={{ marginTop: 0 }}>
                          <div className="f">
                            <span className="s">{r.source.note.split("　")[0]}</span>
                            <span>{r.source.note.split("　")[1] ?? ""}</span>
                          </div>
                          {r.source.lines.map((l, i) => (
                            <div key={i} className="l">
                              <span className="ln">{l.no}</span>
                              {l.text}
                            </div>
                          ))}
                        </div>
                      </div>
                  </div>



                  <div className="artifact" style={{ maxWidth: 660 }}>
                    <div className="artifact-h">
                      <Icon name="pen" size="sm" />
                      <span>打回必须写清</span>
                      <span className="nm">风铃已替你填好，改完直接发</span>
                    </div>
                    <div className="art-table">
                      {[
                        { k: "哪里不合格", v: what, set: setWhat, ph: "填：哪里不合格（不带理由的打回算她的失职）" },
                        { k: "期望是什么", v: expect, set: setExpect, ph: "填：期望怎么改、补什么" },
                        { k: "多久内重交", v: deadline, set: setDeadline, ph: "如 15 分钟" },
                      ].map((f) => (
                        <div className="art-row rev-row" key={f.k}>
                          <span className="no rev-k">{f.k}</span>
                          <textarea
                            className="rev-field"
                            value={f.v}
                            onChange={(e) => f.set(e.target.value)}
                            placeholder={f.ph}
                            rows={f.k === "多久内重交" ? 1 : 2}
                          />
                        </div>
                      ))}
                      <div className="art-foot">
                        <span>不带理由的打回，算她的失职</span>
                        <span style={{ marginLeft: "auto" }}>这一轮是第 {job.rejections + 1} 次打回</span>
                      </div>
                    </div>
                  </div>
                </div>

              </div>

            </div>
          </div>

        </main>

        <aside className="right" style={{ width: 360 }}>
          <div className="right-scroll">
            <div className="panel-h">
              <div className="l">
                <span className="t">{job.action === "none" ? "风铃在验" : "你的裁定"}</span>
                <span className="n">{job.id}</span>
              </div>
              <span className="cap">
                第 {job.rejections + 1} 轮 / 共 {job.rejectLimit} 轮
              </span>
            </div>

            <div className="sealcard" style={{ marginTop: 2 }}>
              <div className="sealcard-h">
                <span className="k">{job.action === "none" ? "这张单不占你的待办" : "等你拍板"}</span>
                <span className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--ink-4)" }}>
                  {fmtTime(job.at)}
                </span>
              </div>
              <div className="sealcard-body">
                <SealGlyph big />
                <div className="sealcard-text">
                  <div className="who">
                    <b>{job.member ?? "风铃"}</b> 提交 · {job.memberRole ?? "调度"}
                  </div>
                  <div className="ask">这份交付能不能收？</div>
                </div>
              </div>

              {ac.length > 0 && (
                <div className="accept">
                  <div className="k">她已核对 · {ac.length} 项验收标准</div>
                  <ul>
                    {ac.map((c, i) => {
                      const ref = job.evidence[i]?.ref;
                      return (
                        <li key={i} className={c.ok ? "ok" : "bad"}>
                          <button
                            type="button"
                            className="ac-link"
                            disabled={!ref}
                            title={ref ? `打开 ${ref}` : "这项没有可打开的文件"}
                            onClick={() => {
                              if (ref) onPreview?.(job.id, ref);
                            }}
                          >
                            <Icon name={c.ok ? "check" : "warn"} size="sm" />
                            <span>{c.text}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="seal-actions" style={{ flexDirection: "column" }}>
                <button type="button" className="btn btn-accept" onClick={onApprove}>
                  <Icon name="check" size="sm" /> 验收归档
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
                  disabled={!canReject}
                  style={{ justifyContent: "space-between", padding: "8px 12px" }}
                  onClick={() => {
                    if (!canReject) return;
                    setSent(true);
                    onReject({ what: what.trim(), expect: expect.trim(), deadline: deadline.trim() });
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="undo" size="sm" /> 打回重做
                  </span>
                  <span className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--ink-3)" }}>
                    {canReject ? "理由已填好" : "三要素必填"}
                  </span>
                </button>
              </div>

              <div className="rounds">
                <span>打回轮次</span>
                {Array.from({ length: job.rejectLimit }, (_, i) => (
                  <span key={i} className={`sq${i < job.rejections ? " on" : ""}`} />
                ))}
                <span style={{ marginLeft: "auto" }}>连打 {job.rejectLimit} 轮未过，她会来问你</span>
              </div>
            </div>

            {sent && <div className="sf-result ok" style={{ margin: "0 0 12px" }}>已打回：理由已记入卷宗。</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 把真实工单装配成审查台需要的形状（没有的字段就留空，不编造内容） */
export function reviewOf(job: DeskJob) {
  const ev = job.evidence.filter((e) => e.level !== "pending");
  return {
    product: {
      title: `交付 · ${job.member ?? "成员"}`,
      note: `结论　${job.report?.conclusion ?? job.statusNote}`,
      lines: ev.map((e, i) => ({
        no: String(i + 1),
        text: `${e.verified ? "✓" : "?"} ${e.title} — ${e.ref ?? e.detail}`,
      })),
    },
    source: {
      title: "证据索引",
      note: `${ev.length} 项　可点开验证`,
      lines: job.evidence.map((e) => ({ no: e.verified ? "✓" : e.level === "warn" ? "!" : "—", text: e.detail })),
    },
    reject: job.rejectDraft ?? { what: "", expect: "", deadline: "15 分钟" },
    report: job.report ?? { conclusion: "", evidence: "", unfinished: "", decision: "" },
    ac: ev.map((e) => ({ ok: !!e.verified, text: e.title })),
  };
}
