/**
 * 皮肤包规范（计划书 §2.4 / 设计规范 §3）：**纯声明式**。
 *
 * 皮肤只声明「用哪个内置动效器 + 参数」以及允许覆盖的语义 Token，
 * **不允许携带任何可执行脚本**（v0.2 的"动效脚本声明"是安全漏洞，已删除）。
 *
 * 与主题的关系：主题定语义色；皮肤在主题之上微调同一批 Token，
 * 且**不能新增 Token、不能改名**，否则换肤会破坏四功能色语义。
 *
 * ## 2026-11-18：令牌白名单随设计系统一起扩了
 *
 * 设计系统重建后，tokens.css 里多了几组此前不存在的令牌（间距/行高/圆角/
 * 层级/阴影/图标尺寸）。它们**必须**能被主题插件覆盖，否则"换一套主题"
 * 只能换颜色、换不了节奏——那等于主题插件的能力被设计系统限制死了。
 *
 * 但放开也有边界，所以分成两张表：
 *
 *   SKIN_TOKEN_KEYS  颜色（皮肤可覆盖：换肤就是换色）
 *   THEME_TOKEN_KEYS 颜色 + 几何（主题可覆盖：换主题是换整套观感）
 *
 * 皮肤包（.lynnskin）仍然只动颜色 —— 一个皮肤不该改变布局节奏，
 * 那会让用户"换个皮肤，界面全乱"。
 */

/** 颜色令牌：皮肤与主题都可以覆盖 */
export const SKIN_TOKEN_KEYS = [
  "--desk",
  "--desk-2",
  "--desk-3",
  "--read",
  "--sheet",
  "--sheet-2",
  "--sheet-3",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--ink-4",
  "--blue",
  "--blue-2",
  "--blue-text",
  "--blue-hover",
  "--blue-wash",
  "--blue-line",
  "--seal",
  "--seal-text",
  "--seal-hover",
  "--seal-wash",
  "--red",
  "--red-text",
  "--red-wash",
  "--brass",
  "--brass-text",
  "--brass-wash",
  "--rule",
  "--rule-soft",
  "--hover-bg",
  "--hover-bg-2",
  "--on-accent",
  "--edge",
  "--scroll-thumb",
  "--scroll-thumb-hover",
] as const;

/**
 * 几何令牌：只有主题可以覆盖（皮肤不行）。
 *
 * 为什么分开：皮肤是"同一套骨架换颜色"，改间距会让原本对齐的栅格错位；
 * 主题是"整套观感"，紧凑/宽松本来就是主题差异的一部分。
 */
export const THEME_GEOMETRY_KEYS = [
  // 圆角
  "--r-xs",
  "--r-s",
  "--r-m",
  "--r-l",
  "--r-xl",
  "--r-pill",
  // 间距
  "--sp-0",
  "--sp-1",
  "--sp-2",
  "--sp-3",
  "--sp-4",
  "--sp-5",
  "--sp-6",
  "--sp-7",
  "--sp-8",
  "--sp-9",
  "--sp-10",
  "--sp-11",
  "--sp-12",
  "--sp-13",
  // 行高
  "--lh-none",
  "--lh-tight",
  "--lh-snug",
  "--lh-normal",
  "--lh-relaxed",
  // 字号
  "--fs-label",
  "--fs-meta",
  "--fs-body",
  "--fs-body-lg",
  "--fs-section",
  "--fs-brand",
  "--fs-title",
  "--fs-head",
  // 控件高度与图标尺寸
  "--h-row",
  "--h-ctl",
  "--h-ctl-lg",
  "--ic-xs",
  "--ic-sm",
  "--ic-md",
  "--ic-lg",
  "--ic-xl",
  // 层级
  "--z-sticky",
  "--z-rail",
  "--z-drawer",
  "--z-pop",
  "--z-menu",
  "--z-modal",
  "--z-toast",
] as const;

/** 主题可覆盖的全部令牌 = 颜色 + 几何 */
export const THEME_TOKEN_KEYS = [...SKIN_TOKEN_KEYS, ...THEME_GEOMETRY_KEYS] as const;

export type SkinTokenKey = (typeof SKIN_TOKEN_KEYS)[number];
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

export type SkinMotionKind = "none" | "ripple" | "wind" | "ink";

export interface SkinPack {
  kind: "lynnskin";
  version: 1;
  id: string;
  name: string;
  /** 基于哪套主题（只影响默认值，不改语义） */
  base: "night" | "paper" | "celadon";
  motion: { kind: SkinMotionKind; speed: number; opacity: number };
  /** 允许覆盖的语义 Token 子集（只有颜色） */
  tokens?: Partial<Record<SkinTokenKey, string>>;
}

