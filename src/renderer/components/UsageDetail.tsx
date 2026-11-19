// 用量明细（2026-11-15）：顶栏用量计与输入框明细弹层共用的纯展示块。
// 只吃 UsageView + 可选 budget，不持有任何交互；口径由后端算，前端不估。
//
// 2026-11-19 修正（用户实机质疑"这统计对吗"）：
//  ① 「输入·计费」原来显示 sessionIn（只含未命中），少报 5.4 倍 → 改成"输入合计"，
//     并在下面单列"其中缓存命中"。
//  ② 缓存写入 0 但命中 > 0 = 渠道不回报，显示「—」而不是「0」（0 是"确定没写"的语义）。
//  ③ 上下文百分比与 token 必须同源：原来一个是 SDK 算的、一个是我们自accumulate的，
//     实机出现「4% · 44.7K」（44.7K/128K 其实是 35%）这种自相矛盾。
import { useT } from "../i18n";
import { fmtTokens } from "../desk/model";
import {
  cacheHitRate,
  cacheWriteUnknown,
  contextUsage,
  totalPromptInput,
  type UsageView,
} from "../../shared/contract";

export function UsageDetail({
  usage,
  budget,
}: {
  usage: UsageView;
  budget?: { spent: number; soft: number };
}) {
  const t = useT();
  const rate = cacheHitRate(usage);
  const totalIn = totalPromptInput(usage);
  const writeUnknown = cacheWriteUnknown(usage);
  const ctx = contextUsage(usage);
  const hasData =
    usage.sessionIn + usage.sessionOut + usage.cacheRead + usage.cacheWrite + (usage.contextTokens ?? 0) > 0;
  if (!hasData) {
    return <div className="usage-detail-empty">{t("usage.none")}</div>;
  }
  return (
    <div className="usage-detail">
      {/* 输入合计 = 新输入 + 缓存读 + 缓存写。这是"喂进模型多少 token"的正确答案。 */}
      <div className="usage-detail-row">
        <span className="uk">{t("usage.inputTotal")}</span>
        <span className="uv mono">{fmtTokens(totalIn)}</span>
      </div>
      {usage.cacheRead > 0 && (
        <div className="usage-detail-row usage-detail-sub">
          <span className="uk">{t("usage.ofWhichCache")}</span>
          <span className="uv mono">{fmtTokens(usage.cacheRead)}</span>
        </div>
      )}
      {usage.sessionIn > 0 && (
        <div className="usage-detail-row usage-detail-sub">
          <span className="uk">{t("usage.ofWhichNew")}</span>
          <span className="uv mono">{fmtTokens(usage.sessionIn)}</span>
        </div>
      )}
      <div className="usage-detail-row">
        <span className="uk">{t("usage.cacheWrite")}</span>
        <span className="uv mono" title={writeUnknown ? t("usage.cacheWriteUnknownHint") : undefined}>
          {writeUnknown ? "—" : fmtTokens(usage.cacheWrite)}
        </span>
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
          {ctx.percent == null ? "—" : `${Math.round(ctx.percent)}%`}
          {ctx.tokens != null ? ` · ${ctx.estimated ? "≈" : ""}${fmtTokens(ctx.tokens)}` : ""}
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
