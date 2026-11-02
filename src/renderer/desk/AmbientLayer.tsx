import { useEffect, useRef } from "react";
import { frameInterval, shouldRender, type AmbientMode, type AmbientParams } from "../../shared/ambient";

/**
 * 动效层渲染器：Canvas 2D（内置动效器随主包发布）。
 * 只声明 kind + 参数，不加载任何脚本；省电/待机/隐藏窗口时停帧或降帧。
 *
 * 性能探针：`window.__lynnAmbientFrames.frames` 记录实际绘制帧数，
 * `window.__lynnAmbientState` 记录当前帧间隔与档位，供 GPU/帧率验收脚本读取。
 */

declare global {
  interface Window {
    __lynnAmbientFrames?: { frames: number; since: number };
    __lynnAmbientState?: { interval: number | null; kind: string; mode: AmbientMode; standby: boolean };
  }
}

export function AmbientLayer({
  params,
  mode,
  standby,
}: {
  params: AmbientParams;
  mode: AmbientMode;
  standby: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const t0 = useRef(0);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const state = () => ({
      mode,
      standby,
      reducedMotion,
      windowHidden: document.hidden,
    });

    let stopped = false;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);

    const draw = (now: number) => {
      raf.current = null;
      if (stopped) return;
      const s = state();
      const interval = frameInterval(s);
      window.__lynnAmbientState = { interval, kind: params.kind, mode, standby };
      if (interval === null || !shouldRender(params.kind, s)) {
        // 停帧：清空并等待下一次上下文变化（由 effect 重启）
        ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
        return;
      }
      if (!t0.current) t0.current = now;
      if (now - last.current < interval) {
        raf.current = requestAnimationFrame(draw);
        return;
      }
      last.current = now;
      const probe = (window.__lynnAmbientFrames ??= { frames: 0, since: performance.now() });
      probe.frames += 1;
      const t = ((now - t0.current) / 1000) * params.speed;
      ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
      ctx.globalAlpha = params.opacity;
      if (params.kind === "ripple") drawRipple(ctx, c.clientWidth, c.clientHeight, t);
      else if (params.kind === "wind") drawWind(ctx, c.clientWidth, c.clientHeight, t);
      else if (params.kind === "ink") drawInk(ctx, c.clientWidth, c.clientHeight, t);
      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);

    const onVisibility = () => {
      if (raf.current === null && !document.hidden) {
        t0.current = 0;
        last.current = 0;
        raf.current = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [params.kind, params.speed, params.opacity, mode, standby]);

  return (
    <div className="ambient" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}

/** 铃音涟漪：同心圆缓慢外扩，越外越淡 */
function drawRipple(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const cx = w * 0.5;
  const cy = h * 0.42;
  ctx.strokeStyle = getVar("--blue", "#5ea9c9");
  for (let i = 0; i < 5; i++) {
    const phase = (t * 0.18 + i * 0.2) % 1;
    const r = phase * Math.max(w, h) * 0.55;
    ctx.globalAlpha = (1 - phase) * 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** 风纹：几股横向流线，相位错开 */
function drawWind(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.strokeStyle = getVar("--blue", "#79c2a4");
  const lines = 7;
  for (let i = 0; i < lines; i++) {
    const y = ((i + 0.5) / lines) * h;
    const amp = 8 + i * 2;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 12) {
      const yy = y + Math.sin(x / 110 + t * 0.7 + i) * amp;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

/** 水墨：两团极淡的墨在缓慢呼吸 */
function drawInk(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const blobs = [
    { x: 0.28, y: 0.36, r: 0.26, c: getVar("--ink-3", "#857a63") },
    { x: 0.72, y: 0.6, r: 0.3, c: getVar("--ink-4", "#a89c83") },
  ];
  for (const [i, b] of blobs.entries()) {
    const r = Math.min(w, h) * b.r * (1 + Math.sin(t * 0.5 + i * 2) * 0.06);
    const g = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, r);
    g.addColorStop(0, b.c);
    g.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x * w, b.y * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function getVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
