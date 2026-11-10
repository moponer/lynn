import type { ReactNode } from "react";
import type { SealedPhase } from "./useConsoleFeed";

/**
 * 风铃核心 + 方形军印。
 *
 * 分工：核心是一团会呼吸的动效（不是文本），回答"她还在不在、跑得多急"；
 * 军印回答"她停在哪一步"，正盖、不歪斜。两者叠在同一个 160px 台面上，
 * 印章压在核心下沿——和原型一致，不各自占一行。
 */

const LABEL: Record<SealedPhase, { cn: string; en: string; tone: "blue" | "brass" | "seal" | "quiet" }> = {
  listen: { cn: "侦听中", en: "LISTENING", tone: "quiet" },
  pick: { cn: "拆解中", en: "PARSING", tone: "brass" },
  analyze: { cn: "研判中", en: "ANALYZING", tone: "brass" },
  dispatch: { cn: "推进中", en: "DISPATCHING", tone: "blue" },
  decide: { cn: "待你拍板", en: "AWAITING YOU", tone: "brass" },
  intervene: { cn: "需干预", en: "INTERVENE", tone: "seal" },
  done: { cn: "已交付", en: "DELIVERED", tone: "blue" },
};

/** 核心里的那一笔：静默是点，拆解是折线，研判是环，干预是十字 */
const MARK: Record<SealedPhase, ReactNode> = {
  listen: <circle cx="20" cy="20" r="3" fill="currentColor" stroke="none" />,
  pick: (
    <>
      <path d="M8 28 L20 10 L32 28" />
      <path d="M13 28 H27" />
    </>
  ),
  analyze: (
    <>
      <circle cx="20" cy="20" r="9" />
      <circle cx="20" cy="20" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  dispatch: (
    <>
      <circle cx="20" cy="20" r="9" />
      <path d="M20 4 V36" />
      <path d="M4 20 H36" />
    </>
  ),
  decide: (
    <>
      <path d="M14 15 a6 6 0 1 1 8 5 v3" />
      <circle cx="20" cy="30" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  intervene: (
    <>
      <circle cx="20" cy="20" r="9" />
      <path d="M20 8 V32" />
      <path d="M8 20 H32" />
    </>
  ),
  done: (
    <>
      <path d="M11 20 L18 27 L30 12" />
    </>
  ),
};

export function sealLabel(phase: SealedPhase): string {
  return LABEL[phase].cn;
}

export function Seal({
  phase,
  onClick,
  title,
}: {
  phase: SealedPhase;
  onClick?: () => void;
  title?: string;
}) {
  const l = LABEL[phase];
  return (
    <button
      type="button"
      className={`cs-seal tone-${l.tone}`}
      data-phase={phase}
      onClick={onClick}
      title={title ?? `${l.cn} · ${l.en}`}
      aria-label={l.cn}
    >
      <span className="s-cn">{l.cn}</span>
      <span className="s-en">{l.en}</span>
    </button>
  );
}

/** 160px 台面：光晕 / 三道环 / 扫描扇 / 核心 / 记号 / 四道射线 + 军印 */
export function LynnCore({ phase, onClick }: { phase: SealedPhase; onClick?: () => void }) {
  return (
    <div className="cs-stage" data-mode={phase}>
      <span className="cs-halo" aria-hidden="true" />
      <span className="cs-ring o" aria-hidden="true" />
      <span className="cs-ring m" aria-hidden="true" />
      <span className="cs-ring i" aria-hidden="true" />
      <span className="cs-scan" aria-hidden="true" />
      <span className="cs-core" aria-hidden="true" />
      <span className="cs-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40">{MARK[phase]}</svg>
      </span>
      <span className="cs-ray r1" aria-hidden="true" />
      <span className="cs-ray r2" aria-hidden="true" />
      <span className="cs-ray r3" aria-hidden="true" />
      <span className="cs-ray r4" aria-hidden="true" />
      <Seal phase={phase} onClick={onClick} />
    </div>
  );
}
