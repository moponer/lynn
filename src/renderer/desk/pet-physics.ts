/**
 * 桌宠物理引擎（参数与手感对齐 dsh-pet MIT physics.ts）。
 *
 * 作用域：只驱动**窗内精灵层**的位移与形变，不改 Electron 窗口位置。
 * 窗体移动仍由系统 -webkit-app-region: drag 负责——避免重蹈「拖动就消失」。
 * 窗口级全屏甩抛属于需要主进程 setBounds 的另一档工程。
 *
 * 全部为纯函数，不依赖 DOM / React，可单独验证。
 */

export const PHYSICS = {
  /** 重力加速度 px/s² */
  gravity: 1400,
  /** 碰壁恢复系数 */
  restitution: 0.78,
  /** 地面摩擦（指数衰减系数 /s） */
  friction: 2.5,
  /** 甩抛力度总系数 */
  throwScale: 1,
  /** 低于该法向速度不再弹起，视为落地 */
  minBounce: 55,
  /** 水平速度低于该值直接停住 */
  minSlide: 8,
  /** 速度上限，防止极限甩飞 */
  maxSpeed: 2600,
  /** 轻落 / 重砸的纵向压缩系数 */
  squashLight: 0.8,
  squashHeavy: 0.55,
  /** 达到该冲击速度视为重砸 */
  heavyImpact: 900,
  /** 拖拽跟手阻尼（越大越贴手） */
  followDamping: 18,
  /** 形变回弹速度 */
  squashRecover: 11,
  /** 飞行中被点中的判定速度 */
  hitSpeed: 400,
  /** 命中积分的尺寸基准（dsh-pet 口径 462） */
  scoreBase: 462,
} as const;

export interface Body {
  /** 相对初始位置的位移 px；y 为负表示腾空 */
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** 纵向形变系数，1 = 无形变 */
  squash: number;
  /** 最近一次碰撞的冲击速度，供渲染层做 Q 弹强度 */
  impact: number;
  /** 累计飞行速度绝对值，供命中判定 */
  speed: number;
}

export interface Bounds {
  left: number;
  right: number;
  top: number;
  /** 地面 y（通常为 0，即初始贴底位置） */
  bottom: number;
}

export interface Sample {
  x: number;
  y: number;
  t: number;
}

export function restingBody(): Body {
  return { x: 0, y: 0, vx: 0, vy: 0, grounded: true, squash: 1, impact: 0, speed: 0 };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 轻落压 0.8、重砸压到 0.55：按冲击速度线性插值 */
export function squashFor(impactSpeed: number): number {
  const t = clamp(impactSpeed / PHYSICS.heavyImpact, 0, 1);
  return PHYSICS.squashLight + (PHYSICS.squashHeavy - PHYSICS.squashLight) * t;
}

/** 拖拽末段轨迹估速度（只取最近 90ms，避免把起手慢拖算进甩抛） */
export function velocityFromSamples(samples: Sample[]): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (last.t - samples[i].t > 90) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0.008) return { vx: 0, vy: 0 };
  const vx = ((last.x - first.x) / dt) * PHYSICS.throwScale;
  const vy = ((last.y - first.y) / dt) * PHYSICS.throwScale;
  const sp = Math.hypot(vx, vy);
  const k = sp > PHYSICS.maxSpeed ? PHYSICS.maxSpeed / sp : 1;
  return { vx: vx * k, vy: vy * k };
}

/** 从一次甩抛建立运动体；慢放等于温柔放下，用力甩才飞出去 */
export function launch(vx: number, vy: number): Body {
  return {
    x: 0,
    y: 0,
    vx,
    vy: Math.min(vy, 0), // 向下甩不产生向上初速度，交给重力
    grounded: false,
    squash: 1,
    impact: 0,
    speed: Math.hypot(vx, vy),
  };
}

/** 拖拽跟手：过阻尼低通，不抖不飘 */
export function follow(current: number, target: number, dt: number): number {
  return current + (target - current) * Math.min(1, PHYSICS.followDamping * dt);
}

/**
 * 积分一帧。返回新 body 与本次是否发生碰撞。
 * 落地按冲击速度做一次 Q 弹；碰左右壁/顶部按恢复系数反弹。
 */
export function stepPhysics(body: Body, dt: number, bounds: Bounds): Body {
  const h = clamp(dt, 0, 0.05);
  let { x, y, vx, vy, squash, impact } = body;
  impact = 0;

  if (body.grounded) {
    // 地面摩擦减速
    vx *= Math.exp(-PHYSICS.friction * h);
    if (Math.abs(vx) < PHYSICS.minSlide) vx = 0;
    x += vx * h;
  } else {
    vy += PHYSICS.gravity * h;
    x += vx * h;
    y += vy * h;
  }

  // 左右壁
  if (x < bounds.left) {
    x = bounds.left;
    if (vx < 0) {
      impact = Math.abs(vx);
      vx = -vx * PHYSICS.restitution;
    }
  } else if (x > bounds.right) {
    x = bounds.right;
    if (vx > 0) {
      impact = Math.abs(vx);
      vx = -vx * PHYSICS.restitution;
    }
  }

  // 顶部
  if (y < bounds.top) {
    y = bounds.top;
    if (vy < 0) {
      impact = Math.max(impact, Math.abs(vy) * 0.6);
      vy = -vy * PHYSICS.restitution;
    }
  }

  // 地面
  let grounded = false;
  if (y >= bounds.bottom) {
    y = bounds.bottom;
    if (vy > 0) {
      impact = Math.max(impact, vy);
      vy = -vy * PHYSICS.restitution;
      if (Math.abs(vy) < PHYSICS.minBounce) {
        vy = 0;
        grounded = true;
      }
    } else {
      grounded = true;
    }
  }

  // 形变：碰撞瞬间压下去，随后弹回 1
  if (impact > 0) squash = squashFor(impact);
  else squash += (1 - squash) * Math.min(1, PHYSICS.squashRecover * h);
  if (Math.abs(squash - 1) < 0.002) squash = 1;

  return { x, y, vx, vy, grounded, squash, impact, speed: Math.hypot(vx, vy) };
}

/** 是否已经完全静止（可以停掉 rAF） */
export function isSettled(body: Body): boolean {
  return body.grounded && Math.abs(body.vx) < PHYSICS.minSlide && body.squash === 1;
}

/** 飞行中被点中：分数 = 速度/100 × 基准尺寸/当前尺寸 */
export function hitScore(speed: number, size: number): number {
  return Math.round((speed / 100) * (PHYSICS.scoreBase / Math.max(size, 1)));
}
