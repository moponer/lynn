// 用量计（2026-11-15）：顶栏与输入框共用的「缓存 + token 消耗」入口。
// 一行紧凑读数（累计 token / 缓存命中% / 上下文%），点开是明细弹层（UsageDetail）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { fmtTokens } from "../desk/model";
import { cacheHitRate, type UsageView } from "../../shared/contract";
import { UsageDetail } from "./UsageDetail";

export function UsageMeter({
  usage,
  budget,
  tokensUsed,
  side = "bottom",
}: {
  usage: UsageView;
  budget?: { spent: number; soft: number };
  /** 顶栏的 tokensUsed 是会话累计（与明细里的输入+输出同源）；不给就退回明细的合计 */
  tokensUsed?: number;
  /** 弹层从按钮哪边展开：顶栏在下、输入框在上 */
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const t = useT();
  const rate = cacheHitRate(usage);
  const ctxPct = usage.contextPercent;
  const total = usage.sessionIn + usage.sessionOut;
  const over = budget ? budget.spent >= budget.soft : false;

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 252);
    const top = side === "top" ? r.top - 8 : r.bottom + 8;
    setPos({ top, left });
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tg = e.target as Node;
      if (btnRef.current?.contains(tg) || popRef.current?.contains(tg)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const title =
    rate === undefined
      ? t("top.contextTitle", {
          used: usage.contextTokens,
          total: usage.contextWindow,
          tokens: fmtTokens(total),
        })
      : t("usage.meterTitle", { tokens: fmtTokens(total), rate: rate.toFixed(0) });

  return (
    <div className={`usage-meter${over ? " over" : ""}`}>
      <button
        type="button"
        className="usage-meter-btn"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-expanded={open}
      >
        <Icon name="gauge" size="sm" />
        <span className="um-tokens mono">{tokensUsed != null ? fmtTokens(tokensUsed) : fmtTokens(total)}</span>
        {rate !== undefined && <span className="um-cache">{rate.toFixed(0)}%</span>}
        {ctxPct != null && <span className="um-ctx">{Math.round(ctxPct)}%</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`usage-pop side-${side}`}
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
          >
            <div className="usage-pop-head">{t("usage.title")}</div>
            <UsageDetail usage={usage} budget={budget} />
          </div>,
          document.body,
        )}
    </div>
  );
}
