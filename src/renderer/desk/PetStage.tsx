import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarState } from "../../shared/avatar";
import { POSE_IMG, type PoseName } from "./pet-assets";
import { usePetMotion, type InteractKind, type MotionFrame } from "./pet-motion";
import {
  PHYSICS,
  follow,
  hitScore,
  isSettled,
  launch,
  restingBody,
  stepPhysics,
  velocityFromSamples,
  type Body,
  type Bounds,
  type Sample,
} from "./pet-physics";

/**
 * 桌宠窗专用渲染层（对齐 dsh-pet 的「活着」观感）。
 *
 * 与 AvatarStage（主界面「我的风铃」面板）分开：那边保留三视图按钮/状态按钮演示，
 * 这边专注动画链 + 物理反馈 + Agent 状态联动，互不干扰。
 *
 * 关键约束：窗体移动仍由系统 -webkit-app-region: drag 负责，本组件**不改窗口位置**。
 * 物理引擎只驱动窗内精灵层（抛物线 / 碰壁反弹 / 地面摩擦 / Q 弹），零回归风险。
 * 因为 drag 区域吞 DOM 指针事件，角色主体单独开一个 no-drag 热区接点击/拖拽，
 * 四周留白仍归系统拖拽。
 */

interface FramePair {
  seq: number;
  /** 底层：上一帧（同步淡出，避免透明精灵透出重影） */
  back: string;
  /** 顶层：当前帧，淡入覆盖 */
  front: string;
}

interface Press {
  x: number;
  y: number;
  t: number;
  dragging: boolean;
  samples: Sample[];
}

interface HitFx {
  score: number;
  x: number;
  y: number;
}

