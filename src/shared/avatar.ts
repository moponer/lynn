/**
 * 形象模块的状态与三视图（计划书 §2.5 / 设计规范 §7）。
 *
 * 形象不接 LLM，只消费 Agent 事件流；它**不常驻主界面**，只出现在「我的风铃」与桌宠模式。
 * 驱动接口是 U 插件位（`avatar.driver`）：内置 SVG 驱动先顶上，VRM 驱动之后替换。
 */

export const AVATAR_STATES = [
  "idle",
  "thinking",
  "running",
  "success",
  "failed",
  "waiting_confirm",
  "standby",
] as const;

export type AvatarState = (typeof AVATAR_STATES)[number];

export const AVATAR_STATE_LABEL: Record<AvatarState, string> = {
  idle: "空闲",
  thinking: "思考中",
  running: "执行中",
  success: "完成",
  failed: "出错",
  waiting_confirm: "等你确认",
  standby: "待机",
};

export type AvatarView = "front" | "side" | "back";

/** 预设机位：正 / 侧 / 背（验收硬指标：三视图要能一键切） */
export const VIEW_YAW: Record<AvatarView, number> = { front: 0, side: 90, back: 180 };

/** 把任意角度折到 (-180, 180] */
export function clampYaw(yaw: number): number {
  const wrapped = ((yaw % 360) + 360) % 360; // 0..360
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** 按当前角度判定落在哪个视图（±45° 内算正/背，其余算侧） */
export function viewOfYaw(yaw: number): AvatarView {
  const y = Math.abs(clampYaw(yaw));
  const back = y >= 135;
  if (back) return "back";
  return y <= 45 ? "front" : "side";
}

/** 预设机位循环：正 → 侧 → 背 → 正（侧视固定 +90°） */
export function nextView(view: AvatarView, dir: 1 | -1 = 1): AvatarView {
  const order: AvatarView[] = ["front", "side", "back"];
  const i = order.indexOf(view);
  return order[(i + dir + order.length) % order.length];
}

/** 三视图按钮对应的 yaw（侧视给 +90，方便"转到侧面"有方向感） */
export function yawForView(view: AvatarView): number {
  return view === "side" ? 90 : VIEW_YAW[view];
}

/**
 * 心声气泡的节流：只在"她真的在想/在跑/等你"时说话，且两次之间至少隔 `gapMs`。
 * 返回 true 表示这次可以冒泡。
 */
export function shouldSpeak(
  state: AvatarState,
  lastSpokeAt: number | null,
  now: number,
  gapMs = 6000,
): boolean {
  if (state !== "thinking" && state !== "running" && state !== "waiting_confirm") return false;
  if (lastSpokeAt === null) return true;
  return now - lastSpokeAt >= gapMs;
}

/** 事件 → 状态（只认事件流，不认模型输出；未知事件保持原状态） */
export function stateFromEvent(current: AvatarState, event: string): AvatarState {
  switch (event) {
    case "agent_start":
    case "thinking":
      return "thinking";
    case "tool_call":
    case "running":
      return "running";
    case "done":
    case "success":
      return "success";
    case "error":
    case "failed":
      return "failed";
    case "waiting_confirm":
      return "waiting_confirm";
    case "standby":
      return "standby";
    case "agent_settled":
    case "idle":
      return "idle";
    default:
      return current;
  }
}
