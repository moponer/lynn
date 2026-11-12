/**
 * 桌宠形象素材索引（短发 v3，assets/pet-dafeiyu）。
 *
 * 19 个静态姿态 + 2 段 webp 动画，全部静态 import 进前端 bundle：
 * 走 Vite 资源管线（file:// + 相对路径），不联网、不碰 CSP。
 * 静态姿态用 export@2x（高 480，清晰且体积可控）；idle / 走路用 webp 循环动画，更生动。
 */
import idle from "@pet/poses/export@2x/idle.png";
import blink from "@pet/poses/export@2x/blink.png";
import happy from "@pet/poses/export@2x/happy.png";
import wave from "@pet/poses/export@2x/wave.png";
import talk from "@pet/poses/export@2x/talk.png";
import think from "@pet/poses/export@2x/think.png";
import sing from "@pet/poses/export@2x/sing.png";
import heart from "@pet/poses/export@2x/heart.png";
import sad from "@pet/poses/export@2x/sad.png";
import angry from "@pet/poses/export@2x/angry.png";
import surprise from "@pet/poses/export@2x/surprise.png";
import tired from "@pet/poses/export@2x/tired.png";
import poke from "@pet/poses/export@2x/poke.png";
import sleep from "@pet/poses/export@2x/sleep.png";
import walk1 from "@pet/poses/export@2x/walk1.png";
import walk2 from "@pet/poses/export@2x/walk2.png";
import walk3 from "@pet/poses/export@2x/walk3.png";
import drag from "@pet/poses/export@2x/drag.png";
import jump from "@pet/poses/export@2x/jump.png";

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
