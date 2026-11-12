// 官方 L1 执行工具集（M0-06）：read/write/edit/list/glob/grep/run_command。
// 三条硬约束：
//   1) 一切路径都钉在 root 里（逃逸直接拒），root 由调用方给（任务工作区 / 项目工作区）；
//   2) 同一文件的写串行（每文件一条 Promise 队列），并发写不会互相覆盖；
//   3) 每次写都留 diff（供 M1-12 的 /undo 检查点与界面展示复用，不另写一套）。
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { normalizeTargetPath } from "./member-path";
import { buildDocx, type DocxBlock } from "./docx";

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** 中间变化段的简版 diff（裁剪到 1200 字符） */
  diff: string;
  at: string;
}

export interface ToolkitOptions {
  /** 命令执行超时（默认 120s） */
  commandTimeoutMs?: number;
  /** 单次命令输出上限（默认 8000 字符） */
  outputCap?: number;
  /** 审计回调：命中/放行命令都留痕（M1-11，壳写 audit.jsonl） */
  onAudit?: (ev: {
    kind: "cmd_blocked" | "cmd_net" | "cmd_run" | "cmd_auto";
    command: string;
    why?: string;
    cwd: string;
  }) => void;
  /** 写之前通知壳（M1-12 检查点）：existed=false 表示这轮新建 */
  onBeforeWrite?: (rel: string, full: string, existed: boolean) => void;
  /** office 能力注入（M2-06）：csv 永远可用；xlsx 由壳按引擎健康决定（缺引擎如实报） */
  office?: {
    read: (file: string) => { table?: { headers: string[]; rows: string[][] }; error?: string };
    write: (file: string, table: { headers: string[]; rows: string[][] }) => { ok: boolean; error?: string };
  };
  /** browser 能力注入（M2-07）：Playwright/Edge 单例；未注入时如实提示 */
  browser?: {
    navigate: (url: string) => Promise<string>;
    snapshot: () => Promise<string>;
    click: (target: string) => Promise<string>;
    fill: (target: string, value: string) => Promise<string>;
    extract: (kind: "text" | "table", selector?: string) => Promise<string>;
    close: () => Promise<string>;
  };
  /** 知识库写入（M2-08）：抓取结果入 ~/.lynn/knowledge/ */
  kb?: {
    add: (name: string, markdown: string) => { ok: boolean; file?: string; error?: string };
  };
  /**
   * 只读授权目录（用户显式授予，按任务生效）：读可以在这些目录里，**写永远只能在工作区**。
   * 传函数 = 每次读时现取——成员跑到一半用户才授权，也能立刻生效（不必停掉重派）。
   */
  readRoots?: string[] | (() => string[]);
  /**
   * 用户显式授予的可写附加根（默认没有）：命令可以把 cwd 指到这些目录里；
   * 文件写入仍然只走工作区（这条是"跨项目跑构建/测试"的口子，不是放开写）。
   */
  writableRoots?: string[] | (() => string[]);
  /**
   * 删除类命令的审批闸：成员可以改文件，但不能悄悄删。
   * 返回 ok=false 时命令不执行；未注入时一律拒绝（宁可做不了，也不给无审批的删除）。
   * 注意：工具层会先做"低风险自清理"分级（见 runCommand），能自证风险的不会再打扰这里。
   */
  onBeforeCommand?: (command: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 本单开始时间（ms）。删除目标如果是这之后才出现的文件/目录，说明是成员自己刚造的，
   * 属于"自清理"——不弹审批卡（实机事故：成员 `echo probe> x.txt & del x.txt` 也要用户点头）。
   */
  runStartedAt?: number;
  /**
   * 工作区内删除是否免审批（权限档=全权时由壳注入 true）。
   * 工作区外仍然一律拒绝，与档位无关。
   */
  autoDeleteInWorkspace?: () => boolean;
  /** 中止信号：用户点「停」时连正在跑的命令一起杀（否则最长要等 120s 超时） */
  signal?: () => AbortSignal | undefined;
}

/** 删除类命令：一律要用户点头（含"移动/改名"——原位置等于删掉） */
const DESTRUCTIVE: { re: RegExp; why: string }[] = [
  { re: /\bdel\b/i, why: "del 删除文件" },
  { re: /\berase\b/i, why: "erase 删除文件" },
  { re: /\brmdir\b/i, why: "rmdir 删除目录" },
  { re: /(^|[\s;&|(])rd\b/i, why: "rd 删除目录" },
  { re: /(^|[\s;&|(])rm\b/i, why: "rm 删除文件/目录" },
  { re: /remove-item/i, why: "Remove-Item 删除" },
  { re: /(^|[\s;&|(])mv\b/i, why: "mv 移动（原位置即删除）" },
  { re: /\bmove\b/i, why: "move 移动（原位置即删除）" },
  { re: /\bren(ame)?\b/i, why: "改名/移动" },
  { re: /git\s+clean/i, why: "git clean 删未跟踪文件" },
  { re: /git\s+reset\s+--hard/i, why: "git reset --hard 丢弃改动" },
];

/** 纯函数：命令是否删除类（返回原因；null = 不是） */
export function destructiveReason(command: string): string | null {
  for (const d of DESTRUCTIVE) {
    if (d.re.test(command)) return d.why;
  }
  return null;
}

/**
 * 纯函数：删除类命令真正要动哪些路径（相对/绝对均可）。
 * 解析不出来（通配符、变量、管道里拼出来的路径）一律返回 null = 看不懂，按高风险走人工审批。
 */
export function destructiveTargets(command: string): string[] | null {
  const re = /(?:^|[\s;&|(])(?:del|erase|rd|rmdir|rm|remove-item|mv|move|ren|rename)\s+([^;&|)]+)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(command);
  while (m) {
    for (const token of m[1].trim().split(/\s+/)) {
      if (!token) continue;
      const bare = token.replace(/^["']|["']$/g, "");
      // 开关：-r / -rf / /s / /q / -Recurse …
      if (/^[-/][A-Za-z]+$/i.test(bare)) continue;
      if (!bare) continue;
      out.push(bare);
    }
    m = re.exec(command);
  }
  if (!out.length) return null;
  // 通配符 / 环境变量 / PowerShell 子表达式：具体删哪些文件说不清，交给用户
  if (out.some((t) => /[*?%$`]/.test(t))) return null;
  return out;
}

const READ_CAP = 200_000;
const DIFF_CAP = 1_200;

/** 解析路径：必须落在 root 内 */
export function resolveWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const full = normalizeTargetPath(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`路径越界：${target} 不在工作区内。只能访问工作区里的文件。`);
  }
  return full;
}

/**
 * 读路径解析：工作区 → 直接用；只读授权目录 → 允许读（`outside = true`）；其余拒绝。
 * **写路径绝不能用这个函数**——审计与越界拦截都靠"写只走 resolveWithin"这条铁律。
 * 归一化放在解析前：`/F:/repo/x` 这类伪 POSIX 写法不归一就会解析成 `C:\F:\repo\x`，
 * 明明已授权 `F:\repo` 也判越界（2026-11-11 长任务实测，诱发 20+ 次无效重派）。
 */
export function resolveReadable(
  root: string,
  readRoots: string[],
  target: string,
): { full: string; outside: boolean; root?: string } {
  const base = path.resolve(root);
  const full = target === "" || target === "." ? base : normalizeTargetPath(base, target);
  const rel = path.relative(base, full);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return { full, outside: false };
  for (const r of readRoots) {
    const rb = path.resolve(r);
    const rrel = path.relative(rb, full);
    if (!rrel.startsWith("..") && !path.isAbsolute(rrel)) return { full, outside: true, root: rb };
  }
  throw new Error(
    `路径越界：${target} 既不在工作区，也不是本单授权的只读目录。` +
      (readRoots.length ? `已授权只读：${readRoots.join("、")}` : "（本单没有只读授权；需要的话让用户右键这张单「授权只读目录」）"),
  );
}

/** 行级简版 diff：去掉公共前后缀，中间整段按 - / + 展示 */
export function simpleDiff(before: string, after: string): { diff: string; added: number; removed: number } {
  const split = (s: string) => {
    const lines = s ? s.split(/\r?\n/) : [];
    // 末尾换行不算一行空内容，否则「写一个文件」会凭空多出 +1
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const removedLines = a.slice(head, a.length - tail);
  const addedLines = b.slice(head, b.length - tail);
  if (!removedLines.length && !addedLines.length) return { diff: "（内容未变）", added: 0, removed: 0 };
  const out = [
    `@@ 第 ${head + 1} 行起 @@`,
    ...removedLines.slice(0, 30).map((l) => `- ${l}`),
    ...addedLines.slice(0, 30).map((l) => `+ ${l}`),
    removedLines.length > 30 || addedLines.length > 30 ? `…（还有 ${Math.max(0, removedLines.length - 30) + Math.max(0, addedLines.length - 30)} 行未展示）` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { diff: out.length > DIFF_CAP ? out.slice(0, DIFF_CAP) + "…" : out, added: addedLines.length, removed: removedLines.length };
}

/**
 * 危险命令规则（M1-11 纵深防御，不是 OS 沙箱）：
 * 只在明显破坏/提权/远程代码执行这些"没有正当理由"的写法上直接拒绝，
 * 其余命令仍会执行——边界靠工作区钉扎 + 审计，而不是假装有沙箱。
 */
const DANGEROUS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\*)/i, why: "递归删除根目录/家目录" },
  { re: /\bdel\s+\/[fsq].*[\\/]?\*/i, why: "Windows 递归强删" },
  { re: /\bformat\s+[a-z]:/i, why: "格式化磁盘" },
  { re: /\bmkfs(\.|\s)/i, why: "格式化文件系统" },
  { re: /:\(\)\s*\{.*\};:/, why: "fork 炸弹" },
  { re: /\bshutdown\b|\breboot\b/i, why: "关机/重启" },
  { re: /curl[^|]*\|\s*(ba)?sh/i, why: "管道直执行远程脚本" },
  { re: /(iwr|invoke-webrequest|curl)[^;|]*\|\s*iex/i, why: "下载后直接执行（PowerShell）" },
  { re: />\s*\/dev\/sd[a-z]/i, why: "直接写块设备" },
  { re: /\b(bcdedit|cipher\s+\/w|vssadmin\s+delete)\b/i, why: "破坏启动/擦除卷影副本" },
  { re: /\bnet\s+user\b.*\/add/i, why: "新建系统账户（提权）" },
  { re: /\breg\s+add\s+HKLM/i, why: "改本机注册表（提权）" },
  { re: /\btakeown\s+\/f\b|\bicacls\b.*\/grant\b/i, why: "改文件所有权/权限" },
  { re: /\btaskkill\b.*\/f\s*\/im\s+(explorer|winlogon|csrss|lsass)/i, why: "强杀系统进程" },
  { re: /\bpowershell[^|]*-(enc|encodedcommand)\b/i, why: "编码命令（隐藏意图）" },
  { re: /\b(certutil\s+-urlcache|bitsadmin)\b/i, why: "借系统工具下载载荷" },
  { re: /\bnc\s+.*-e\b|\bncat\s+.*-e\b/i, why: "反弹 shell" },
];

/** 出站动作（只审计不拦）：真正的拦截要靠域名白名单，那是后续的事 */
const OUTBOUND = /\b(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|Invoke-WebRequest|iwr|git\s+clone|npm\s+(i|install|publish))\b|https?:\/\//i;

// ---------- 命令里的路径逃逸 ----------
//
// 文件工具被钉在工作区，命令却能随手读全盘——真实事故：成员的 powershell 去
// `Get-ChildItem 'D:\qcc\Hermix Desktop'`、`C:\Users\...\.hermix` 翻用户别的项目。
// 这里做字面量绝对路径识别（拼出来的路径拦不住，OS 级隔离是 M1-11 的活，不谎报沙箱）。
const PATH_BOUNDARY = "[\\s\"'=()`;,|&]";
const ABS_WIN = new RegExp(`(?:^|${PATH_BOUNDARY})([A-Za-z]:[\\\\/][^\\s"'\`;|&)]*)`, "g");
// UNC 只认 `\\host\share` 这种**两级**形态：命令里的正则字面量 `\\.cargo`、`\target\`
// 以前被当成 UNC 路径拦下（实机误报 5 次，成员被迫改写命令重试）。
const ABS_UNC = new RegExp(`(?:^|${PATH_BOUNDARY})(\\\\\\\\[^\\\\\\s"'\`;|&)]+\\\\[^\\s"'\`;|&)]+)`, "g");
// POSIX 只认**带路径段**的绝对路径：`dir /s /b`、`cmd /c` 这类 Windows 单字母开关不是路径。
const ABS_POSIX = new RegExp(`(?:^|${PATH_BOUNDARY})(/(?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]*)`, "g");
/** Windows 命令开关（/s /b /c …）：单字母或双字母，不可能是文件路径 */
const CMD_SWITCH = /^\/[A-Za-z]{1,2}$/;
const HOME_VARS = /(%USERPROFILE%|\$env:USERPROFILE|\$HOME|(^|[\s"'=])~[\\/])/i;

/**
 * 找出命令里第一处越出 root 的路径。返回人话原因；没有越界返回 null。
 * 纯函数（不碰文件系统），可单测。
 */
export function findPathEscape(command: string, root: string, extraRoots: string[] = []): string | null {
  const rootAbs = path.resolve(root);
  const allowed = [rootAbs, ...extraRoots.map((r) => path.resolve(r))];
  if (HOME_VARS.test(command)) return "引用了用户主目录（%USERPROFILE% / $HOME / ~）";
  const targets: string[] = [];
  for (const re of [ABS_WIN, ABS_UNC, ABS_POSIX]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(command);
    while (m) {
      targets.push(m[1]);
      m = re.exec(command);
    }
  }
  for (const raw of targets) {
    const clean = raw.replace(/[.,;:]+$/, "");
    if (CMD_SWITCH.test(clean)) continue; // /s /b /c：命令开关，不是路径
    let abs: string;
    try {
      abs = path.resolve(rootAbs, clean);
    } catch {
      continue;
    }
    const inside = allowed.some((b) => {
      const rel = path.relative(b, abs);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!inside) return `越出工作区与已授权根的路径：${clean}`;
  }
  // `..` 段：相对路径也能上跳
  if (/(^|[\s"'=()`;,|&])\.\.[\\/]/.test(command)) return "包含 .. 上跳路径";
  return null;
}

export class Toolkit {
  private queues = new Map<string, Promise<unknown>>();
  private changeLog: FileChange[] = [];
  private readonly root: string;
  private readonly commandTimeoutMs: number;
  private readonly outputCap: number;
  private readonly onAudit?: ToolkitOptions["onAudit"];
  private readonly onBeforeWrite?: ToolkitOptions["onBeforeWrite"];
  private readonly office?: ToolkitOptions["office"];
  private readonly browser?: ToolkitOptions["browser"];
  private readonly kb?: ToolkitOptions["kb"];
  private readonly readRootsSource: () => string[];
  private readonly writableRootsSource: () => string[];
  private readonly onBeforeCommand?: ToolkitOptions["onBeforeCommand"];
  private readonly runStartedAt: number;
  private readonly autoDeleteInWorkspace?: () => boolean;
  private readonly signalSource?: () => AbortSignal | undefined;

  constructor(root: string, opts: ToolkitOptions = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 120_000;
    this.outputCap = opts.outputCap ?? 8_000;
    this.onAudit = opts.onAudit;
    this.onBeforeWrite = opts.onBeforeWrite;
    this.office = opts.office;
    this.browser = opts.browser;
    this.kb = opts.kb;
    const src = opts.readRoots;
    this.readRootsSource = typeof src === "function" ? src : () => src ?? [];
    const wsrc = opts.writableRoots;
    this.writableRootsSource = typeof wsrc === "function" ? wsrc : () => wsrc ?? [];
    this.onBeforeCommand = opts.onBeforeCommand;
    this.runStartedAt = opts.runStartedAt ?? Date.now();
    this.autoDeleteInWorkspace = opts.autoDeleteInWorkspace;
    this.signalSource = opts.signal;
  }

  /**
   * 删除类命令的低风险判定：这一单开工**之后**才出现的文件/目录 = 成员自己造的，
   * 删掉它没有损失，不该打断用户。任一目标说不清（工作区外、启动前就有、目录里混了老文件）
   * 就返回 null，照旧走人工审批。
   */
  private selfCleanupReason(command: string): string | null {
    const targets = destructiveTargets(command);
    if (!targets) return null;
    const notes: string[] = [];
    for (const t of targets) {
      const full = path.resolve(this.root, t);
      const rel = path.relative(this.root, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // 越界交给路径守卫
      if (!fs.existsSync(full)) {
        notes.push(`${t}（已不存在）`);
        continue;
      }
      if (!this.freshSinceStart(full, 0)) return null;
      notes.push(t);
    }
    return notes.length ? notes.join("、") : null;
  }

  /** 目录递归判定：子项必须全是本单开工后产生的（最多看 200 项，超了就当说不清） */
  private freshSinceStart(target: string, depth: number): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(target);
    } catch {
      return false;
    }
    if (st.mtimeMs + 2_000 < this.runStartedAt) return false;
    if (!st.isDirectory()) return true;
    if (depth >= 3) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.length > 200) return false;
    return entries.every((e) => this.freshSinceStart(path.join(target, e.name), depth + 1));
  }

  /** 本单授权的只读目录（界面/提示词要如实说明"能读哪儿"） */
  getReadRoots(): string[] {
    return this.readRootsSource().map((r) => path.resolve(r));
  }

  /** 用户授予的可写附加根（命令 cwd 可以进去；文件写入仍只走工作区） */
  getWritableRoots(): string[] {
    return this.writableRootsSource()
      .map((r) => path.resolve(r))
      .filter((r) => r !== this.root);
  }

  /** 命令 cwd：默认工作区；显式传 cwd 时必须落在工作区或可写附加根里 */
  private resolveCommandCwd(raw: unknown): string {
    if (raw === undefined || raw === "" || raw === null) return this.root;
    const full = path.resolve(this.root, String(raw));
    const allowed = [this.root, ...this.getWritableRoots()];
    const ok = allowed.some((b) => {
      const rel = path.relative(b, full);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!ok) throw new Error(`cwd 越界：${String(raw)} 不在工作区或已授权的可写根里`);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      throw new Error(`cwd 不存在：${String(raw)}`);
    }
    if (!st.isDirectory()) throw new Error(`cwd 不是目录：${String(raw)}`);
    return full;
  }

  /**
   * 工作区可读写，但**不写项目元数据**：`.git/`（版本库内部）与 `.lynn/`（风铃的项目配置/技能）
   * 不归成员改——改这两个等于改历史或改她自己的行为。
   */
  private assertWritable(full: string): void {
    const rel = path.relative(this.root, full);
    const head = rel.split(/[\\/]/)[0];
    if (head === ".git" || head === ".lynn") {
      throw new Error(`拒绝写入 ${rel}：${head}/ 是项目元数据 / 风铃配置，不归成员改（要改请让用户处理）。`);
    }
  }

  getRoot(): string {
    return this.root;
  }

  /** 本实例产生过的文件变更（按时间序） */
  changes(): FileChange[] {
    return [...this.changeLog];
  }

  /** 清空变更记录（每轮开始前调用，由 M1-12 检查点接管） */
  resetChanges(): void {
    this.changeLog = [];
  }

  /** 当前还在排队的文件数（测试用） */
  inFlight(): number {
    return this.queues.size;
  }

  /** 同一文件的写串行；不同文件可并行 */
  private serialize<T>(file: string, run: () => T | Promise<T>): Promise<T> {
    const prev = this.queues.get(file) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    this.queues.set(file, tail);
    void tail.finally(() => {
      if (this.queues.get(file) === tail) this.queues.delete(file);
    });
    return next;
  }

  private record(rel: string, before: string, after: string): FileChange {
    const { diff, added, removed } = simpleDiff(before, after);
    const change: FileChange = { path: rel, added, removed, diff, at: new Date().toISOString() };
    this.changeLog.push(change);
    return change;
  }

  // ---------- 工具实现 ----------

  readFile(args: Record<string, unknown>): string {
    const rel = String(args.path ?? "");
    // 读允许只读授权目录；写永远只走 resolveWithin
    const full = resolveReadable(this.root, this.getReadRoots(), rel).full;
    if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}`);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) throw new Error(`${rel} 是目录，请用 list_dir`);
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) throw new Error(`${rel} 看起来是二进制文件，不做文本读取。`);
    let body = buf.toString("utf-8");
    if (body.length > READ_CAP) body = body.slice(0, READ_CAP) + `\n…（已截断，共 ${stat.size} 字节）`;
    return body;
  }

  writeFile(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    const full = resolveWithin(this.root, rel);
    this.assertWritable(full);
    return this.serialize(full, () => {
      const existed = fs.existsSync(full);
      const before = existed ? fs.readFileSync(full, "utf-8") : "";
      this.onBeforeWrite?.(rel, full, existed);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      const c = this.record(rel, before, content);
      return `已写入 ${rel}（${Buffer.byteLength(content, "utf-8")} 字节，+${c.added}/-${c.removed}）\n${c.diff}`;
    });
  }

  async editFile(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? "");
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const all = Boolean(args.replace_all);
    if (!oldStr) throw new Error("old_string 不能为空（整文件替换请用 write_file）");
    const full = resolveWithin(this.root, rel);
    this.assertWritable(full);
    return this.serialize(full, () => {
      if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}`);
      const before = fs.readFileSync(full, "utf-8");
      if (!before.includes(oldStr)) throw new Error(`没找到要替换的原文（${oldStr.slice(0, 40)}…）。先 read_file 再改。`);
      this.onBeforeWrite?.(rel, full, true);
      const after = all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      fs.writeFileSync(full, after, "utf-8");
      const c = this.record(rel, before, after);
      return `已改 ${rel}（+${c.added}/-${c.removed}）\n${c.diff}`;
    });
  }

  listDir(args: Record<string, unknown>): string {
    const rel = args.path === undefined || args.path === "" ? "." : String(args.path);
    const full = resolveReadable(this.root, this.getReadRoots(), rel).full;
    if (!fs.existsSync(full)) throw new Error(`目录不存在：${rel}`);
    const entries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return "（空目录）";
    return entries.map((e) => `${e.isDirectory() ? "[目录]" : "      "} ${e.name}`).join("\n");
  }

  glob(args: Record<string, unknown>): string {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern 不能为空");
    // 只支持 * / ** / ? 三种通配。逐字符拼正则：链式 replace 会把插入的 `.*` 再吃掉
    let source = "^";
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          i += 1;
          if (pattern[i + 1] === "/") {
            i += 1;
            source += "(?:.*/)?";
          } else {
            source += ".*";
          }
        } else {
          source += "[^/]*";
        }
      } else if (ch === "?") {
        source += "[^/]";
      } else {
        source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    const re = new RegExp(source + "$", "i");
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || out.length >= 400) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(this.root, full).replace(/\\/g, "/");
        if (e.isDirectory()) walk(full, depth + 1);
        else if (re.test(rel)) out.push(rel);
      }
    };
    walk(this.root, 0);
    return out.length ? out.slice(0, 200).join("\n") : "没有匹配的文件。";
  }

  grep(args: Record<string, unknown>): string {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern 不能为空");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const scope = args.path === undefined || args.path === "" ? "." : String(args.path);
    const base = resolveWithin(this.root, scope);
    const hits: string[] = [];
    const scan = (file: string) => {
      if (hits.length >= 120) return;
      try {
        const buf = fs.readFileSync(file);
        if (buf.includes(0)) return;
        const text = buf.toString("utf-8");
        if (text.length > 2_000_000) return;
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 120 && re.test(line)) hits.push(`${path.relative(this.root, file).replace(/\\/g, "/")}:${i + 1}: ${line.slice(0, 200)}`);
        });
      } catch {
        /* 跳过读不了的文件 */
      }
    };
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || hits.length >= 120) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else scan(full);
        }
      };
      walk(base, 0);
    } else {
      scan(base);
    }
    return hits.length ? hits.join("\n") : "没有匹配行。";
  }

  async runCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? "").trim();
    if (!command) return "命令为空。";
    let cwd: string;
    try {
      cwd = this.resolveCommandCwd(args.cwd);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    // 1) 明确破坏性的先硬拒（不给"审批放行"的机会）
    for (const d of DANGEROUS) {
      if (d.re.test(command)) {
        this.onAudit?.({ kind: "cmd_blocked", command, why: d.why, cwd });
        return `已拒绝执行：${d.why}。这类命令不会自动执行（纵深防御规则，不是 OS 沙箱）。`;
      }
    }
    // 2) 路径逃逸：**先判边界再问人**。越界的命令根本不会执行，
    //    以前顺序反过来，先弹一张审批卡、用户点了头再拒——白打扰一次。
    // 只读授权根也算"命令可引用的路径"：2026-11-11 长任务里成员已获 F:\TMP-RU~1 只读授权，
    // 守卫却只认可写根，整条命令被拒 → 主风铃误判"没授权" → 反复重派同一阶段。
    // cwd 仍钉在工作区/可写根，写侧 resolveWithin 铁律不变；这里只放开路径字面量。
    const allowedRoots = [...this.getWritableRoots(), ...this.getReadRoots()];
    const escape = findPathEscape(command, this.root, allowedRoots);
    if (escape) {
      this.onAudit?.({ kind: "cmd_blocked", command, why: escape, cwd });
      return `已拒绝执行：${escape}。命令里的路径只能落在任务工作区、已授权可写根或已授权只读根内（工作区：${this.root}）。` +
        `需要别的目录时在回报里写 ESCALATE 说明，由人决定。`;
    }
    // 3) 删除类命令：先做低风险分级，再决定要不要打扰用户
    const destructive = destructiveReason(command);
    if (destructive) {
      // 本单开工后才出现的文件/目录 = 成员自己造的，删它没有损失（实机：`echo probe> x & del x` 也要点头）
      const cleanup = this.selfCleanupReason(command);
      const freeInWorkspace = !cleanup && this.autoDeleteInWorkspace?.() === true;
      if (cleanup) {
        this.onAudit?.({ kind: "cmd_auto", command, why: `自清理本单新建的文件：${cleanup}`, cwd });
      } else if (freeInWorkspace) {
        this.onAudit?.({ kind: "cmd_auto", command, why: "全权档：工作区内删除，自动放行", cwd });
      } else if (!this.onBeforeCommand) {
        this.onAudit?.({ kind: "cmd_blocked", command, why: `删除需要用户点头（${destructive}），当前没有审批通道`, cwd });
        return `已拒绝：删除类命令（${destructive}）需要用户点头，这次没有审批通道。请改成可撤销的写法（write_file 覆盖），或在回报里说明为什么必须删。`;
      } else {
        const verdict = await this.onBeforeCommand(command);
        if (!verdict.ok) {
          this.onAudit?.({ kind: "cmd_blocked", command, why: `用户拒绝删除：${verdict.reason ?? destructive}`, cwd });
          return `用户拒绝了这次删除（${destructive}）：${verdict.reason ?? "这个目录里的文件不能删"}。改用可撤销的写法（write_file 覆盖），或先交回报让用户决定。`;
        }
      }
    }
    if (OUTBOUND.test(command)) this.onAudit?.({ kind: "cmd_net", command, cwd });
    this.onAudit?.({ kind: "cmd_run", command, cwd });
    const signal = this.signalSource?.();
    if (signal?.aborted) return "已被停止：用户点了「停」，这条命令不再执行。";
    const cap = this.outputCap;
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: this.commandTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env },
          signal,
        },
        (err, stdout, stderr) => {
          const cut = (s: string) => ((s ?? "").length > cap ? (s ?? "").slice(0, cap) + `…（截断，共 ${(s ?? "").length} 字符）` : (s ?? ""));
          if (signal?.aborted) {
            resolve(`命令已被用户停止（点「停」）：${command}`);
            return;
          }
          if (err && !stdout && !stderr) {
            if ((err as Error & { killed?: boolean }).killed) {
              resolve(`命令超时（${this.commandTimeoutMs / 1000}s）被终止：${command}`);
            } else {
              resolve(`命令执行失败：${err.message}`);
            }
            return;
          }
          resolve(
            [stdout ? `stdout:\n${cut(stdout)}` : null, stderr ? `stderr:\n${cut(stderr)}` : null, err ? `exit code: ${err.code ?? "非零"}` : "exit code: 0"]
              .filter(Boolean)
              .join("\n"),
          );
        },
      );
    });
  }

  /** 统一入口：名字与 schema 一一对应 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "read_file":
        return this.readFile(args);
      case "write_file":
        return this.writeFile(args);
      case "edit_file":
        return this.editFile(args);
      case "list_dir":
        return this.listDir(args);
      case "glob":
        return this.glob(args);
      case "grep":
        return this.grep(args);
      case "run_command":
        return this.runCommand(args);
      case "office_read_table":
      case "office_write_table":
        return this.officeTool(name, args);
      case "office_write_docx":
        return this.officeDocx(args);
      case "browser_navigate":
      case "browser_snapshot":
      case "browser_click":
      case "browser_fill":
      case "browser_extract":
      case "browser_close":
        return this.browserTool(name, args);
      case "kb_add":
        return this.kbAdd(args);
      default:
        throw new Error(`工作区里没有这个工具：${name}`);
    }
  }

  /** 知识库写入（M2-08）：抓取结果存为 markdown；未注入如实说 */
  private kbAdd(args: Record<string, unknown>): string {
    if (!this.kb) {
      return "知识库写入未装配——把内容写进工作区文件即可，入库由风铃或用户处理。";
    }
    return JSON.stringify(this.kb.add(String(args.name ?? ""), String(args.markdown ?? "")), null, 2);
  }

  /** browser 工具（M2-07）：全局单例资源；未注入（壳没装配）就如实说 */
  private async browserTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.browser) {
      return "browser 能力未装配（当前进程没有浏览器桥接）——请回报此限制，改用 HTTP 抓取或说明需要浏览器。";
    }
    switch (name) {
      case "browser_navigate":
        return this.browser.navigate(String(args.url ?? ""));
      case "browser_snapshot":
        return this.browser.snapshot();
      case "browser_click":
        return this.browser.click(String(args.target ?? ""));
      case "browser_fill":
        return this.browser.fill(String(args.target ?? ""), String(args.value ?? ""));
      case "browser_extract":
        return this.browser.extract(args.kind === "table" ? "table" : "text", args.selector ? String(args.selector) : undefined);
      default:
        return this.browser.close();
    }
  }

  /** office 工具（M2-06）：路径钉在工作区；能力未注入（壳没装配）就如实说 */
  private officeTool(name: string, args: Record<string, unknown>): string {
    if (!this.office) {
      return "office 能力未装配（当前进程没有 office 引擎桥接）——请回报此限制，改用 CSV 或在简报里说明。";
    }
    const rel = String(args.path ?? "");
    if (name === "office_read_table") {
      // 读表格同样可读只读授权目录（审查项目里的 xlsx）；写仍限工作区
      const full = resolveReadable(this.root, this.getReadRoots(), rel).full;
      const r = this.office.read(full);
      return JSON.stringify(r, null, 2);
    }
    const full = resolveWithin(this.root, rel);
    const w = this.office.write(full, {
      headers: (args.headers as string[]) ?? [],
      rows: (args.rows as string[][]) ?? [],
    });
    return JSON.stringify(w, null, 2);
  }

  /**
   * Word 产出（2026-11-11）：进程内零依赖生成，不依赖机器装 Python / python-docx。
   * 只接受结构化 blocks，不让模型自己拼 XML；路径仍然钉在工作区。
   */
  private officeDocx(args: Record<string, unknown>): string {
    const rel = String(args.path ?? "").trim();
    if (!rel) return "path 不能为空：给工作区内的 .docx 相对路径。";
    if (!/\.docx$/i.test(rel)) return "path 必须以 .docx 结尾（例如 reports/漏洞管理.docx）。";
    const blocks = Array.isArray(args.blocks) ? (args.blocks as DocxBlock[]) : [];
    if (!blocks.length) return "blocks 不能为空：至少一个 heading / paragraph / bullet / table。";
    let full: string;
    try {
      full = resolveWithin(this.root, rel);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    try {
      const buf = buildDocx({
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
        blocks,
        footerText: args.footerText ? String(args.footerText) : undefined,
        pageNumbers: args.pageNumbers !== false,
      });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      return `已写入 ${rel}（${buf.length} 字节，${blocks.length} 个内容块）。`;
    } catch (err) {
      return `生成 docx 失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** 官方执行工具的 schema（成员白名单按名字过滤后使用） */
export const TOOLKIT_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "browser_navigate",
      description: "打开网页（http/https）。headed 模式用户随时可接管；登录/支付/验证码页强制需要用户批准。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_snapshot",
      description: "页面可访问性快照（给模型看的结构；ref 用于 click/fill）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_click",
      description: "点击元素（selector 或快照 ref）。敏感页会被拒绝并要求用户批准。",
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_fill",
      description: "填表（selector + value）。敏感页会被拒绝并要求用户批准。",
      parameters: {
        type: "object",
        properties: { target: { type: "string" }, value: { type: "string" } },
        required: ["target", "value"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_extract",
      description: "抓取页面：text（正文，≤8000 字）或 table（表头+行，配合 office_write_table 落 csv）。",
      parameters: {
        type: "object",
        properties: { kind: { type: "string", enum: ["text", "table"] }, selector: { type: "string" } },
        required: ["kind"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_close",
      description: "关闭浏览器（释放资源）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "kb_add",
      description: "把抓取/整理的内容存入知识库（markdown，即时可检索）。同名不覆盖。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "文档名" }, markdown: { type: "string", description: "正文（含 # 标题更好）" } },
        required: ["name", "markdown"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "office_read_table",
      description:
        "读表格为 {headers, rows}：csv/txt 直读；xlsx 需要本机 LibreOffice（缺引擎会如实报错，不要假装有数据）。",
      parameters: { type: "object", properties: { path: { type: "string", description: "工作区内相对路径" } }, required: ["path"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "office_write_table",
      description: "把表格写为 CSV 文件（headers + rows）。xlsx 写入不支持时会如实拒绝。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内相对路径（.csv）" },
          headers: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["path", "headers", "rows"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "office_write_docx",
      description:
        "生成 Word（.docx），进程内零依赖，不依赖本机 Python。用结构化 blocks：heading（level 1-3）/ paragraph / bullet / table（headers+rows）；可给 title、footerText、pageNumbers。表格列宽按内容自动分配并撑满页宽、表头跨页重复。heading/paragraph/bullet 必须有非空 text（空值或 undefined 占位会直接报错）。复杂排版（图片、公式、目录域）再用 python-docx 脚本兜底。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内相对路径，必须以 .docx 结尾" },
          title: { type: "string", description: "文档标题（可选）" },
          author: { type: "string", description: "页脚署名（可选）" },
          footerText: { type: "string", description: "页脚文字（可选）" },
          pageNumbers: { type: "boolean", description: "页脚是否带页码（默认 true）" },
          blocks: {
            type: "array",
            description: "内容块数组",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["heading", "paragraph", "bullet", "table"] },
                level: { type: "number", description: "heading 级别：1~3" },
                text: { type: "string" },
                headers: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              },
              required: ["type"],
            },
          },
        },
        required: ["path", "blocks"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取工作区内一个文本文件（超过 200KB 截断；二进制拒读）。",
      parameters: { type: "object", properties: { path: { type: "string", description: "工作区内相对路径" } }, required: ["path"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "把完整内容写入工作区内的文件（目录自动创建，覆盖同名）。返回本次改动的 diff 摘要。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "把文件里的一段原文替换成新文本（找不到原文会报错，要求先读后改）。返回 diff 摘要。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "要替换的原文（必须唯一，除非 replace_all）" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", description: "替换所有匹配" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "列出工作区内一个目录的条目（默认根目录）。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "glob",
      description: "按通配符找工作区内的文件（支持 *、**、?）。",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description: "在工作区文本文件里按正则搜行，返回 文件:行号: 内容。",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description:
        "在工作区内执行一条命令（120s 超时，输出截断 8K；明显破坏性命令会被拒绝）。cwd 仅可指向工作区或用户已授权的可写根。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "可选：命令在哪个目录跑（必须在工作区或已授权的可写根里）" },
        },
        required: ["command"],
      },
    },
  },
];