export interface SkinCheck {
  ok: boolean;
  issues: string[];
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;
/** 不允许出现的可执行/外联字段 */
const FORBIDDEN = ["script", "js", "eval", "function", "onload", "onclick", "url(", "http://", "https://"];

/** 颜色值：hex 或 rgb/rgba（令牌表里只有颜色，几何值由主题独占） */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/;
/** 几何值：px / 数字 / 百分比 / 单位倍数（行高）。一律不带函数调用。 */
const GEOMETRY_RE = /^(\d+(\.\d+)?(px|%|em|rem)?|\d*\.\d+)$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function checkSkin(raw: unknown): SkinCheck {
  const issues: string[] = [];
  if (!isObj(raw)) return { ok: false, issues: ["skin 必须是对象"] };

  const text = JSON.stringify(raw).toLowerCase();
  for (const f of FORBIDDEN) {
    if (text.includes(f)) issues.push(`皮肤包不允许出现 "${f}"（纯声明式，无脚本、无外联）`);
  }

  if (raw.kind !== "lynnskin") issues.push("kind 必须是 lynnskin");
  if (raw.version !== 1) issues.push("version 必须是 1");
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) issues.push("id 必须是反向域名格式");
  if (typeof raw.name !== "string" || !raw.name.trim()) issues.push("name 必填");
  if (!["night", "paper", "celadon"].includes(String(raw.base))) issues.push("base 必须是 night / paper / celadon");

  const motion = raw.motion;
  if (!isObj(motion)) {
    issues.push("motion 必填（只声明内置动效器与参数）");
  } else {
    if (!["none", "ripple", "wind", "ink"].includes(String(motion.kind))) {
      issues.push("motion.kind 必须是 none / ripple / wind / ink（只能是内置动效器）");
    }
    if (typeof motion.speed !== "number" || motion.speed < 0 || motion.speed > 3) issues.push("motion.speed 必须在 0–3");
    if (typeof motion.opacity !== "number" || motion.opacity < 0 || motion.opacity > 1) {
      issues.push("motion.opacity 必须在 0–1");
    }
  }

  if (raw.tokens !== undefined) {
    if (!isObj(raw.tokens)) {
      issues.push("tokens 必须是对象");
    } else {
      for (const [k, v] of Object.entries(raw.tokens)) {
        if (!(SKIN_TOKEN_KEYS as readonly string[]).includes(k)) {
          issues.push(`tokens.${k} 不是允许覆盖的语义 Token（皮肤只能改颜色，不能新增/改名/改几何）`);
        }
        if (typeof v !== "string" || !COLOR_RE.test(v.trim())) {
          issues.push(`tokens.${k} 必须是颜色值（hex 或 rgb/rgba）`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 皮肤 → CSS 变量覆盖（只返回白名单内的 Token） */
export function skinCssVars(skin: SkinPack): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(skin.tokens ?? {})) {
    if ((SKIN_TOKEN_KEYS as readonly string[]).includes(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 主题文件（plugin.json 的 contributes.theme）里的 Token 校验。
 *
 * 与皮肤的区别：主题可以覆盖几何令牌（间距/圆角/字号/行高/层级），
 * 因为"紧凑 vs 宽松"本来就是主题差异的一部分；但仍然不能新增或改名。
 *
 * @returns 每个键的错误说明；空数组 = 全部合法
 */
export function checkThemeTokens(
  tokens: Record<string, unknown>,
  mode: string,
): { issues: string[]; values: Record<string, string> } {
  const issues: string[] = [];
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    const isColor = (SKIN_TOKEN_KEYS as readonly string[]).includes(k);
    const isGeometry = (THEME_GEOMETRY_KEYS as readonly string[]).includes(k);
    if (!isColor && !isGeometry) {
      issues.push(`${mode}.${k} 不是允许覆盖的语义 Token（不能新增/改名）`);
      continue;
    }
    if (typeof v !== "string") {
      issues.push(`${mode}.${k} 必须是字符串`);
      continue;
    }
    const val = v.trim();
    if (isColor && !COLOR_RE.test(val)) {
      issues.push(`${mode}.${k} 必须是颜色值（hex 或 rgb/rgba）`);
      continue;
    }
    if (isGeometry && !GEOMETRY_RE.test(val)) {
      issues.push(`${mode}.${k} 必须是几何值（px / 数字 / %，不许函数调用）`);
      continue;
    }
    values[k] = val;
  }
  return { issues, values };
}
