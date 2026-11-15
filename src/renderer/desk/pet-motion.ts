import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarState, AvatarView } from "../../shared/avatar";
import type { PoseName } from "./pet-assets";

/**
 * 桌宠动效引擎（对齐 dsh-pet「大肥鱼」的灵动度，形象不改）。
 *
 * 核心：把 19 姿态 + 三视图当**帧**，组成动画链 clip；按权重随机接续下一个 clip，
 * 首尾用交叉淡入衔接，让桌宠「自己找事做」而不是定格贴图。
 * 状态（Agent 事件流）覆盖待机池；交互（点击/拖拽）打断后回到当前状态。
 *
 * 纯渲染层，不碰 Electron 窗口位置——窗体移动仍由系统 -webkit-app-region: drag 负责。
 */

/** 帧级特效：CSS 负责实现，这里只声明语义 */
export type MotionFx =
  | "none"
  | "squash" // 挤压（落地 / 点击 Q 弹）
  | "stretch" // 拉伸（起跳）
  | "hop" // 腾空
  | "lean-l"
  | "lean-r" // 拖拽倾斜
  | "pop" // 点击 Q 弹
  | "sway" // 左右摇
  | "land"; // 落地回弹

export interface MotionFrame {
  pose: PoseName;
  ms: number;
  view?: AvatarView;
  /** 水平镜像（朝右走） */
  flip?: boolean;
  fx?: MotionFx;
  /** 窗内水平漫游位移 px（不改窗口位置） */
  dx?: number;
  bubble?: string;
}

export interface MotionClip {
  id: string;
  frames: MotionFrame[];
  /** 待机池权重 */
  weight: number;
}

const f = (pose: PoseName, ms: number, extra: Partial<MotionFrame> = {}): MotionFrame => ({
  pose,
  ms,
  ...extra,
});

/** 待机池：她闲下来自己找事做（权重越大越常出现） */
const IDLE_POOL: MotionClip[] = [
  { id: "breathe", weight: 22, frames: [f("idle", 2600)] },
  {
    id: "blink",
    weight: 16,
    frames: [f("idle", 900), f("blink", 110), f("idle", 500)],
  },
  {
    // 东张西望：把侧/背视图真正用起来，且首尾都回正面
    id: "look-around",
    weight: 13,
    frames: [
      f("idle", 700),
      f("think", 620, { view: "side" }),
      f("idle", 520, { view: "side", flip: true }),
      f("think", 620, { view: "back" }),
      f("idle", 560, { view: "back" }),
      f("idle", 520),
    ],
  },
  {
    id: "wave",
    weight: 9,
    frames: [f("idle", 380), f("wave", 620), f("wave", 480, { fx: "sway" }), f("idle", 420)],
  },
  {
    id: "heart",
    weight: 8,
    frames: [f("idle", 380), f("heart", 760), f("happy", 520), f("idle", 420)],
  },
  {
    id: "hum",
    weight: 7,
    frames: [f("idle", 360), f("sing", 780, { fx: "sway" }), f("sing", 620), f("idle", 420)],
  },
  {
    id: "stretch",
    weight: 8,
    frames: [
      f("idle", 420),
      f("tired", 620),
      f("jump", 460, { fx: "stretch" }),
      f("idle", 520, { fx: "land" }),
    ],
  },
  {
    id: "doze",
    weight: 5,
    frames: [f("idle", 520), f("sleep", 1100), f("tired", 620), f("idle", 460)],
  },
  {
    // 窗内溜达：走路四拍 contact-pass-contact，侧视 + 镜像
    id: "stroll",
    weight: 9,
    frames: [
      f("walk1", 140, { view: "side", dx: 0 }),
      f("walk2", 130, { view: "side", dx: 9 }),
      f("walk3", 140, { view: "side", dx: 18 }),
      f("walk2", 130, { view: "side", dx: 9 }),
      f("idle", 360, { view: "side", dx: 0 }),
    ],
  },
  {
    id: "happy-hop",
    weight: 6,
    frames: [
      f("idle", 340),
      f("jump", 380, { fx: "hop" }),
      f("happy", 560, { fx: "land" }),
      f("idle", 420),
    ],
  },
];

/** Agent 状态 → 动画链（覆盖待机池，播完循环直到状态变化） */
const STATE_CLIPS: Record<AvatarState, MotionClip> = {
  idle: IDLE_POOL[0],
  thinking: {
    id: "state-thinking",
    weight: 0,
    frames: [f("think", 1500, { fx: "sway" }), f("think", 1200), f("blink", 130), f("think", 1400)],
  },
  running: {
    id: "state-running",
    weight: 0,
    frames: [
      f("walk1", 130, { view: "side", dx: 0 }),
      f("walk2", 120, { view: "side", dx: 8 }),
      f("walk3", 130, { view: "side", dx: 16 }),
      f("walk2", 120, { view: "side", dx: 8 }),
    ],
  },
  success: {
    id: "state-success",
    weight: 0,
    frames: [
      f("happy", 700),
      f("jump", 420, { fx: "hop" }),
      f("heart", 800, { fx: "land" }),
      f("happy", 900),
    ],
  },
  failed: {
    id: "state-failed",
    weight: 0,
    frames: [f("sad", 1200, { fx: "lean-l" }), f("sad", 1100), f("tired", 900), f("sad", 1000)],
  },
  waiting_confirm: {
    id: "state-waiting",
    weight: 0,
    frames: [f("surprise", 900, { fx: "pop" }), f("surprise", 1100, { fx: "sway" }), f("poke", 800)],
  },
  standby: {
    id: "state-standby",
    weight: 0,
    frames: [f("sleep", 3200), f("tired", 900), f("sleep", 3200)],
  },
};

