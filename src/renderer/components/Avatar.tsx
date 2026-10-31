/** 风铃的 SVG 形象：少女 + 发间铃铛（mock 阶段的占位形象，正式版由 U 档形象插件驱动） */
export function Avatar({ size = 42, ring = true }: { size?: number; ring?: boolean }) {
  return (
    <div className="avatar" title="风铃 · 执行中（点击出今日摘要）">
      {ring && <div className="ring" />}
      <svg viewBox="0 0 64 64" width={size} height={size}>
        <circle cx="32" cy="32" r="30" fill="#17222B" />
        <path d="M14 36 Q12 16 32 13 Q52 16 50 36 L46 34 Q47 20 32 18 Q17 20 18 34 Z" fill="#3D5A80" />
        <path d="M13 34 Q10 22 22 15 Q14 24 17 34 Z" fill="#3D5A80" />
        <path d="M51 34 Q54 22 42 15 Q50 24 47 34 Z" fill="#3D5A80" />
        <circle cx="32" cy="34" r="12" fill="#FFE0CC" />
        <path d="M20 33 Q20 19 32 18 Q44 19 44 33 Q38 28 32 29 Q26 28 20 33Z" fill="#3D5A80" />
        <circle cx="27" cy="35" r="1.6" fill="#22303A" />
        <circle cx="37" cy="35" r="1.6" fill="#22303A" />
        <path d="M29 41 Q32 43.4 35 41" stroke="#C4756B" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <circle cx="45" cy="18" r="3.4" fill="#E8B04B" />
        <circle cx="45" cy="18" r="1.2" fill="#8A6414" />
        <path d="M45 21.4 v2" stroke="#E8B04B" strokeWidth="1.4" />
      </svg>
    </div>
  );
}
