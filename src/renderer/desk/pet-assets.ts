/**
 * 桌宠形象素材索引（短发 v3，assets/pet-dafeiyu）。
 *
 * 19 个静态姿态 × 三视图（正/侧/背）+ 2 段 webp 动画，全部静态 import 进前端 bundle：
 * 走 Vite 资源管线（file:// + 相对路径），不联网、不碰 CSP。
 * 静态姿态用 alpha（原生 614×1080，最清晰，避免 HiDPI 屏放大发糊）；
 * idle / 走路用高清 webp 循环动画（284×500，原生重组），更生动且不糊。
 *
 * 三视图：正/侧/背各有完整 19 姿态素材（侧/背由母本图生图生成，见项目资产目录）。
 * 背面 19/19 已生成，三视图完整无缝，运行时不再回退正面。
 */
import idle from "@pet/poses/alpha/idle.png";
import blink from "@pet/poses/alpha/blink.png";
import happy from "@pet/poses/alpha/happy.png";
import wave from "@pet/poses/alpha/wave.png";
import talk from "@pet/poses/alpha/talk.png";
import think from "@pet/poses/alpha/think.png";
import sing from "@pet/poses/alpha/sing.png";
import heart from "@pet/poses/alpha/heart.png";
import sad from "@pet/poses/alpha/sad.png";
import angry from "@pet/poses/alpha/angry.png";
import surprise from "@pet/poses/alpha/surprise.png";
import tired from "@pet/poses/alpha/tired.png";
import poke from "@pet/poses/alpha/poke.png";
import sleep from "@pet/poses/alpha/sleep.png";
import walk1 from "@pet/poses/alpha/walk1.png";
import walk2 from "@pet/poses/alpha/walk2.png";
import walk3 from "@pet/poses/alpha/walk3.png";
import drag from "@pet/poses/alpha/drag.png";
import jump from "@pet/poses/alpha/jump.png";

import sideIdle from "@pet/poses/alpha/side-idle.png";
import sideBlink from "@pet/poses/alpha/side-blink.png";
import sideHappy from "@pet/poses/alpha/side-happy.png";
import sideWave from "@pet/poses/alpha/side-wave.png";
import sideTalk from "@pet/poses/alpha/side-talk.png";
import sideThink from "@pet/poses/alpha/side-think.png";
import sideSing from "@pet/poses/alpha/side-sing.png";
import sideHeart from "@pet/poses/alpha/side-heart.png";
import sideSad from "@pet/poses/alpha/side-sad.png";
import sideAngry from "@pet/poses/alpha/side-angry.png";
import sideSurprise from "@pet/poses/alpha/side-surprise.png";
import sideTired from "@pet/poses/alpha/side-tired.png";
import sidePoke from "@pet/poses/alpha/side-poke.png";
import sideSleep from "@pet/poses/alpha/side-sleep.png";
import sideWalk1 from "@pet/poses/alpha/side-walk1.png";
import sideWalk2 from "@pet/poses/alpha/side-walk2.png";
import sideWalk3 from "@pet/poses/alpha/side-walk3.png";
import sideDrag from "@pet/poses/alpha/side-drag.png";
import sideJump from "@pet/poses/alpha/side-jump.png";

import backIdle from "@pet/poses/alpha/back-idle.png";
import backBlink from "@pet/poses/alpha/back-blink.png";
import backHappy from "@pet/poses/alpha/back-happy.png";
import backWave from "@pet/poses/alpha/back-wave.png";
import backTalk from "@pet/poses/alpha/back-talk.png";
import backThink from "@pet/poses/alpha/back-think.png";
import backSing from "@pet/poses/alpha/back-sing.png";
import backHeart from "@pet/poses/alpha/back-heart.png";
import backSad from "@pet/poses/alpha/back-sad.png";
import backAngry from "@pet/poses/alpha/back-angry.png";
import backSurprise from "@pet/poses/alpha/back-surprise.png";
import backTired from "@pet/poses/alpha/back-tired.png";
import backPoke from "@pet/poses/alpha/back-poke.png";
import backSleep from "@pet/poses/alpha/back-sleep.png";
import backWalk1 from "@pet/poses/alpha/back-walk1.png";
import backWalk2 from "@pet/poses/alpha/back-walk2.png";
import backWalk3 from "@pet/poses/alpha/back-walk3.png";
import backDrag from "@pet/poses/alpha/back-drag.png";
import backJump from "@pet/poses/alpha/back-jump.png";

import walkAnim from "@pet/anim-walk.webp";
import blinkAnim from "@pet/anim-blink.webp";

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

/** 19 个静态姿态 → 资源 URL（正面） */
const FRONT: Record<PoseName, string> = {
  idle,
  blink,
  happy,
  wave,
  talk,
  think,
  sing,
  heart,
  sad,
  angry,
  surprise,
  tired,
  poke,
  sleep,
  walk1,
  walk2,
  walk3,
  drag,
  jump,
};

/** 19 个静态姿态 → 资源 URL（侧面，同源母本图生图生成） */
const SIDE: Record<PoseName, string> = {
  idle: sideIdle,
  blink: sideBlink,
  happy: sideHappy,
  wave: sideWave,
  talk: sideTalk,
  think: sideThink,
  sing: sideSing,
  heart: sideHeart,
  sad: sideSad,
  angry: sideAngry,
  surprise: sideSurprise,
  tired: sideTired,
  poke: sidePoke,
  sleep: sideSleep,
  walk1: sideWalk1,
  walk2: sideWalk2,
  walk3: sideWalk3,
  drag: sideDrag,
  jump: sideJump,
};

/** 19 个静态姿态 → 资源 URL（背面，同源母本图生图生成，19/19 齐全） */
const BACK: Record<PoseName, string> = {
  idle: backIdle,
  blink: backBlink,
  happy: backHappy,
  wave: backWave,
  talk: backTalk,
  think: backThink,
  sing: backSing,
  heart: backHeart,
  sad: backSad,
  angry: backAngry,
  surprise: backSurprise,
  tired: backTired,
  poke: backPoke,
  sleep: backSleep,
  walk1: backWalk1,
  walk2: backWalk2,
  walk3: backWalk3,
  drag: backDrag,
  jump: backJump,
};

/** 三视图：正 / 侧 / 背 → 19 静态姿态 → 资源 URL */
export const POSE_IMG: Record<"front" | "side" | "back", Record<PoseName, string>> = {
  front: FRONT,
  side: SIDE,
  back: BACK,
};

/** 走路循环动画（在跑 / 溜达态用） */
export const WALK_ANIM = walkAnim;
/** 眨眼循环动画（idle 态用，自带呼吸感） */
export const BLINK_ANIM = blinkAnim;