/** 交互 clip：打断当前链，播完回到状态链 */
const INTERACT_CLIPS: Record<string, MotionClip> = {
  poke: {
    id: "interact-poke",
    weight: 0,
    frames: [f("poke", 300, { fx: "pop" }), f("surprise", 460, { fx: "squash" }), f("idle", 320, { fx: "land" })],
  },
  happy: {
    id: "interact-happy",
    weight: 0,
    frames: [f("happy", 420, { fx: "pop" }), f("heart", 640), f("idle", 320)],
  },
  drag: {
    id: "interact-drag",
    weight: 0,
    frames: [f("drag", 260, { fx: "stretch" }), f("drag", 800)],
  },
  land: {
    id: "interact-land",
    weight: 0,
    frames: [f("jump", 220, { fx: "squash" }), f("idle", 420, { fx: "land" })],
  },
};

export type InteractKind = keyof typeof INTERACT_CLIPS;

/** 状态气泡文案（沿既有 SettingsModal.BUBBLE 的 UI 文案模式） */
export const STATE_BUBBLE: Partial<Record<AvatarState, string>> = {
  thinking: "在想…",
  running: "在跑…",
  success: "搞定啦",
  failed: "出岔子了…",
  waiting_confirm: "等你拍板",
  standby: "zzZ",
};

/** 待机池轮转计数：纯加权随机不保证三视图一定被看到，
 *  每 LOOK_EVERY 段强制插一次「东张西望」（含侧/背视图）。 */
const LOOK_EVERY = 4;

function pickIdle(exclude: string, sinceLook: number): MotionClip {
  if (sinceLook >= LOOK_EVERY - 1) return IDLE_POOL[2]; // look-around
  const pool = IDLE_POOL.filter((c) => c.id !== exclude);
  const total = pool.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of pool) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return pool[0];
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface MotionOutput {
  frame: MotionFrame;
  /** 每次切帧自增，供渲染层做交叉淡入 */
  seq: number;
  bubble?: string;
  interact: (kind: InteractKind) => void;
}

/**
 * 动效引擎 hook。mood 指定时冻结为单帧（走查用，不跑链）。
 */
export function usePetMotion(state: AvatarState, mood?: PoseName): MotionOutput {
  const [frame, setFrame] = useState<MotionFrame>(mood ? f(mood, 100000) : f("idle", 2600));
  const [seq, setSeq] = useState(0);
  const [bubble, setBubble] = useState<string | undefined>(undefined);

  const timer = useRef<number | null>(null);
  const stateRef = useRef(state);
  const lastClip = useRef<string>("breathe");
  const sinceLook = useRef(0);
  const pendingInteract = useRef(false);
  const reduced = useRef(prefersReducedMotion());
  const loopRef = useRef<() => void>(() => {});
  stateRef.current = state;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** 播一段 clip，结束后按状态决定下一段 */
  const run = useCallback(
    (clip: MotionClip, onDone?: () => void) => {
      let i = 0;
      const step = () => {
        const src = clip.frames[i];
        // reduced-motion：只保留静态帧，去掉 fx / 位移 / 视图跳转
        const out: MotionFrame = reduced.current
          ? { pose: clip.id.startsWith("state-") ? src.pose : "idle", ms: Math.max(src.ms, 1600), view: "front" }
          : src;
        setFrame(out);
        setSeq((s) => s + 1);
        setBubble(out.bubble ?? STATE_BUBBLE[stateRef.current]);
        timer.current = window.setTimeout(() => {
          i += 1;
          // reduced 模式下整段只播首帧，播完直接收尾
          if (i < clip.frames.length && !reduced.current) step();
          else onDone?.();
        }, out.ms);
      };
      step();
    },
    [],
  );

  /** 主链：状态优先，idle 走加权随机待机池。用 ref 自引用，避开 TDZ */
  const loop = useCallback(() => {
    const next = () => loopRef.current();
    const s = stateRef.current;
    if (s === "idle") {
      const clip = pickIdle(lastClip.current, sinceLook.current);
      lastClip.current = clip.id;
      sinceLook.current = clip.id === "look-around" ? 0 : sinceLook.current + 1;
      run(clip, next);
    } else {
      sinceLook.current = 0; // 状态链打断了待机节奏，回来重新计数
      run(STATE_CLIPS[s], next);
    }
  }, [run]);
  loopRef.current = loop;

  // 状态 / mood 变化：重启动画链
  useEffect(() => {
    clear();
    pendingInteract.current = false;
    if (mood) {
      setFrame(f(mood, 100000));
      setSeq((s) => s + 1);
      setBubble(undefined);
      return;
    }
    loopRef.current();
    return clear;
  }, [state, mood, clear]);

  /** 交互打断：播完回到当前状态链。
   *  drag → land 属于同一次手势的连续阶段，必须允许覆盖；普通点击不打断正在播的交互。 */
  const interact = useCallback(
    (kind: InteractKind) => {
      if (mood) return;
      const phase = kind === "drag" || kind === "land";
      if (pendingInteract.current && !phase) return;
      const clip = INTERACT_CLIPS[kind];
      if (!clip) return;
      clear();
      pendingInteract.current = true;
      run(clip, () => {
        pendingInteract.current = false;
        loopRef.current();
      });
    },
    [mood, clear, run],
  );

  return { frame, seq, bubble, interact };
}
