import { useEffect, useRef } from "react";
import { jobsInThread, type Desk, type DeskJob } from "../desk/model";

/**
 * 态势球（Canvas 2D）：深景球面 + 神经图。
 *
 * 分两层画：
 *  - **静态球层**离屏缓存：星点 / 大气 / 纬线 / 球面明暗，只在尺寸或主题变化时重绘；
 *  - **每帧层**：经线、陆块、地面站随自转投影；任务是球面上的簇，簇内节点是会呼吸的点。
 *
 * 只用 requestAnimationFrame 一条主循环，卸载时一定 cancel（禁用插件后不留幽灵定时器）。
 */

const TAU = Math.PI * 2;

/** 陆块的粗糙多边形（归一化球面坐标；只为质感，不是地理数据） */
const BLOBS: [number, number][][] = [
  [
    [-0.64, -0.32],
    [-0.48, -0.54],
    [-0.24, -0.46],
    [-0.18, -0.26],
    [-0.34, -0.1],
    [-0.54, -0.16],
  ],
  [
    [0.08, 0.08],
    [0.32, 0.0],
    [0.46, 0.2],
    [0.36, 0.48],
    [0.12, 0.44],
    [0.0, 0.28],
  ],
  [
    [-0.3, 0.4],
    [-0.1, 0.32],
    [0.04, 0.52],
    [-0.14, 0.68],
    [-0.36, 0.6],
  ],
];

const STATIONS: [number, number][] = [
  [-0.42, -0.3],
  [0.18, -0.46],
  [0.52, 0.1],
  [-0.2, 0.38],
  [0.3, 0.52],
  [-0.55, 0.16],
];

interface Pal {
  bg: string;
  sunken: string;
  panel: string;
  line: string;
  line2: string;
  ink: string;
  ink2: string;
  ink3: string;
  phos: string;
  dim: string;
  amber: string;
  seal: string;
  red: string;
  grid: string;
  grid2: string;
  light: boolean;
}

function readPal(): Pal {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    bg: g("--desk", "#0a0d0f"),
    sunken: g("--desk-3", "#141a1e"),
    panel: g("--sheet", "#151d22"),
    line: g("--rule", "rgba(162,178,176,.10)"),
    line2: g("--blue-line", "rgba(111,168,146,.26)"),
    ink: g("--ink", "#e6ebee"),
    ink2: g("--ink-2", "#a3adb3"),
    ink3: g("--ink-3", "#8c979d"),
    phos: g("--blue", "#6fa892"),
    dim: g("--blue-2", "#37614f"),
    amber: g("--brass", "#c9a227"),
    seal: g("--seal", "#c8443a"),
    red: g("--red", "#e0775f"),
    grid: g("--rule-soft", "rgba(162,178,176,.06)"),
    grid2: g("--rule", "rgba(162,178,176,.10)"),
    light: document.documentElement.dataset.mode === "light",
  };
}

interface GNode {
  id: string;
  label: string;
  state: "idle" | "live" | "alert" | "done";
  seed: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  hx: number;
  hy: number;
  jobId: string;
}

interface GCluster {
  jobId: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  angle: number;
  alertUntil: number;
  nodes: GNode[];
  edges: [number, number][];
}

