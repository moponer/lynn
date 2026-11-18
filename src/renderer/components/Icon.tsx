/**
 * 图标一律内联 SVG（设计规范：图标内联，不引图标库）。
 * 取自制图室设计稿的 sprite，路径与设计稿逐条对应。
 */

/**
 * 图标路径表。
 *
 * 2026-11-18：从 `Record<string, string>` 改成 `as const`。
 *
 * 为什么这一行很关键：`Record<string, string>` 让 `keyof typeof PATHS`
 * 退化成 `string` —— 于是 `IconName` 等于没有任何约束，写 `name="home"`
 * 而表里没有 home 时，TS 不会报错，运行时渲染出一个空 `<g>`。
 * 实测设置页导航的「概览」「模型」两项就是这样丢了图标（空白占位）。
 *
 * 改法：去掉宽泛注解、末尾 `as const`，让 key 保留字面量类型。
 * 现在拼错图标名是**编译期错误**，并且 lint:design 会再兜一层。
 */
const PATHS = {
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M12 2v2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  diff: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6M20 6a8 8 0 0 0-8 8"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  term: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  clip: '<path d="M20 11.5 12.3 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>',
  check: '<path d="m4 12 5.5 5.5L20 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  restore: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M5 16V6a1 1 0 0 1 1-1h10"/>',
  warn: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  users: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9"/>',
  pkg: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  shield: '<path d="M12 2 4 5.5v6c0 5 3.4 9.4 8 10.5 4.6-1.1 8-5.5 8-10.5v-6z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  cube: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 22V12"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 4 3h1V3Z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-4 3h-1V3Z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.3-6.4L3 9"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pen: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  pin: '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8.5v5.5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.5 7.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  file: '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  megaphone: '<path d="M3 11v2l11 4V7L3 11z"/><path d="M14 7v10"/><path d="M17 9a3 3 0 0 1 0 6"/>',
  gauge: '<path d="M3 13a9 9 0 0 1 18 0"/><path d="M12 13l4-4"/>',

  /* ---- 2026-11-18 补齐：此前 nav 引用了 home / cpu 但表里没有 ---- */
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-5.5h5V20"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',

  /* ---- 语义补齐：把"用文字当图标"的地方收回来 ---- */
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  "chev-right": '<path d="m9 6 6 6-6 6"/>',
  "chev-left": '<path d="m15 6-6 6 6 6"/>',
  "chev-up": '<path d="m6 15 6-6 6 6"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5 17.5 9.5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  power: '<path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2.5"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>',
  upload: '<path d="M12 20V9M7.5 13.5 12 9l4.5 4.5"/><path d="M5 5h14"/>',
  sort: '<path d="M8 5v14M5 8l3-3 3 3"/><path d="M16 19V5M13 16l3 3 3-3"/>',
} as const;

/**
 * 图标名：从 PATHS 的字面量键派生（不是 string）。
 * 拼错名字 → 编译期报错，而不是渲染出一个空 <g>。
 */
export type IconName = keyof typeof PATHS;

/**
 * 尺寸档：五档，与 tokens.css 的 --ic-* 一一对应。
 *
 * 2026-11-18 之前只有 sm / lg 两档，另有 12/13/14 的局部 CSS 覆盖，
 * 同一个 24 网格图标出现在 5 个互不相关的尺寸上。
 */
export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * 内联 SVG 图标。
 *
 * 两条不可变的约束：
 *  1) **内联**，不引图标库（离线可用是硬约束）；
 *  2) `aria-hidden`：图标永远是装饰，语义由外层按钮/文字的 aria-label 承担。
 *     纯图标按钮必须自带 aria-label（lint:design 会拦）。
 */
export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  size?: IconSize;
  /** 额外的类名（例如需要旋转的箭头） */
  className?: string;
}) {
  const cls = ["ic", size && size !== "md" ? size : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
    </svg>
  );
}
