/**
 * 桌宠形象素材索引（短发 v3，assets/pet-dafeiyu）。
 *
 * 19 个静态姿态 + 2 段 webp 动画，全部静态 import 进前端 bundle：
 * 走 Vite 资源管线（file:// + 相对路径），不联网、不碰 CSP。
 * 静态姿态用 alpha（原生 614×1080，最清晰，避免 HiDPI 屏放大发糊）；
 * idle / 走路用高清 webp 循环动画（284×500，原生重组），更生动且不糊。
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

/** 19 个静态姿态 → 资源 URL */
export const POSE_IMG: Record<PoseName, string> = {
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

/** 走路循环动画（在跑 / 溜达态用） */
export const WALK_ANIM = walkAnim;
/** 眨眼循环动画（idle 态用，自带呼吸感） */
export const BLINK_ANIM = blinkAnim;
