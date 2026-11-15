/**
 * 桌宠素材索引 —— **暂时停用（2026-11-15）**。
 *
 * 停用原因：57 张 1080 高姿态图共 20 MB，重画一轮仓库就翻倍，暂不入库。
 * 停用方式：
 *  - 本文件不再 import 任何图片，POSE_IMG 一律给空串（类型不变，调用方无需改动）；
 *  - 渲染层也不再挂载：App.tsx 的 ?pet=1 分支返回空、设置页「形象」块已注释。
 *
 * 恢复方式（三步）：
 *  1. 素材放回 assets/pet-dafeiyu（规格与 prompt 约束见 docs/pet-assets.md）
 *  2. 用 git 历史里本文件停用前的版本覆盖回来（那里有完整 59 行静态 import）
 *  3. 取消 App.tsx 的 <Pet /> 分支与设置页「形象」块的注释
 */

export type PoseName =
  | "idle"
  | "blink"
  | "happy"
  | "wave"
  | "talk"
  | "think"
  | "sing"
  | "heart"
  | "sad"
  | "angry"
  | "surprise"
  | "tired"
  | "poke"
  | "sleep"
  | "walk1"
  | "walk2"
  | "walk3"
  | "drag"
  | "jump";

export type { AvatarView } from "../../shared/avatar";

/** 19 个姿态 → 空串（停用期占位；形状与真实素材版完全一致） */
const EMPTY: Record<PoseName, string> = {
  idle: "",
  blink: "",
  happy: "",
  wave: "",
  talk: "",
  think: "",
  sing: "",
  heart: "",
  sad: "",
  angry: "",
  surprise: "",
  tired: "",
  poke: "",
  sleep: "",
  walk1: "",
  walk2: "",
  walk3: "",
  drag: "",
  jump: "",
};

/** 三视图（正 / 侧 / 背）→ 19 静态姿态 → 资源 URL（停用期全为空串） */
export const POSE_IMG: Record<"front" | "side" | "back", Record<PoseName, string>> = {
  front: EMPTY,
  side: EMPTY,
  back: EMPTY,
};

/** 走路循环动画（停用期为空串） */
export const WALK_ANIM = "";
/** 眨眼循环动画（停用期为空串） */
export const BLINK_ANIM = "";
