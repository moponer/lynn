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
import { POSE_IMG, WALK_ANIM, BLINK_ANIM, type PoseName } from "./pet-assets";

/**
 * 形象舞台（计划书 §2.5 / 规范 §7）。
 *
 * 渲染契约（U 插件位 `avatar.driver`）：内置驱动把**生成的短发女生 PNG** 当精灵渲染，
 * 按运行态切姿态；VRM 驱动之后按同一接口替换，界面不用改。
 *
 * 姿态来源：assets/pet-dafeiyu（19 静帧 × 三视图 + walk/blink 两段 webp 循环），见 pet-assets.ts。
 * - idle / 眨眼：播 BLINK_ANIM（自带呼吸感）
 * - running：播 WALK_ANIM（在跑 = 走动）
 * - thinking/success/failed/waiting/standby：静态姿态 + 克制 CSS 状态表达
 * - mood 直接指定任一 19 姿态（演示 / 之后运行时表情系统用），优先于 state
 *
 * 三视图：正/侧/背各有真实素材（见 pet-assets.POSE_IMG），按当前 view（由 yaw 推导）
 * 直接选对应视图素材渲染，不再用 `rotateY` 占位（避免转侧面精灵变薄片、背面是镜像）。
 * 拖动只改变 yaw → 在 正/侧/背 阈值间离散切换；webp 动画仅正面视图播放。
 */

const VIEW_LABEL: Record<AvatarView, string> = { front: "正", side: "侧", back: "背" };

/** 运行态 → 主姿态（静止帧） */
const POSE_BY_STATE: Record<AvatarState, PoseName> = {
  idle: "idle",
  thinking: "think",
  running: "talk", // 在跑：嘴在动，表达"正在干活"
  success: "happy",
  failed: "sad",
  waiting_confirm: "surprise", // 等你确认：意外/等待的表情更传神
  standby: "sleep",
};

/** 哪些态用 webp 循环动画（指定后优先于静态帧） */
const ANIM_BY_STATE: Partial<Record<AvatarState, string>> = {
  idle: BLINK_ANIM, // idle 自带眨眼循环
  running: WALK_ANIM, // 在跑 = 走动
};

export function AvatarStage({
  state,
  onState,
  bubble,
  height = 220,
  minimal = false,
  mood,
}: {
  state: AvatarState;
  /** 演示用：允许在面板里手动切状态（真实运行时由 Agent 事件流驱动） */
  onState?: (s: AvatarState) => void;
  bubble?: string;
  height?: number;
  /** 桌宠模式：只留形象，不要机位按钮/状态按钮 */
  minimal?: boolean;
  /** 直接指定任一 19 姿态（优先于 state） */
  mood?: PoseName;
}) {
  const [yaw, setYaw] = useState(0);
  const drag = useRef<{ x: number; yaw: number } | null>(null);
  const view = viewOfYaw(yaw);

  const pose: PoseName = mood ?? POSE_BY_STATE[state];
  const animUrl = !mood ? ANIM_BY_STATE[state] : undefined;
  // 按当前视图选素材；非正面视图不播 webp 动画（动画仅正面）
  const useAnim = !!animUrl && view === "front";
  const poseImg = POSE_IMG[view]?.[pose] ?? POSE_IMG.front[pose];

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

  // 桌宠（minimal）不转 3D：平面精灵转 90° 会变薄片消失；移动交给系统窗体拖拽
  const rotateHandlers = minimal
    ? {}
    : { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp };

  const cls = `av-sprite${mood ? " mood-on" : ""}${animUrl ? " av-anim" : ""}`;

  return (
    <div className="av">
      <div
        className="av-stage"
        style={{ height }}
        {...rotateHandlers}
        title={minimal ? undefined : "拖动旋转 · 三视图"}
      >
        {useAnim ? (
          <img
            className={cls}
            src={animUrl}
            alt={`风铃 · ${AVATAR_STATE_LABEL[state]}`}
            draggable={false}
          />
        ) : (
          <img
            className={cls}
            data-pose={pose}
            data-view={view}
            data-state={state}
            src={poseImg}
            alt={`风铃 · ${AVATAR_STATE_LABEL[state]} · ${view}`}
            draggable={false}
          />
        )}

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