const SPARKS = 8;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function PetStage({
  state,
  mood,
  height = 388,
}: {
  state: AvatarState;
  mood?: PoseName;
  height?: number;
}) {
  const { frame, seq, bubble, interact } = usePetMotion(state, mood);
  const press = useRef<Press | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lean, setLean] = useState<"" | "l" | "r">("");
  const [body, setBody] = useState<Body>(restingBody);
  const [hitFx, setHitFx] = useState<HitFx | null>(null);

  const bodyRef = useRef<Body>(restingBody());
  const boundsRef = useRef<Bounds>({ left: -90, right: 90, top: -155, bottom: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTick = useRef(0);
  const dragRef = useRef(false);
  const dragTarget = useRef({ x: 0, y: 0 });
  const interactRef = useRef(interact);
  const hitTimer = useRef<number | null>(null);
  const reducedRef = useRef(prefersReducedMotion());
  interactRef.current = interact;

  if (bodyRef.current !== body) bodyRef.current = body;

  const frameUrl = useCallback((fr: MotionFrame): string => {
    const view = fr.view ?? "front";
    return POSE_IMG[view]?.[fr.pose] ?? POSE_IMG.front[fr.pose];
  }, []);

  // 双缓冲：渲染期同步算「上一帧 / 当前帧」，不依赖 effect（会滞后一帧）。
  // seq 闸门保证幂等：StrictMode 双跑 render 不会把 back 误刷成当前帧。
  const pairRef = useRef<FramePair>({ seq: -1, back: frameUrl(frame), front: frameUrl(frame) });
  if (pairRef.current.seq !== seq) {
    const url = frameUrl(frame);
    pairRef.current = { seq, back: pairRef.current.front || url, front: url };
  }
  const { back: baseUrl, front: topUrl } = pairRef.current;

  /** rAF 主循环：拖拽期过阻尼跟手，松手后走重力积分 */
  const tick = useCallback((now: number) => {
    const dt = lastTick.current ? (now - lastTick.current) / 1000 : 0.016;
    lastTick.current = now;
    const b = bodyRef.current;
    let next: Body;
    if (dragRef.current) {
      next = {
        ...b,
        x: follow(b.x, dragTarget.current.x, dt),
        y: follow(b.y, dragTarget.current.y, dt),
        vx: 0,
        vy: 0,
        grounded: false,
        squash: 1,
        impact: 0,
        speed: 0,
      };
    } else {
      next = stepPhysics(b, dt, boundsRef.current);
    }
    bodyRef.current = next;
    setBody(next);
    if (!dragRef.current && isSettled(next)) {
      rafRef.current = null;
      lastTick.current = 0;
      interactRef.current("land");
      return;
    }
    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    lastTick.current = 0;
    rafRef.current = window.requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (hitTimer.current !== null) window.clearTimeout(hitTimer.current);
    };
  }, []);

  const measure = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    const w = rect?.width || 300;
    const h = rect?.height || height;
    boundsRef.current = {
      left: -w * 0.3,
      right: w * 0.3,
      top: -h * 0.4,
      bottom: 0,
    };
  }, [height]);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      const t = Date.now();
      reducedRef.current = prefersReducedMotion();
      press.current = { x: e.clientX, y: e.clientY, t, dragging: false, samples: [{ x: e.clientX, y: e.clientY, t }] };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      measure();
    },
    [measure],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const t = Date.now();
      p.samples.push({ x: e.clientX, y: e.clientY, t });
      if (p.samples.length > 14) p.samples.shift();
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      // reduced-motion：完全不跑物理，拖动手势交回系统窗体
      if (reducedRef.current) return;
      if (!p.dragging && Math.hypot(dx, dy) > 8) {
        p.dragging = true;
        dragRef.current = true;
        setDragging(true);
        interactRef.current("drag");
        startLoop();
      }
      if (p.dragging) {
        const b = boundsRef.current;
        dragTarget.current = { x: clamp(dx, b.left, b.right), y: clamp(dy, b.top, b.bottom) };
        setLean(dx > 4 ? "r" : dx < -4 ? "l" : "");
      }
    },
    [startLoop],
  );

  const showHit = useCallback((score: number, x: number, y: number) => {
    setHitFx({ score, x, y });
    if (hitTimer.current !== null) window.clearTimeout(hitTimer.current);
    hitTimer.current = window.setTimeout(() => setHitFx(null), 1100);
  }, []);

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      const p = press.current;
      press.current = null;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!p) return;

      const dt = Date.now() - p.t;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);

      if (p.dragging) {
        dragRef.current = false;
        setDragging(false);
        setLean("");
        const { vx, vy } = velocityFromSamples(p.samples);
        bodyRef.current = launch(vx, vy);
        setBody(bodyRef.current);
        interactRef.current("throw");
        startLoop();
        return;
      }

      if (dt < 450 && dist < 8) {
        const flying = bodyRef.current;
        if (!flying.grounded && flying.speed >= PHYSICS.hitSpeed) {
          // 飞行中被按中：爆粒子 + 弹积分（dsh-pet 同款彩蛋）
          const rect = el.getBoundingClientRect();
          showHit(
            hitScore(flying.speed, rect.width || 300),
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
          bodyRef.current = { ...flying, vx: -flying.vx * 0.6, vy: -Math.abs(flying.vy) * 0.5 - 260 };
          setBody(bodyRef.current);
          startLoop();
          return;
        }
        interactRef.current((Math.random() < 0.6 ? "poke" : "happy") as InteractKind);
      }
    },
    [showHit, startLoop],
  );

  const fx = frame.fx ?? "none";
  const orientCls = [
    "pet-orient",
    frame.flip ? "pet-flip" : "",
    dragging ? "pet-dragging" : "",
    lean ? `pet-lean-${lean}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 影子：随腾空高度缩小变淡，随水平位移跟随
  const lift = clamp(-body.y / Math.max(-boundsRef.current.top, 1), 0, 1);
  const shadowScale = 1 - lift * 0.45;
  const shadowStyle: React.CSSProperties = {
    transform: `translateX(-50%) translateX(${body.x}px) scale(${shadowScale}, ${1 - lift * 0.18})`,
    opacity: 0.28 * shadowScale,
  };
  const physicsStyle: React.CSSProperties = {
    transform: `translate(${body.x}px, ${body.y}px) scaleY(${body.squash})`,
  };

  const hitHandlers = {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  };

  return (
    <div className="pet-stage" ref={stageRef} style={{ height }} data-state={state}>
      {/* 影子独立层：不跟着镜像/倾斜，只跟物理高度与位移 */}
      <div className="pet-shadow" style={shadowStyle} />

      {/* 物理层：抛物线 / 碰壁反弹 / 落地摩擦 / Q 弹压缩，绝不改窗口位置 */}
      <div className="pet-physics" style={physicsStyle}>
        <div className="pet-roam" style={{ transform: `translateX(${frame.dx ?? 0}px)` }}>
          {/* 朝向/倾斜层：用 CSS scale/rotate 独立属性，不与内层 transform 打架 */}
          <div className={orientCls}>
            {/* 特效层：每帧重建触发 animation；A/B 双槽交叉淡入，切帧不硬跳 */}
            <div className={`pet-layers pet-fx-${fx}`} key={seq}>
              <img className="pet-layer pet-layer-base" src={baseUrl} alt="" draggable={false} />
              <img
                className="pet-layer pet-layer-top"
                src={topUrl}
                data-pose={frame.pose}
                data-view={frame.view ?? "front"}
                alt="风铃桌宠"
                draggable={false}
              />
            </div>
          </div>
        </div>
      </div>

      {/* no-drag 热区：只盖角色主体，四周留白仍归系统窗体拖拽 */}
      <div className="pet-hit" {...hitHandlers} title="点一下 / 拖一拖 / 甩出去" />

      {/* 飞行命中彩蛋 */}
      {hitFx && (
        <div className="pet-hit-fx" style={{ left: hitFx.x, top: hitFx.y }}>
          {Array.from({ length: SPARKS }, (_, i) => (
            // 外层旋转定方向，内层动画只做纯数值位移——不引入未定义的 CSS 变量
            <span
              key={i}
              className="pet-spark-arm"
              style={{ transform: `rotate(${(i / SPARKS) * 360}deg)` }}
            >
              <span className="pet-spark" />
            </span>
          ))}
          <span className="pet-hit-score">+{hitFx.score}</span>
        </div>
      )}

      {/* key 用文案本身：只在状态切换时淡入一次，别每帧重建闪一下 */}
      {bubble && <div className="pet-bubble" key={bubble}>{bubble}</div>}
    </div>
  );
}
