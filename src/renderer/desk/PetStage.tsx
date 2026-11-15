import { useCallback, useRef, useState } from "react";
import type { AvatarState } from "../../shared/avatar";
import { POSE_IMG, type PoseName } from "./pet-assets";
import { usePetMotion, type InteractKind, type MotionFrame } from "./pet-motion";

/**
 * 桌宠窗专用渲染层（对齐 dsh-pet 的「活着」观感）。
 *
 * 与 AvatarStage（主界面「我的风铃」面板）分开：那边保留三视图按钮/状态按钮演示，
 * 这边专注动画链 + 物理反馈 + Agent 状态联动，互不干扰。
 *
 * 关键约束：窗体移动仍由系统 -webkit-app-region: drag 负责，本组件**不改窗口位置**，
 * 只做精灵层视觉反馈——避免重蹈「拖动就消失」的坑。
 * 因为 drag 区域吞 DOM 指针事件，角色主体单独开一个 no-drag 热区接点击/拖拽，
 * 四周留白仍归系统拖拽。
 */

interface FramePair {
  seq: number;
  /** 底层：上一帧（保留不淡出，避免切帧闪空） */
  back: string;
  /** 顶层：当前帧，淡入覆盖 */
  front: string;
}

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
  const press = useRef<{ x: number; y: number; t: number; dragging: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lean, setLean] = useState<"" | "l" | "r">("");

  const frameUrl = useCallback((fr: MotionFrame): string => {
    const view = fr.view ?? "front";
    return POSE_IMG[view]?.[fr.pose] ?? POSE_IMG.front[fr.pose];
  }, []);

  // 双缓冲：渲染期同步算「上一帧 / 当前帧」，同一次渲染就拿到正确的一对，
  // 不依赖 effect（effect 会滞后一帧、且 key={seq} 的元素不重建导致淡入不重播）。
  // seq 闸门保证幂等：StrictMode 双跑 render 不会把 back 误刷成当前帧。
  const pairRef = useRef<FramePair>({ seq: -1, back: frameUrl(frame), front: frameUrl(frame) });
  if (pairRef.current.seq !== seq) {
    const url = frameUrl(frame);
    pairRef.current = { seq, back: pairRef.current.front || url, front: url };
  }
  const { back: baseUrl, front: topUrl } = pairRef.current;

  const onDown = useCallback((e: React.PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY, t: Date.now(), dragging: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.dragging && Math.hypot(dx, dy) > 8) {
        p.dragging = true;
        setDragging(true);
        interact("drag");
      }
      if (p.dragging) setLean(dx > 4 ? "r" : dx < -4 ? "l" : "");
    },
    [interact],
  );

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      const p = press.current;
      press.current = null;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!p) return;
      if (p.dragging) {
        setDragging(false);
        setLean("");
        interact("land");
        return;
      }
      const dt = Date.now() - p.t;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (dt < 450 && dist < 8) {
        // 点击 Q 弹：随机给个开心/被戳反应，别每次都一样
        interact((Math.random() < 0.6 ? "poke" : "happy") as InteractKind);
      }
    },
    [interact],
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

  const hitHandlers = {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  };

  return (
    <div className="pet-stage" style={{ height }} data-state={state}>
      {/* 影子独立层：不跟着镜像/倾斜，只跟腾空缩放 */}
      <div className={`pet-shadow pet-shadow-${fx}`} />

      {/* 漫游层：只做窗内水平位移，绝不改窗口位置 */}
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

      {/* no-drag 热区：只盖角色主体，四周留白仍归系统窗体拖拽 */}
      <div className="pet-hit" {...hitHandlers} title="点一下 / 拖一拖" />

      {/* key 用文案本身：只在状态切换时淡入一次，别每帧重建闪一下 */}
      {bubble && <div className="pet-bubble" key={bubble}>{bubble}</div>}
    </div>
  );
}
