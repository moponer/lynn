import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 根集合（工作区模型，2026-11-10 定稿）。
 *
 * 工作区不再是一个可变的全局字符串，而是「主根 + 附加根」：
 *  - primary：唯一可写主根；可以为空（无主根 = 临时任务，产出落任务卷宗）
 *  - extras：附加根，mode=ro 只读 / rw 可写；rw 只能由用户逐次授权
 *
 * 继承链：DefaultRoot → SessionRoots → TeamRoots → TaskRoots → 成员有效根。
 * 只读根取并集，可写主根只传一个；扩权只能由用户发起。
 */

export type RootMode = "rw" | "ro";
export type RootScope = "default" | "session" | "team" | "task";

export interface Root {
  path: string;
  mode: RootMode;
  scope: RootScope;
  label?: string;
  addedAt: string;
  addedBy: "user" | "inherit";
}

export interface RootSet {
  /**
   * 主根（可写）。undefined = 未设置（按上层/默认兜底）；
   * 显式无主根用 `{ extras: [] }` 表示，与 undefined 区分。
   */
  primary?: string;
  extras: Root[];
}

export function emptyRoots(): RootSet {
  return { extras: [] };
}

function asAbs(p: unknown): string {
  const s = String(p ?? "").trim();
  if (!s) return "";
  try {
    return path.resolve(s);
  } catch {
    return "";
  }
}

/** 宽容解析落盘数据：数组/字符串/缺字段都认；非法条目丢弃，不抛 */
export function normalizeRoots(input: unknown): RootSet | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const p = asAbs(input);
    return p ? { primary: p, extras: [] } : emptyRoots();
  }
  if (typeof input !== "object") return null;
  const raw = input as { primary?: unknown; extras?: unknown };
  const primary = asAbs(raw.primary) || undefined;
  const extras: Root[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw.extras) ? raw.extras : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Partial<Root>;
    const p = asAbs(r.path);
    if (!p || p === primary || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    extras.push({
      path: p,
      mode: r.mode === "rw" ? "rw" : "ro",
      scope: r.scope === "default" || r.scope === "team" || r.scope === "task" ? r.scope : "session",
      ...(typeof r.label === "string" && r.label.trim() ? { label: r.label.trim().slice(0, 40) } : {}),
      addedAt: typeof r.addedAt === "string" && r.addedAt ? r.addedAt : new Date().toISOString(),
      addedBy: r.addedBy === "user" ? "user" : "inherit",
    });
  }
  return { ...(primary ? { primary } : {}), extras };
}

/** 从会话/任务记录里取根集合：优先新字段，回退旧的 projectRoot 字段 */
export function rootsFromLegacy(input: {
  roots?: unknown;
  projectRoot?: string | null;
}): RootSet | null {
  const normalized = normalizeRoots(input.roots);
  if (normalized) return normalized;
  const legacy = asAbs(input.projectRoot);
  return legacy ? { primary: legacy, extras: [] } : null;
}

export function primaryOf(roots?: RootSet | null): string {
  return asAbs(roots?.primary);
}

