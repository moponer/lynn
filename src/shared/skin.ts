/**
 * 皮肤包规范（计划书 §2.4 / 设计规范 §3）：**纯声明式**。
 *
 * 皮肤只声明「用哪个内置动效器 + 参数」以及允许覆盖的语义 Token，
 * **不允许携带任何可执行脚本**（v0.2 的"动效脚本声明"是安全漏洞，已删除）。
 *
 * 与主题的关系：主题（夜航/纸墨/青瓦）定语义色；皮肤在主题之上微调同一批 Token，
 * 且**不能新增 Token、不能改名**，否则换肤会破坏四功能色语义。
 */

export const SKIN_TOKEN_KEYS = [
  "--desk",
  "--desk-2",
  "--desk-3",
  "--sheet",
  "--sheet-2",
  "--sheet-3",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--ink-4",
  "--blue",
  "--seal",
  "--red",
  "--brass",
  "--rule",
  "--rule-soft",
] as const;

export type SkinTokenKey = (typeof SKIN_TOKEN_KEYS)[number];

export type SkinMotionKind = "none" | "ripple" | "wind" | "ink";

export interface SkinPack {
  kind: "lynnskin";
  version: 1;
  id: string;
  name: string;
  /** 基于哪套主题（只影响默认值，不改语义） */
  base: "night" | "paper" | "celadon";
  motion: { kind: SkinMotionKind; speed: number; opacity: number };
  /** 允许覆盖的语义 Token 子集 */
  tokens?: Partial<Record<SkinTokenKey, string>>;
}

export interface SkinCheck {
  ok: boolean;
  issues: string[];
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;
/** 不允许出现的可执行/外联字段 */
const FORBIDDEN = ["script", "js", "eval", "function", "onload", "onclick", "url(", "http://", "https://"];

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
          issues.push(`tokens.${k} 不是允许覆盖的语义 Token（不能新增/改名）`);
        }
        if (typeof v !== "string" || !/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/.test(v.trim())) {
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
