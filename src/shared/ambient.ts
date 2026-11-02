/**
 * 动效层（计划书 §2.4 / 设计规范 §2.1）—— 纯逻辑部分。
 *
 * 三条硬规则：
 *  1. 皮肤只声明"用哪个内置动效器 + 参数"，**不允许带可执行脚本**（L0 声明式）；
 *  2. 一切动效必须表达状态；无状态时不产生 RAF 循环（挂起渲染）；
 *  3. 提供省电档：低配 / 关闭；`prefers-reduced-motion` 一律不动。
 */

export type AmbientKind = "none" | "ripple" | "wind" | "ink";
export type AmbientMode = "full" | "low" | "off";

export interface AmbientParams {
  kind: AmbientKind;
  /** 相对速度，1 = 标准 */
  speed: number;
  /** 透明度上限（避免糊住内容） */
  opacity: number;
}

/** 皮肤 = 主题 Token + 动效声明（三套官方主题各一个内置动效器） */
export const THEME_AMBIENT: Record<string, AmbientParams> = {
  night: { kind: "ripple", speed: 1, opacity: 0.5 },
  paper: { kind: "ink", speed: 0.7, opacity: 0.35 },
  celadon: { kind: "wind", speed: 0.9, opacity: 0.45 },
};

export const AMBIENT_MODE_LABEL: Record<AmbientMode, string> = {
  full: "全开",
  low: "低配",
  off: "关闭",
};

export interface AmbientContext {
  mode: AmbientMode;
  standby: boolean;
  reducedMotion: boolean;
  windowHidden: boolean;
}

/**
 * 两帧之间的间隔（毫秒）；返回 `null` 表示**不要起 RAF**。
 *
 * 待机时降帧（5–10fps），窗口不可见或省电关闭时停帧 —— 这三条是 GPU 红线的实现基础。
 */
export function frameInterval(ctx: AmbientContext): number | null {
  if (ctx.mode === "off") return null;
  if (ctx.reducedMotion) return null;
  if (ctx.windowHidden) return null;
  if (ctx.standby) return ctx.mode === "low" ? 200 : 100; // 5fps / 10fps
  return ctx.mode === "low" ? 1000 / 15 : 1000 / 30;
}

/** 动效在什么时候完全不画（省电/无障碍/窗口不可见） */
export function shouldRender(kind: AmbientKind, ctx: AmbientContext): boolean {
  if (kind === "none") return false;
  return frameInterval(ctx) !== null;
}

/** 主题 → 动效声明；未知主题退回 none（不猜） */
export function ambientForTheme(themeId: string): AmbientParams {
  return THEME_AMBIENT[themeId] ?? { kind: "none", speed: 0, opacity: 0 };
}