/** 可读根（成员可见）：主根 + 所有附加根；主根自身不重复列进 extras */
export function readableRoots(roots?: RootSet | null): string[] {
  const primary = primaryOf(roots);
  const out: string[] = primary ? [primary] : [];
  const seen = new Set(out.map((p) => p.toLowerCase()));
  for (const r of roots?.extras ?? []) {
    const p = asAbs(r.path);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

/** 可写根：只有主根 + 用户显式授权的 rw 附加根 */
export function writableRoots(roots?: RootSet | null): string[] {
  const primary = primaryOf(roots);
  const out: string[] = primary ? [primary] : [];
  const seen = new Set(out.map((p) => p.toLowerCase()));
  for (const r of roots?.extras ?? []) {
    if (r.mode !== "rw") continue;
    const p = asAbs(r.path);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

/** 事务式新增：同路径已存在则升级模式（ro → rw 只能由用户调用方把关） */
export function addRoot(
  roots: RootSet | undefined,
  input: { path: string; mode?: RootMode; scope?: RootScope; label?: string; addedBy?: "user" | "inherit" },
): RootSet {
  const base = normalizeRoots(roots) ?? emptyRoots();
  const p = asAbs(input.path);
  if (!p) return base;
  const mode: RootMode = input.mode === "rw" ? "rw" : "ro";
  if (base.primary === p) return base;
  const extras = base.extras.filter((r) => r.path.toLowerCase() !== p.toLowerCase());
  extras.push({
    path: p,
    mode,
    scope: input.scope ?? "session",
    ...(input.label ? { label: input.label.slice(0, 40) } : {}),
    addedAt: new Date().toISOString(),
    addedBy: input.addedBy ?? "user",
  });
  return { ...base, extras };
}

export function removeRoot(roots: RootSet | undefined, target: string): RootSet {
  const base = normalizeRoots(roots) ?? emptyRoots();
  const p = asAbs(target);
  return { ...base, extras: base.extras.filter((r) => r.path.toLowerCase() !== p.toLowerCase()) };
}

/** 前缀判定：解析后仍在根内（Windows 大小写不敏感） */
export function isInside(root: string, target: string): boolean {
  if (!root) return false;
  const rb = path.resolve(root);
  const full = path.resolve(target);
  const rel = path.relative(rb, full);
  if (rel === "") return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return process.platform !== "win32" || full.toLowerCase().startsWith(rb.toLowerCase());
}

/** 盘符根 / 文件系统根 */
export function isDriveRoot(p: string): boolean {
  const abs = asAbs(p);
  if (!abs) return false;
  return path.parse(abs).root === abs;
}

/**
 * 永久禁区：这些目录不能作为任何根（主根或只读）授权出去。
 * 返回原因；null = 允许。盘符根不在这里判（由调用方按模式决定）。
 */
export function forbiddenRootReason(p: string, dataRoot: string): string | null {
  const abs = asAbs(p);
  if (!abs) return "路径不合法";
  const data = path.resolve(dataRoot);
  if (abs === data) return "不能授权风铃自己的数据目录（里面是凭据、会话与团队档案）";
  // 数据根内的敏感子目录也拒；但数据根下的普通项目目录（测试/隔离环境的 workspace/project）允许，
  // 否则"在数据根内建临时项目"这种正常用法会被无差别拦住。
  for (const name of ["team", "threads", "kernel", "session", "checkpoints", "logs", "plugins", "skills"]) {
    if (isInside(path.join(data, name), abs)) return "不能授权风铃的数据子目录（凭据/会话/编制都在里面）";
  }

  const lower = abs.toLowerCase();
  const win = process.platform === "win32";
  // 整个用户目录在各平台都算敏感根：里面通常同时有凭据、文档与其他项目。
  // 允许授权具体子目录；realpath 后还会由调用方再验一次，符号链接不能绕过。
  const home = asAbs(os.homedir());
  if (home && (win ? lower === home.toLowerCase() : abs === home)) {
    return "不能授权整个用户目录，请选具体子目录";
  }
  if (win) {
    const sys = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
    if (lower === sys || lower.startsWith(sys + path.sep)) return "不能授权系统目录（Windows）";
    if (lower.includes("\\program files")) return "不能授权程序安装目录";
    if (path.parse(abs).root.toLowerCase() === lower) {
      // 盘符根：系统盘根永久拒；其它盘交给调用方按「整盘只读三段门」处理
      const sysDrive = path.parse(process.env.SystemRoot || "C:\\Windows").root.toLowerCase();
      if (lower === sysDrive) return "不能授权系统盘根：请选具体目录，或换一个数据盘。";
      return null;
    }
  }
  return null;
}

/** 目录存在性校验，返回错误文案；null = 可用 */
export function rootDirError(p: string): string | null {
  const abs = asAbs(p);
  if (!abs) return "路径不合法";
  try {
    return fs.statSync(abs).isDirectory() ? null : `${abs} 不是目录`;
  } catch {
    return `目录不存在：${abs}`;
  }
}

/** 界面短名：客户资料 · D 盘根 · LynnWorkspace */
export function rootLabel(p: string): string {
  const abs = asAbs(p);
  if (!abs) return "无工作区";
  if (isDriveRoot(abs)) return `${path.parse(abs).root.replace(/[\\/]/g, "") || abs} 盘`;
  return path.basename(abs) || abs;
}
