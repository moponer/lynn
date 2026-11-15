// 用量明细（2026-11-15）：顶栏用量计与输入框明细弹层共用的纯展示块。
// 只吃 UsageView + 可选 budget，不持有任何交互；口径由后端算，前端不估。
import { useT } from "../i18n";
import { fmtTokens } from "../desk/model";
import { cacheHitRate, type UsageView } from "../../shared/contract";

export function UsageDetail({
  usage,
  budget,
}: {
  usage: UsageView;
  budget?: { spent: number; soft: number };
}) {
  const t = useT();
  const rate = cacheHitRate(usage);
  const ctxPct = usage.contextPercent;
  const hasData =
    usage.sessionIn + usage.sessionOut + usage.cacheRead + usage.cacheWrite + (usage.contextTokens ?? 0) > 0;
  if (!hasData) {
    return <div className="usage-detail-empty">{t("usage.none")}</div>;
  }
  return (
    <div className="usage-detail">
      <div className="usage-detail-row">
        <span className="uk">{t("usage.input")}</span>
        <span className="uv mono">{fmtTokens(usage.sessionIn)}</span>
      </div>
      <div className="usage-detail-row">
        <span className="uk">{t("usage.cacheRead")}</span>
        <span className="uv mono">{fmtTokens(usage.cacheRead)}</span>
      </div>
      <div className="usage-detail-row">
        <span className="uk">{t("usage.cacheWrite")}</span>
        <span className="uv mono">{fmtTokens(usage.cacheWrite)}</span>
      </div>
      <div className="usage-detail-row">
        <span className="uk">{t("usage.output")}</span>
        <span className="uv mono">{fmtTokens(usage.sessionOut)}</span>
      </div>
      <div className="usage-detail-rule" />
      <div className="usage-detail-row">
        <span className="uk">{t("usage.hit")}</span>
        <span className="uv mono">{rate === undefined ? "—" : `${rate.toFixed(0)}%`}</span>
      </div>
      <div className="usage-detail-row">
        <span className="uk">{t("usage.context")}</span>
        <span className="uv mono">
          {ctxPct == null ? "—" : `${Math.round(ctxPct)}%`}
          {usage.contextWindow > 0 ? ` · ${fmtTokens(usage.contextTokens)}` : ""}
        </span>
      </div>
      {usage.cost > 0 && (
        <div className="usage-detail-row">
          <span className="uk">{t("usage.cost")}</span>
          <span className="uv mono">${usage.cost.toFixed(4)}</span>
        </div>
      )}
      {budget && budget.soft > 0 && (
        <div className="usage-detail-row">
          <span className="uk">{t("usage.budget")}</span>
          <span className={`uv mono${budget.spent >= budget.soft ? " over" : ""}`}>
            {fmtTokens(budget.spent)} / {fmtTokens(budget.soft)}
          </span>
        </div>
      )}
    </div>
  );
}
