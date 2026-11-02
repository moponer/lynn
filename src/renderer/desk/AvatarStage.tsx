import { useRef, useState } from "react";
import {
  AVATAR_STATES,
  AVATAR_STATE_LABEL,
  type AvatarState,
  type AvatarView,
  clampYaw,
  viewOfYaw,
  yawForView,
} from "../../shared/avatar";

/**
 * 形象舞台（计划书 §2.5）。
 *
 * 位置纪律：**不常驻主界面**，只出现在「我的风铃」与桌宠模式（设计规范 §7）。
 * 驱动契约是 U 插件位 `avatar.driver`：内置驱动用分层 SVG + CSS 3D 做三视图，
 * VRM 驱动（three-vrm）之后按同一接口替换，界面不用改。
 */

export interface AvatarDriver {
  load(model: string): Promise<void>;
  play(state: AvatarState): void;
  setMood(mood: string): void;
  dispose(): void;
}

const VIEW_LABEL: Record<AvatarView, string> = { front: "正", side: "侧", back: "背" };

export function AvatarStage({
  state,
  onState,
  bubble,
  height = 220,
  minimal = false,
}: {
  state: AvatarState;
  /** 演示用：允许在面板里手动切状态（真实运行时由 Agent 事件流驱动） */
  onState?: (s: AvatarState) => void;
  bubble?: string;
  height?: number;
  /** 桌宠模式：只留形象，不要机位按钮/状态按钮 */
  minimal?: boolean;
}) {
  const [yaw, setYaw] = useState(0);
  const drag = useRef<{ x: number; yaw: number } | null>(null);
  const view = viewOfYaw(yaw);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, yaw };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    // 像素 → 角度：拖动 3px ≈ 1°，手感够稳
    setYaw(clampYaw(drag.current.yaw + (e.clientX - drag.current.x) / 3));
  };
  const onUp = () => {
    drag.current = null;
  };

  const face = Math.max(0, 1 - Math.abs(clampYaw(yaw)) / 80);
  const back = Math.min(1, Math.abs(clampYaw(yaw)) / 180);

  return (
    <div className="av">
      <div
        className="av-stage"
        style={{ height }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        title="拖动旋转 · 三视图"
      >
        <div className="av-rotor" style={{ transform: `rotateY(${yaw}deg)` }}>
          <svg
            className="av-figure"
            data-state={state}
            viewBox="0 0 200 240"
            preserveAspectRatio="xMidYMid meet"
            style={{ width: Math.round((height - 12) * (200 / 240)), height: height - 12 }}
            aria-label={`风铃 · ${AVATAR_STATE_LABEL[state]}`}
          >
            <ellipse className="av-shadow" cx="100" cy="226" rx="46" ry="8" />

            {/* 后层：背发（转到背面时露出来） */}
            <path
              className="av-hair-back"
              d="M56 96c-6-44 20-72 44-72s50 28 44 72c-2 20-8 34-8 52 0 16 4 30 4 30H60s4-14 4-30c0-18-6-32-8-52z"
              style={{ opacity: 0.35 + back * 0.65 }}
            />

            {/* 身体：蓝白裙裾 + 腰带 */}
            <path className="av-dress" d="M74 148h52l16 66c-14 8-30 12-42 12s-28-4-42-12z" />
            <path className="av-dress-2" d="M84 150h32l8 30H76z" />
            <rect className="av-belt" x="78" y="146" width="44" height="6" rx="3" />

            {/* 头 */}
            <circle className="av-face" cx="100" cy="100" r="30" />
            <path className="av-bangs" d="M68 98c0-26 14-42 32-42s32 16 32 42c-8-14-18-18-32-18s-24 4-32 18z" />

            {/* 五官（正/背渐隐） */}
            <g style={{ opacity: face }}>
              <circle className="av-eye" cx="88" cy="104" r="2.6" />
              <circle className="av-eye" cx="112" cy="104" r="2.6" />
              <path className="av-mouth" d="M94 114q6 5 12 0" />
              <circle className="av-blush" cx="80" cy="112" r="3" />
              <circle className="av-blush" cx="120" cy="112" r="3" />
            </g>

            {/* 侧视时的一点鼻梁，避免纯平面 */}
            <path className="av-nose" d="M126 104l6 4-6 3z" style={{ opacity: view === "side" ? 0.5 : 0 }} />

            {/* 发间小铃铛 */}
            <g className="av-bell" style={{ transformOrigin: "146px 78px" }}>
              <circle cx="146" cy="78" r="6" />
              <path d="M143 84h6" />
            </g>
          </svg>
        </div>

        {bubble && <div className="av-bubble">{bubble}</div>}

        {!minimal && (
          <div className="av-views">
            {(["front", "side", "back"] as AvatarView[]).map((v) => (
              <button
                key={v}
                className={`av-vbtn${view === v ? " on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setYaw(yawForView(v));
                }}
                title={`${VIEW_LABEL[v]}视图`}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
            <span className="av-yaw mono">{Math.round(yaw)}°</span>
          </div>
        )}
      </div>

      {onState && !minimal && (
        <div className="av-states">
          {AVATAR_STATES.map((s) => (
            <button key={s} className={`av-sbtn${state === s ? " on" : ""}`} onClick={() => onState(s)}>
              {AVATAR_STATE_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