interface Graph {
  W: number;
  H: number;
  dpr: number;
  pal: Pal;
  globe: HTMLCanvasElement | null;
  geo: { ex: number; ey: number; R: number };
  clusters: GCluster[];
  ripples: { x: number; y: number; r: number; a: number; color: string }[];
  beams: { x1: number; y1: number; x2: number; y2: number; t: number; color: string }[];
  inbound: { x: number; y: number; t: number }[];
  hover: string | null;
  locked: string | null;
  phase: number;
  t: number;
  spin: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 工单 → 簇内节点：成员一人一个点；没有成员时用阶段点，保证簇不空 */
function nodesOf(job: DeskJob, desk: Desk): { id: string; label: string; state: GNode["state"] }[] {
  const out: { id: string; label: string; state: GNode["state"] }[] = [];
  const stateOf = (): GNode["state"] => {
    if (job.action === "unblock" || job.status === "blocked") return "alert";
    if (job.group === "running") return "live";
    if (job.group === "archived") return "done";
    return "idle";
  };
  const members = desk.members.filter((m) => m.jobId === job.id);
  for (const m of members) {
    out.push({
      id: `${job.id}:${m.name}`,
      label: `${m.name} · ${m.progress}%`,
      state: m.status === "stuck" ? "alert" : m.status === "running" ? "live" : stateOf(),
    });
  }
  if (!out.length) {
    out.push({ id: `${job.id}:main`, label: job.title.slice(0, 10), state: stateOf() });
  }
  return out;
}

/** 簇的环形布点：单簇放右上（不压球心铭牌），双簇分居两侧，多簇均分 */
function clusterAngle(n: number, i: number): number {
  if (n === 1) return -1.15;
  if (n === 2) return i === 0 ? -2.3 : 0.75;
  return -Math.PI / 2 + (i * TAU) / Math.max(n, 1);
}

function layoutClusters(G: Graph): void {
  const { W, H } = G;
  const n = G.clusters.length;
  const Rc = Math.min(W * 0.3, H * 0.4);
  G.clusters.forEach((c, i) => {
    const a = clusterAngle(n, i);
    c.angle = a;
    c.tx = W / 2 + Math.cos(a) * Rc;
    c.ty = H / 2 + Math.sin(a) * Rc;
    const k = c.nodes.length;
    const r = Math.min(104, 58 + k * 9);
    c.nodes.forEach((nd, j) => {
      const na = -Math.PI / 2 + (j * TAU) / Math.max(k, 1) + nd.seed * 0.3;
      nd.tx = c.tx + Math.cos(na) * r * (0.84 + 0.16 * Math.sin(nd.seed + j));
      nd.ty = c.ty + Math.sin(na) * r * 0.76;
    });
    c.edges = [];
    for (let j = 0; j < k; j += 1) {
      c.edges.push([j, (j + 1) % k]);
      if (k > 3) c.edges.push([j, (j + 2) % k]);
    }
  });
}

export function Field({
  desk,
  onPick,
  scope = "all",
  focusId = null,
  onStats,
}: {
  desk: Desk;
  onPick?: (jobId: string | null, at?: { x: number; y: number }) => void;
  /** all = 全量（所有在办工单的簇）；node = 只留 focusId 那一簇 */
  scope?: "all" | "node";
  focusId?: string | null;
  /** 读数：节点 / 链路 / 帧（原型右下角的那三个数字，节流上报，不每帧 setState） */
  onStats?: (s: { nodes: number; links: number; fps: number }) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const g = useRef<Graph>({
    W: 0,
    H: 0,
    dpr: 1,
    pal: readPal(),
    globe: null,
    geo: { ex: 0, ey: 0, R: 0 },
    clusters: [],
    ripples: [],
    beams: [],
    inbound: [],
    hover: null,
    locked: null,
    phase: 0,
    t: 0,
    spin: 0,
  });
  /** 桌面数据放 ref：绘制循环读最新值，不因 React 重渲染重启动画 */
  const dataRef = useRef(desk);
  dataRef.current = desk;
  /** 视图范围（全量 / 单节点）与锁定目标同样走 ref：改它们不该重启 rAF */
  const viewRef = useRef({ scope, focusId });
  viewRef.current = { scope, focusId };
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  // ---------- 布局与静态球层 ----------
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = cvRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const buildGlobe = () => {
      const { W, H, dpr, pal: P } = g.current;
      if (!W || !H) return;
      if (!g.current.globe) g.current.globe = document.createElement("canvas");
      const gl = g.current.globe;
      gl.width = Math.round(W * dpr);
      gl.height = Math.round(H * dpr);
      const c = gl.getContext("2d");
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 球径照原型：min(W*0.40, H*0.53)，两侧数据流是浮在球面上的图层
      // （pointer-events:none 的浮层），不需要为它们让位
      const R = Math.min(W * 0.4, H * 0.53);
      const ex = W * 0.5;
      const ey = H * 0.52;
      g.current.geo = { ex, ey, R };

      c.fillStyle = P.bg;
      c.fillRect(0, 0, W, H);

      // 深空星点（亮色不画：纸面上撒点会显脏）
      if (!P.light) {
        let seed = 20261108;
        const rnd = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let i = 0; i < 150; i += 1) {
          const x = rnd() * W;
          const y = rnd() * H;
          if (Math.hypot(x - ex, y - ey) < R + 8) continue;
          c.fillStyle = P.ink2;
          c.globalAlpha = 0.12 + rnd() * 0.42;
          c.beginPath();
          c.arc(x, y, rnd() < 0.1 ? 1.3 : 0.65, 0, TAU);
          c.fill();
        }
        c.globalAlpha = 1;
      }

      // 大气外辉
      for (let i = 5; i >= 1; i -= 1) {
        c.strokeStyle = P.phos;
        c.globalAlpha = (P.light ? 0.014 : 0.011) * i;
        c.lineWidth = i * 3;
        c.beginPath();
        c.arc(ex, ey, R + i * 1.6, 0, TAU);
        c.stroke();
      }
      c.globalAlpha = 1;

      // 球面：亮色收成中性灰白（不偏黄，否则在 Notion 白纸上像一块脏渍）
      c.save();
      c.beginPath();
      c.arc(ex, ey, R, 0, TAU);
      c.clip();
      c.fillStyle = P.light ? "#e0e1da" : "#0b1718";
      c.fillRect(ex - R, ey - R, R * 2, R * 2);
      for (let i = 0; i < 20; i += 1) {
        const t = i / 19;
        c.fillStyle = P.light ? P.ink3 : P.phos;
        c.globalAlpha = (P.light ? 0.006 : 0.024) * (1 - t * 0.72);
        c.beginPath();
        c.arc(ex - R * 0.34, ey - R * 0.4, R * (1.5 - t * 0.92), 0, TAU);
        c.fill();
      }
      c.globalAlpha = 1;
      c.save();
      c.filter = `blur(${Math.round(R * 0.26)}px)`;
      c.fillStyle = P.light ? "#d2d4cc" : "#050d0d";
      c.globalAlpha = P.light ? 0.16 : 0.56;
      c.beginPath();
      c.arc(ex + R * 0.74, ey + R * 0.22, R * 1.04, 0, TAU);
      c.fill();
      c.restore();
      c.globalAlpha = 1;

      // 纬线（经线在每帧层随自转）
      c.strokeStyle = P.light ? P.ink3 : P.phos;
      c.lineWidth = 1;
      for (let k = -5; k <= 5; k += 1) {
        const lat = k * 0.26;
        const cy = ey + Math.sin(lat) * R * 0.92;
        const rx = Math.max(1, R * Math.cos(lat));
        c.globalAlpha = (P.light ? 0.1 : 0.075) * (1 - Math.abs(k) * 0.085);
        c.beginPath();
        c.ellipse(ex, cy, rx, Math.max(1, rx * 0.17), 0, 0, TAU);
        c.stroke();
      }
      // 球缘内侧散射
      c.strokeStyle = P.phos;
      c.globalAlpha = P.light ? 0.028 : 0.075;
      c.lineWidth = 14;
      c.beginPath();
      c.arc(ex, ey, R - 6, 0, TAU);
      c.stroke();
      // 轨道航线
      c.strokeStyle = P.phos;
      c.globalAlpha = P.light ? 0.06 : 0.085;
      c.lineWidth = 1;
      c.setLineDash([3, 8]);
      for (let k = 0; k < 3; k += 1) {
        const y = ey - R * 0.55 + k * R * 0.5;
        c.beginPath();
        c.moveTo(ex - R, y);
        c.quadraticCurveTo(ex, y - R * 0.32 - k * 14, ex + R, y - R * 0.1);
        c.stroke();
      }
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.restore();

      // 球缘
      c.strokeStyle = P.phos;
      c.globalAlpha = P.light ? 0.18 : 0.4;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(ex, ey, R, 0, TAU);
      c.stroke();
      c.globalAlpha = P.light ? 0.06 : 0.15;
      c.lineWidth = 5;
      c.beginPath();
      c.arc(ex, ey, R + 3, 0, TAU);
      c.stroke();
      // 暗角
      c.globalAlpha = P.light ? 0.02 : 0.28;
      c.fillStyle = P.bg;
      c.beginPath();
      c.rect(0, 0, W, H);
      c.arc(ex, ey, R * 1.42, 0, TAU, true);
      c.fill("evenodd");
      c.globalAlpha = 1;
    };

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.current.W = w;
      g.current.H = h;
      g.current.dpr = dpr;
      g.current.pal = readPal();
      buildGlobe();
      layoutClusters(g.current);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // 主题切换会改 data-mode：球层的颜色与明暗要跟着重建
    const mo = new MutationObserver(() => {
      g.current.pal = readPal();
      buildGlobe();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme", "class"] });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // ---------- 主循环 ----------
  useEffect(() => {
    const cv = cvRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let statAt = last;
    let statFrames = 0;

    const syncGraph = () => {
      const deskNow = dataRef.current;
      const { scope: sc, focusId: fid } = viewRef.current;
      // 只画**本群**的簇（2026-11-15）：与值台同一口径，别群的单不占球面
      // （否则在 B 群会看到 A 群的节点亮着，点开还是别群的单）。
      const all = jobsInThread(deskNow).filter((j) => j.group !== "archived");
      // 节点视图：只画被锁定的那一簇（没锁就退回全量，别把球面清空）
      const live = sc === "node" && fid ? all.filter((j) => j.id === fid) : all;
      const G = g.current;

      for (const job of live) {
        let c = G.clusters.find((x) => x.jobId === job.id);
        if (!c) {
          c = {
            jobId: job.id,
            x: G.W / 2,
            y: G.H / 2,
            tx: G.W / 2,
            ty: G.H / 2,
            angle: 0,
            alertUntil: 0,
            nodes: [],
            edges: [],
          };
          G.clusters.push(c);
          G.ripples.push({ x: G.W / 2, y: G.H / 2, r: 6, a: 1, color: "phos" });
        }
        for (const n of nodesOf(job, deskNow)) {
          let gn = c.nodes.find((x) => x.id === n.id);
          if (!gn) {
            gn = {
              id: n.id,
              label: n.label,
              state: n.state,
              seed: Math.random() * TAU,
              x: c.x,
              y: c.y,
              tx: c.x,
              ty: c.y,
              hx: c.x,
              hy: c.y,
              jobId: job.id,
            };
            c.nodes.push(gn);
            G.ripples.push({ x: c.x, y: c.y, r: 2, a: 1, color: "phos" });
          }
          gn.label = n.label;
          gn.state = n.state;
        }
        const want = nodesOf(job, deskNow);
        c.nodes = c.nodes.filter((gn) => want.some((n) => n.id === gn.id));
        if (job.action === "unblock" || job.status === "blocked") c.alertUntil = performance.now() + 800;
      }
      G.clusters = G.clusters.filter((c) => live.some((j) => j.id === c.jobId));
    };

    const drawSpin = (P: Pal) => {
      const G = g.current;
      const { ex, ey, R } = G.geo;
      if (!R) return;
      const phase = G.spin;
      const proj = (u: number, v: number) => {
        const lon = u * 1.7 + phase;
        const lat = v * 1.15;
        const cl = Math.cos(lat);
        const c = Math.cos(lon);
        return { x: ex + R * cl * Math.sin(lon), y: ey + R * Math.sin(lat), c };
      };
      ctx.save();
      ctx.beginPath();
      ctx.arc(ex, ey, R, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = P.light ? P.ink3 : P.phos;
      ctx.lineWidth = 1;
      for (let k = 0; k < 12; k += 1) {
        const lon = (k * Math.PI) / 12 + phase;
        const c = Math.cos(lon);
        if (c <= 0.02) continue;
        ctx.globalAlpha = (P.light ? 0.12 : 0.088) * Math.min(1, c * 1.5);
        ctx.beginPath();
        ctx.ellipse(ex, ey, Math.max(1, Math.abs(c) * R), R, 0, 0, TAU);
        ctx.stroke();
      }
      ([
        [1, 0.18],
        [1.16, 0.1],
        [1.32, 0.055],
      ] as [number, number][]).forEach(([scale, a], li) => {
        BLOBS.forEach((pts) => {
          const pp = pts.map((q) => proj(q[0] * scale, q[1] * scale));
          const vis = pp.reduce((m, p) => Math.min(m, p.c), 1);
          if (vis <= 0.04) return;
          const fade = Math.min(1, vis * 1.8);
          ctx.beginPath();
          ctx.moveTo(pp[0].x, pp[0].y);
          for (let i = 0; i < pp.length; i += 1) {
            const q = pp[i];
            const b = pp[(i + 1) % pp.length];
            ctx.quadraticCurveTo(q.x, q.y, (q.x + b.x) / 2, (q.y + b.y) / 2);
          }
          ctx.closePath();
          if (li === 0) {
            ctx.fillStyle = P.light ? P.ink3 : P.dim;
            ctx.globalAlpha = (P.light ? 0.05 : 0.05) * fade;
            ctx.fill();
          }
          ctx.globalAlpha = (P.light ? a * 0.7 : a) * fade;
          ctx.stroke();
        });
      });
      STATIONS.forEach(([u, v]) => {
        const p = proj(u, v);
        if (p.c <= 0.06) return;
        const a = Math.min(1, p.c * 1.5);
        ctx.fillStyle = P.phos;
        ctx.globalAlpha = (P.light ? 0.34 : 0.5) * a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, TAU);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const frameDraw = () => {
      const now = performance.now();
      const dt = Math.min(64, now - last);
      last = now;
      const G = g.current;
      const { W, H, pal: P } = G;
      if (!W || !H) {
        raf = window.requestAnimationFrame(frameDraw);
        return;
      }
      G.t = now / 1000;
      G.spin += dt * 0.00006;

      ctx.clearRect(0, 0, W, H);
      if (G.globe) ctx.drawImage(G.globe, 0, 0, W, H);
      else {
        ctx.fillStyle = P.bg;
        ctx.fillRect(0, 0, W, H);
      }
      drawSpin(P);

      syncGraph();

      const placed: { x: number; y: number; w: number; h: number }[] = [];

      // 簇位置平滑（每帧向目标靠 5%）
      G.clusters.forEach((c) => {
        c.x += (c.tx - c.x) * 0.055;
        c.y += (c.ty - c.y) * 0.055;
        c.nodes.forEach((n) => {
          n.x += (n.tx - n.x) * 0.085;
          n.y += (n.ty - n.y) * 0.085;
        });
      });
      // 布局随尺寸与节点数变化重算（每帧算一次，代价是几次三角函数）
      layoutClusters(G);

      // 簇间淡关联
      ctx.strokeStyle = P.grid2;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      for (let i = 0; i < G.clusters.length; i += 1) {
        for (let j = i + 1; j < G.clusters.length; j += 1) {
          const a = G.clusters[i];
          const b = G.clusters[j];
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(W / 2, H / 2, b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);

      // 核心 → 簇主干
      G.clusters.forEach((c, i) => {
        const alert = now < c.alertUntil;
        ctx.strokeStyle = alert ? P.seal : P.dim;
        ctx.globalAlpha = alert ? 0.75 : 0.34;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 8]);
        ctx.lineDashOffset = -(G.t * 22 + i * 9);
        ctx.beginPath();
        ctx.moveTo(W / 2, H / 2);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.globalAlpha = 1;

        for (let k = 0; k < 2; k += 1) {
          const t = (G.t * 0.34 + k * 0.5 + i * 0.17) % 1;
          const x = W / 2 + (c.x - W / 2) * t;
          const y = H / 2 + (c.y - H / 2) * t;
          ctx.fillStyle = alert ? P.seal : P.phos;
          ctx.shadowBlur = 9;
          ctx.shadowColor = alert ? P.seal : P.phos;
          ctx.beginPath();
          ctx.arc(x, y, 1.9, 0, TAU);
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // 簇心编号牌（工单号）
        ctx.strokeStyle = alert ? P.seal : P.dim;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const bx = c.x - 20;
        const by = c.y - 25;
        ctx.fillStyle = P.bg;
        ctx.fillRect(bx, by, 40, 14);
        ctx.strokeStyle = alert ? P.seal : P.line2;
        ctx.strokeRect(bx + 0.5, by + 0.5, 39, 13);
        ctx.fillStyle = alert ? P.seal : P.ink3;
        ctx.font = '10px "IBM Plex Mono", Consolas, monospace';
        ctx.textAlign = "center";
        ctx.fillText(c.jobId.slice(-6), c.x, by + 10);
        placed.push({ x: bx, y: by, w: 40, h: 14 });
      });

      // 簇内连线 + 粒子
      G.clusters.forEach((c, ci) => {
        const alert = now < c.alertUntil;
        c.edges.forEach((e, ei) => {
          const a = c.nodes[e[0]];
          const b = c.nodes[e[1]];
          if (!a || !b) return;
          const live = a.state === "live" || b.state === "live";
          const hot = a.state === "alert" || b.state === "alert" || alert;
          ctx.strokeStyle = hot ? P.seal : live ? P.amber : P.dim;
          ctx.globalAlpha = hot ? 0.58 : live ? 0.46 : 0.2;
          ctx.lineWidth = 1;
          const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
          const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx, my, b.x, b.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          if (live || hot) {
            const t = (G.t * (hot ? 0.5 : 0.32) + ei * 0.21 + ci * 0.13) % 1;
            const u = 1 - t;
            const x = u * u * a.x + 2 * u * t * mx + t * t * b.x;
            const y = u * u * a.y + 2 * u * t * my + t * t * b.y;
            ctx.fillStyle = hot ? P.seal : P.amber;
            ctx.shadowBlur = 10;
            ctx.shadowColor = hot ? P.seal : P.amber;
            ctx.beginPath();
            ctx.arc(x, y, 2.1, 0, TAU);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        });
        ctx.strokeStyle = P.line2;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        c.nodes.forEach((n) => {
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(n.x, n.y);
          ctx.stroke();
        });
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      });

      // 节点
      G.clusters.forEach((c) => {
        c.nodes.forEach((n) => {
          const fx = n.x + Math.sin(G.t * 0.7 + n.seed) * 2.1;
          const fy = n.y + Math.cos(G.t * 0.6 + n.seed) * 1.8;
          n.hx = fx;
          n.hy = fy;
          const col =
            n.state === "alert" ? P.seal : n.state === "live" ? P.amber : n.state === "done" ? P.phos : P.line2;
          const pulse =
            n.state === "live"
              ? 0.5 + 0.5 * Math.sin(G.t * 3 + n.seed)
              : n.state === "alert"
                ? 0.35 + 0.65 * Math.abs(Math.sin(G.t * 4.4))
                : 0;
          if (n.state !== "idle") {
            ctx.globalAlpha = 0.13 + 0.18 * pulse;
            ctx.fillStyle = col;
            ctx.shadowBlur = 16;
            ctx.shadowColor = col;
            ctx.beginPath();
            ctx.arc(fx, fy, 9 + 5 * pulse, 0, TAU);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
          }
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(fx, fy, 6.2, 0, TAU);
          ctx.stroke();
          ctx.fillStyle = n.state === "idle" ? P.bg : col;
          ctx.beginPath();
          ctx.arc(fx, fy, n.state === "done" ? 3.6 : 2.6, 0, TAU);
          ctx.fill();

          if (G.hover === n.id || G.locked === n.id) {
            const r = 13 + 2 * Math.sin(G.t * 2.4);
            ctx.strokeStyle = G.locked === n.id ? P.phos : P.ink2;
            ctx.lineWidth = 1.2;
            ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]).forEach(([sx, sy]) => {
              ctx.beginPath();
              ctx.moveTo(fx + sx * r, fy + sy * r - sy * 5);
              ctx.lineTo(fx + sx * r, fy + sy * r);
              ctx.lineTo(fx + sx * r - sx * 5, fy + sy * r);
              ctx.stroke();
            });
          }

          // 标签牌：避开左右数据流占用的边缘，重叠就往下让；
          // 单任务标题可能很长，标签牌按最长 128px 截断，别横着糊满球面
          let label = n.label || "";
          ctx.font = '12px "Archivo", "Microsoft YaHei", sans-serif';
          if (ctx.measureText(label).width > 128) {
            let cut = label;
            while (cut.length > 1 && ctx.measureText(`${cut}…`).width > 128) cut = cut.slice(0, -1);
            label = `${cut}…`;
          }
          const w = ctx.measureText(label).width + 12;
          const guardL = W > 620 ? 176 : 4;
          const guardR = W > 620 ? 186 : 4;
          const lx = clamp(fx - w / 2, guardL, Math.max(guardL, W - w - guardR));
          let ly = fy + 12;
          let tries = 0;
          const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
            !(lx + w < r.x || lx > r.x + r.w || ly + 17 < r.y || ly > r.y + r.h);
          while (placed.some(overlaps) && tries < 4) {
            ly += 19;
            tries += 1;
          }
          if (tries >= 4) ly = clamp(fy - 30, 4, H - 21);
          placed.push({ x: lx, y: ly, w, h: 17 });
          ctx.fillStyle = P.bg;
          ctx.fillRect(lx, ly, w, 17);
          ctx.strokeStyle = G.locked === n.id ? P.phos : P.line;
          ctx.lineWidth = 1;
          ctx.strokeRect(lx + 0.5, ly + 0.5, w - 1, 16);
          ctx.fillStyle = n.state === "idle" ? P.ink3 : P.ink2;
          ctx.textAlign = "left";
          ctx.fillText(label, lx + 6, ly + 12);
        });
      });

      // 核心：风铃中枢
      const cx = W / 2;
      const cy = H / 2;
      const breathe = 0.5 + 0.5 * Math.sin(G.t * 1.7);
      const coreCol = P.phos;
      ctx.globalAlpha = 0.1 + 0.1 * breathe;
      ctx.fillStyle = coreCol;
      ctx.shadowBlur = 34;
      ctx.shadowColor = coreCol;
      ctx.beginPath();
      ctx.arc(cx, cy, 26 + 7 * breathe, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(G.t * 0.22);
      ctx.strokeStyle = coreCol;
      ctx.globalAlpha = 0.62;
      ctx.lineWidth = 1;
      for (let i = 0; i < 24; i += 1) {
        const a = (i * Math.PI) / 12;
        const r1 = 28;
        const r2 = i % 6 === 0 ? 35 : 31;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = coreCol;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, TAU);
      ctx.stroke();

      // 中枢铭牌
      const bw = 52;
      const bh = 20;
      ctx.fillStyle = P.bg;
      ctx.globalAlpha = 0.94;
      ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = coreCol;
      ctx.lineWidth = 1;
      ctx.shadowBlur = 12;
      ctx.shadowColor = coreCol;
      ctx.strokeRect(cx - bw / 2 + 0.5, cy - bh / 2 + 0.5, bw - 1, bh - 1);
      ctx.shadowBlur = 0;
      ctx.fillStyle = coreCol;
      ctx.font = '11px "IBM Plex Mono", Consolas, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("LYNN", cx, cy + 0.5);
      ctx.textBaseline = "alphabetic";

      // 事件射线
      G.beams = G.beams.filter((b) => b.t < 1);
      G.beams.forEach((b) => {
        b.t += dt / 1000;
        const t = Math.min(1, b.t);
        const col = b.color === "seal" ? P.seal : b.color === "amber" ? P.amber : P.phos;
        const x = b.x1 + (b.x2 - b.x1) * t;
        const y = b.y1 + (b.y2 - b.y1) * t;
        const tail = Math.max(0, t - 0.16);
        const tx = b.x1 + (b.x2 - b.x1) * tail;
        const ty = b.y1 + (b.y2 - b.y1) * tail;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.75;
        ctx.shadowBlur = 12;
        ctx.shadowColor = col;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, TAU);
        ctx.fill();
      });

      // 涟漪
      G.ripples = G.ripples.filter((r) => r.a > 0);
      G.ripples.forEach((r) => {
        r.r += 1.7;
        r.a -= 0.022;
        const col = r.color === "seal" ? P.seal : r.color === "amber" ? P.amber : P.phos;
        ctx.strokeStyle = col;
        ctx.globalAlpha = Math.max(0, r.a) * 0.7;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      // 入队粒子：左缘 → 核心
      G.inbound = G.inbound.filter((p) => p.t < 1);
      G.inbound.forEach((p) => {
        p.t += 0.012;
        const t = Math.min(1, p.t);
        const col = P.amber;
        const x = p.x + (cx - p.x) * t;
        const y = p.y + (cy - p.y) * t;
        ctx.fillStyle = col;
        ctx.shadowBlur = 12;
        ctx.shadowColor = col;
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(x - 10, y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      // 读数节流上报：每 900ms 一次，避免每帧 setState 把 React 拖成幻灯片
      statFrames += 1;
      if (now - statAt >= 900) {
        const nodes = G.clusters.reduce((a, c) => a + c.nodes.length, 0);
        const links = G.clusters.reduce((a, c) => a + c.edges.length, 0);
        statsRef.current?.({ nodes, links, fps: Math.round((statFrames * 1000) / (now - statAt)) });
        statFrames = 0;
        statAt = now;
      }

      raf = window.requestAnimationFrame(frameDraw);
    };

    raf = window.requestAnimationFrame(frameDraw);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, []);

  // ---------- 命中测试：悬停光标 / 点击锁定 ----------
  const hit = (mx: number, my: number): GNode | null => {
    const G = g.current;
    let found: GNode | null = null;
    let best = 20;
    G.clusters.forEach((c) =>
      c.nodes.forEach((n) => {
        const d = Math.hypot(n.hx - mx, n.hy - my);
        if (d < best) {
          best = d;
          found = n;
        }
      }),
    );
    return found;
  };

  return (
    <div
      className="cs-map"
      ref={wrapRef}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const n = hit(e.clientX - r.left, e.clientY - r.top);
        g.current.hover = n ? n.id : null;
        e.currentTarget.style.cursor = n ? "pointer" : "default";
      }}
      onMouseLeave={() => {
        g.current.hover = null;
      }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const n = hit(e.clientX - r.left, e.clientY - r.top);
        g.current.locked = n ? n.id : null;
        onPick?.(n ? n.jobId : null, { x: e.clientX - r.left, y: e.clientY - r.top });
      }}
    >
      <canvas ref={cvRef} className="cs-canvas" />
    </div>
  );
}
