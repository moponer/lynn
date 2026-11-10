/**
 * 截图几何（主进程与选区窗共用，纯函数、无 Electron / 无 DOM）。
 * 渲染层要画标注、调选区；主进程要把原生窗口矩形与选区换算成物理像素——
 * 两边用同一份实现，避免"看起来选中了、导出来偏几像素"。
 */
import type { CaptureRect, CaptureSize, CaptureWindow } from "./contract";

export interface Point {
  x: number;
  y: number;
}

/** Electron screen.getDisplayNearestPoint 返回的 DIP 口径 */
export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

/** XCap Monitor / Window 的 x()/y()/width()/height()/scaleFactor()，物理像素口径 */
export interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const MIN_SELECTION_DIP = 4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 任意方向拖拽 + 越界钳制 → 正矩形 */
export function normalizeRect(a: Point, b: Point, view: CaptureSize): CaptureRect {
  const x1 = clamp(Math.min(a.x, b.x), 0, view.width);
  const y1 = clamp(Math.min(a.y, b.y), 0, view.height);
  const x2 = clamp(Math.max(a.x, b.x), 0, view.width);
  const y2 = clamp(Math.max(a.y, b.y), 0, view.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/**
 * DIP 选区 → 捕获图物理像素矩形。
 * 按帧/视口比例换算而非硬乘 scaleFactor：混合 DPI、取整误差都不会错位。
 */
export function toPixelRect(rect: CaptureRect, frame: CaptureSize, view: CaptureSize): CaptureRect | null {
  const nums = [rect.x, rect.y, rect.width, rect.height];
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (frame.width < 1 || frame.height < 1 || view.width < 1 || view.height < 1) return null;
  const n = normalizeRect({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, view);
  if (n.width < MIN_SELECTION_DIP || n.height < MIN_SELECTION_DIP) return null;
  const sx = frame.width / view.width;
  const sy = frame.height / view.height;
  const x = clamp(Math.floor(n.x * sx), 0, frame.width - 1);
  const y = clamp(Math.floor(n.y * sy), 0, frame.height - 1);
  const right = clamp(Math.ceil((n.x + n.width) * sx), x + 1, frame.width);
  const bottom = clamp(Math.ceil((n.y + n.height) * sy), y + 1, frame.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 多显示器 + 混合 DPI：把 XCap 的物理矩形折回 DIP，
 * 优先取包含光标的那一块；都不含时取离当前 display 中心最近的。
 */
export function pickMonitorIndex(monitors: MonitorBounds[], display: DisplayBounds, cursor: Point): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  const cx = display.x + display.width / 2;
  const cy = display.y + display.height / 2;
  for (let i = 0; i < monitors.length; i += 1) {
    const m = monitors[i];
    const sf = m.scaleFactor > 0 ? m.scaleFactor : 1;
    const bx = m.x / sf;
    const by = m.y / sf;
    const bw = m.width / sf;
    const bh = m.height / sf;
    if (bw <= 0 || bh <= 0) continue;
    const contains = cursor.x >= bx && cursor.x < bx + bw && cursor.y >= by && cursor.y < by + bh;
    const score = (contains ? 0 : 1e6) + Math.hypot(bx + bw / 2 - cx, by + bh / 2 - cy);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * 微信截图的「自动识别窗口」：把原生窗口物理矩形折成选区窗内的 DIP 矩形。
 * origin 是显示器物理原点；面积小的排前面，命中时优先选 innermost 窗口。
 */
export function windowsToDip(
  windows: WindowBounds[],
  origin: Point,
  frame: CaptureSize,
  view: CaptureSize,
  minDip = 48,
): CaptureWindow[] {
  if (frame.width < 1 || frame.height < 1 || view.width < 1 || view.height < 1) return [];
  const sx = view.width / frame.width;
  const sy = view.height / frame.height;
  return windows
    .map((w) => {
      const x1 = clamp(Math.round((w.x - origin.x) * sx), 0, view.width);
      const y1 = clamp(Math.round((w.y - origin.y) * sy), 0, view.height);
      const x2 = clamp(Math.round((w.x + w.width - origin.x) * sx), 0, view.width);
      const y2 = clamp(Math.round((w.y + w.height - origin.y) * sy), 0, view.height);
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, title: w.title || "" };
    })
    .filter((r) => r.width >= minDip && r.height >= minDip)
    .sort((a, b) => a.width * a.height - b.width * b.height)
    .slice(0, 40);
}

/** 命中包含光标的最小窗口（微信：鼠标停哪就高亮哪，点一下截整个窗口） */
export function pickWindow(windows: CaptureWindow[], p: Point): CaptureWindow | null {
  let hit: CaptureWindow | null = null;
  for (const w of windows) {
    if (p.x < w.x || p.x >= w.x + w.width || p.y < w.y || p.y >= w.y + w.height) continue;
    if (!hit || w.width * w.height < hit.width * hit.height) hit = w;
  }
  return hit;
}

/** 八个控制点：命中判定用 DIP 容差，避免高 DPI 上难点中 */
export function hitTestHandle(rect: CaptureRect, p: Point, tolerance = 9): Handle | null {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const spots: { h: Handle; x: number; y: number }[] = [
    { h: "nw", x: rect.x, y: rect.y },
    { h: "n", x: midX, y: rect.y },
    { h: "ne", x: rect.x + rect.width, y: rect.y },
    { h: "e", x: rect.x + rect.width, y: midY },
    { h: "se", x: rect.x + rect.width, y: rect.y + rect.height },
    { h: "s", x: midX, y: rect.y + rect.height },
    { h: "sw", x: rect.x, y: rect.y + rect.height },
    { h: "w", x: rect.x, y: midY },
  ];
  for (const s of spots) {
    if (Math.abs(p.x - s.x) <= tolerance && Math.abs(p.y - s.y) <= tolerance) return s.h;
  }
  return null;
}

/** 拖手柄缩放：对应边移动，对边不动，且不允许翻过去 */
export function resizeRect(rect: CaptureRect, handle: Handle, from: Point, to: Point, view: CaptureSize): CaptureRect {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_SELECTION_DIP);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_SELECTION_DIP, view.width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_SELECTION_DIP);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_SELECTION_DIP, view.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 拖动选区内部整体平移，出界就贴边（不缩选区） */
export function moveRect(rect: CaptureRect, from: Point, to: Point, view: CaptureSize): CaptureRect {
  return {
    x: clamp(rect.x + (to.x - from.x), 0, Math.max(0, view.width - rect.width)),
    y: clamp(rect.y + (to.y - from.y), 0, Math.max(0, view.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}
