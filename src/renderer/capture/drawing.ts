/**
 * 截图标注的 Canvas 引擎（微信截图那一套：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 / 序号）。
 *
 * 工作画布是**物理像素尺寸**（与冻结帧一致），CSS 再缩到视口 DIP；
 * Shape 的坐标一律存 DIP，绘制时乘 scale，所以高 DPI 屏上标注不会糊。
 * 每次重绘都从原始冻结帧开始、按顺序重放 Shape —— 撤销就是删掉最后一条再重放，
 * 马赛克也从原图取样（不读当前画布），保证重放结果与第一次完全一致。
 */
import type { Point } from "../../shared/capture-geometry";
import type { CaptureRect } from "../../shared/contract";

export type Tool = "select" | "rect" | "ellipse" | "arrow" | "pen" | "mosaic" | "text" | "number";
export type DrawTool = Exclude<Tool, "select">;

export interface Shape {
  tool: DrawTool;
  color: string;
  /** DIP 线宽 / 字号基准 */
  width: number;
  /** DIP 坐标：pen 是多点折线，其它工具取首尾 */
  points: Point[];
  text?: string;
  no?: number;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  /** 原始冻结帧（物理像素尺寸，永不被修改） */
  base: CanvasImageSource;
  scale: number;
  canvasW: number;
  canvasH: number;
}

export const COLORS = ["#e0574c", "#f2f4f6", "#4b8fd9", "#12181f"] as const;
export const WIDTHS = [2, 4, 7] as const;

export function shapeFromDrag(tool: DrawTool, color: string, width: number, points: Point[], text?: string, no?: number): Shape {
  return { tool, color, width, points, ...(text !== undefined ? { text } : {}), ...(no !== undefined ? { no } : {}) };
}

export function shapeRect(points: Point[]): CaptureRect {
  const a = points[0] ?? { x: 0, y: 0 };
  const b = points[points.length - 1] ?? a;
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function drawShape(g: DrawContext, s: Shape): void {
  const { ctx, scale } = g;
  const a = s.points[0] ?? { x: 0, y: 0 };
  const b = s.points[s.points.length - 1] ?? a;
  const ax = a.x * scale;
  const ay = a.y * scale;
  const bx = b.x * scale;
  const by = b.y * scale;
  ctx.save();
  ctx.lineWidth = Math.max(1, s.width * scale);
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (s.tool) {
    case "rect": {
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      break;
    }
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const angle = Math.atan2(by - ay, bx - ax);
      const head = Math.max(10, s.width * scale * 4);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - head * Math.cos(angle - 0.42), by - head * Math.sin(angle - 0.42));
      ctx.lineTo(bx - head * Math.cos(angle + 0.42), by - head * Math.sin(angle + 0.42));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "pen": {
      if (s.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      for (let i = 1; i < s.points.length; i += 1) ctx.lineTo(s.points[i].x * scale, s.points[i].y * scale);
      ctx.stroke();
      break;
    }
    case "mosaic": {
      const x = Math.min(ax, bx);
      const y = Math.min(ay, by);
      const w = Math.abs(bx - ax);
      const h = Math.abs(by - ay);
      if (w < 2 || h < 2) break;
      const cell = Math.max(4, Math.round(10 * scale));
      const sw = Math.max(1, Math.floor(w / cell));
      const sh = Math.max(1, Math.floor(h / cell));
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      const t = tmp.getContext("2d");
      if (!t) break;
      t.drawImage(g.base, x, y, w, h, 0, 0, sw, sh);
      const smoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
      ctx.imageSmoothingEnabled = smoothing;
      break;
    }
    case "text": {
      const size = Math.max(12, Math.round(17 * scale));
      ctx.font = `500 ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(s.text ?? "", ax, ay);
      break;
    }
    case "number": {
      const radius = Math.max(11, 12 * scale);
      ctx.beginPath();
      ctx.arc(ax, ay, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${Math.round(radius * 1.25)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.no ?? 1), ax, ay + radius * 0.06);
      break;
    }
  }
  ctx.restore();
}

export function renderAll(g: DrawContext, shapes: Shape[], draft?: Shape | null): void {
  const { ctx, base, canvasW, canvasH } = g;
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.drawImage(base, 0, 0);
  for (const s of shapes) drawShape(g, s);
  if (draft) drawShape(g, draft);
}
