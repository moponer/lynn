// 官方 L1 执行工具集（M0-06）：read/write/edit/list/glob/grep/run_command。
// 三条硬约束：
//   1) 一切路径都钉在 root 里（逃逸直接拒），root 由调用方给（任务工作区 / 项目工作区）；
//   2) 同一文件的写串行（每文件一条 Promise 队列），并发写不会互相覆盖；
//   3) 每次写都留 diff（供 M1-12 的 /undo 检查点与界面展示复用，不另写一套）。
import * as fs from "node:fs";
import * as path from "node:path";
import { execa } from "execa";
import { applyPatch } from "diff";
import { buildCommandEnv, posixToolDirsCached } from "./cmd-env";
import { formatCommandResult } from "./cmd-output";
import { extractPdfText } from "./pdf-text";
import type { CommandFamily } from "../shared/contract";
import { normalizeTargetPath } from "./member-path";
import { buildDocx, type DocxBlock } from "./docx";
import { insideBase } from "./path-guard";

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
  /**
   * 写盘前的文本改写（2026-11-15 去 AI 味插件用）：返回原文即不改。
   * 只对 write_file 生效——edit_file 是补丁语义，改写会打乱 old_string 匹配。
   */
  onWriteContent?: (rel: string, content: string) => string;
  /**
   * 出站/联网命令闸（2026-11-13 审计 #2）：返回 false = OUTBOUND 命中直接拒。
   * 内核按权限档接：计划/询问档不自动放行出站；自动/全权档保持"只审计不拦"。
   * 不传 = 保持旧行为（只审计），测试与直用方不受影响。
   */
  outboundAllowed?: () => boolean;
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
   * 外部应用桥接（2026-11-15）：成员通过用户在能力中心配好的连接器访问外部系统。
   * 凭据只在核心里（这里拿不到明文），成员只给 app id + 路径/命令。
   * 未注入时工具如实提示"未装配"，不假装能连。
   */
  apps?: {
    request: (input: { app: string; method: string; path: string; body?: string }) => Promise<string>;
    ssh?: (input: { app: string; command: string }) => Promise<string>;
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
const DESTRUCTIVE: { re: RegExp; why: string; fam: CommandFamily }[] = [
  { re: /\bdel\b/i, why: "del 删除文件", fam: "delete" },
  { re: /\berase\b/i, why: "erase 删除文件", fam: "delete" },
  { re: /\brmdir\b/i, why: "rmdir 删除目录", fam: "delete" },
  { re: /(^|[\s;&|(])rd\b/i, why: "rd 删除目录", fam: "delete" },
  { re: /(^|[\s;&|(])rm\b/i, why: "rm 删除文件/目录", fam: "delete" },
  { re: /remove-item/i, why: "Remove-Item 删除", fam: "delete" },
  { re: /(^|[\s;&|(])mv\b/i, why: "mv 移动（原位置即删除）", fam: "move" },
  { re: /\bmove\b/i, why: "move 移动（原位置即删除）", fam: "move" },
  { re: /\bren(ame)?\b/i, why: "改名/移动", fam: "move" },
  { re: /git\s+clean/i, why: "git clean 删未跟踪文件", fam: "git-clean" },
  { re: /git\s+reset\s+--hard/i, why: "git reset --hard 丢弃改动", fam: "git-reset" },
];

/** 纯函数：命令是否删除类（返回原因；null = 不是） */
export function destructiveReason(command: string): string | null {
  for (const d of DESTRUCTIVE) {
    if (d.re.test(command)) return d.why;
  }
  return null;
}

/**
 * 删除类命令的"族"（2026-11-14）：用户可以说"这一类以后都允许"，
 * 粒度按族而不是按单条命令——否则允许一次 del 就等于允许所有删除，太宽。
 */
export function destructiveFamily(command: string): CommandFamily | null {
  for (const d of DESTRUCTIVE) {
    if (d.re.test(command)) return d.fam;
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

/** 通配 → 正则（只支持 * / ** / ?；逐字符拼，链式 replace 会把插入的 `.*` 再吃掉） */
export function globToRegExp(pattern: string): RegExp {
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
  return new RegExp(source + "$", "i");
}

const READ_CAP = 200_000;
/** 分页读的默认行数 / 单次上限（2026-11-14） */
const READ_LINES = 400;
const MAX_READ_LINES = 2_000;
const DIFF_CAP = 1_200;

/** 解析路径：词法归一后再做 realpath containment，符号链接也不能把读写带出 root */
export function resolveWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const full = normalizeTargetPath(base, target);
  if (!insideBase(base, full)) {
    // 拒绝时给出路（2026-11-15）：只说"不行"会让成员换路径反复硬试，最后空转。
    throw new Error(
      `路径越界：${target} 不在工作区内。只能访问工作区里的文件。` +
        "需要别的目录时不要换写法重试：停手回报写明「需要授权：<绝对路径>（用途）」，由风铃补只读授权。",
    );
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
  if (insideBase(base, full)) return { full, outside: false };
  for (const r of readRoots) {
    const rb = path.resolve(r);
    if (insideBase(rb, full)) return { full, outside: true, root: rb };
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
  /** 读过的文件状态（绝对路径 → mtime/size），写前比对用；见 assertFresh */
  private observed = new Map<string, { mtimeMs: number; size: number }>();
  private readonly root: string;
  private readonly commandTimeoutMs: number;
  private readonly outputCap: number;
  private readonly onAudit?: ToolkitOptions["onAudit"];
  private readonly onBeforeWrite?: ToolkitOptions["onBeforeWrite"];
  private readonly onWriteContent?: ToolkitOptions["onWriteContent"];
  private readonly outboundAllowed?: () => boolean;
  private readonly office?: ToolkitOptions["office"];
  private readonly browser?: ToolkitOptions["browser"];
  private readonly kb?: ToolkitOptions["kb"];
  private readonly apps?: ToolkitOptions["apps"];
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
    this.onWriteContent = opts.onWriteContent;
    this.outboundAllowed = opts.outboundAllowed;
    this.office = opts.office;
    this.browser = opts.browser;
    this.kb = opts.kb;
    this.apps = opts.apps;
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
    // realpath 复核（2026-11-15）：上面是词法判定，工作区里的符号链接/联接点指到授权根之外时
    // 词法仍在根内，命令就会真在那个目录里跑。文件读写已走 insideBase，cwd 不能是缺口。
    let realFull: string;
    try {
      realFull = fs.realpathSync(full);
    } catch {
      throw new Error(`cwd 无法解析真实路径：${String(raw)}`);
    }
    const realOk = allowed.some((b) => {
      try {
        return insideBase(fs.realpathSync(b), realFull);
      } catch {
        return false;
      }
    });
    if (!realOk) throw new Error(`cwd 越界（符号链接指向授权根之外）：${String(raw)}`);
    return full;
  }

  /**
   * 读后写保护（2026-11-16，ZCode 式 CAS 的轻量版）：只对「本实例读过」的文件生效。
   * 读过之后被外部改动（mtime 或 size 变了）就拒绝盲写——人要先 read_file 看清现状。
   * 没读过的文件保持原行为（整份覆盖），不打断"直接写一个新文件/整篇重写"的正常创作。
   * 已知局限：保留 mtime 且同字节数的改写能绕过去；这里不做全文哈希，
   * 因为那等于每次写都多读一遍（8MB 级文件不划算），而这类改写不是本产品的主要风险。
   */
  private assertFresh(full: string, rel: string): void {
    const seen = this.observed.get(full);
    if (!seen) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return; // 文件被删：按新建处理，允许写
    }
    if (st.mtimeMs !== seen.mtimeMs || st.size !== seen.size) {
      throw new Error(
        `拒绝覆盖 ${rel}：你读过之后这个文件又被改过（可能是用户或另一个进程）。先 read_file 看清现状，再决定怎么写。`,
      );
    }
  }

  /** 读完/写完记下状态；写后必须更新，否则同一轮连续写两次会被自己的 CAS 挡住 */
  private markObserved(full: string): void {
    try {
      const st = fs.statSync(full);
      this.observed.set(full, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      this.observed.delete(full);
    }
  }

  /**
   * 工作区可读写，但**不写项目元数据**：`.git/`（版本库内部）与 `.lynn/`（风铃的项目配置/技能）
   * 不归成员改——改这两个等于改历史或改她自己的行为。
   */
  private assertWritable(full: string): void {
    // 用真实路径判元数据目录（2026-11-15）：工作区里指向 .git/.lynn 的符号链接，
    // 词法首段是链接名，按词法判会漏——写进去等于改了版本库或风铃自己的配置。
    let real = full;
    try {
      real = fs.realpathSync(full);
    } catch {
      try {
        real = path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
      } catch {
        /* 父目录也不存在（还没创建）：退回词法路径，下面仍按首段判 */
      }
    }
    const rel = path.relative(this.root, real);
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

  async readFile(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? "");
    // 空 path 会被解析成工作区根目录，随后报「 是目录，请用 list_dir」——
    // 报错里连路径都是空的，成员看不出是自己漏填参数（实测连撞 3 次）。这里先如实说清。
    if (!rel.trim()) {
      throw new Error("path 必填：给工作区内相对路径的文件名（要看目录请用 list_dir）。");
    }
    // 读允许只读授权目录；写永远只走 resolveWithin
    const full = resolveReadable(this.root, this.getReadRoots(), rel).full;
    if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}`);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) throw new Error(`${rel} 是目录，read_file 只读文件；列目录请用 list_dir`);
    const buf = fs.readFileSync(full);
    // 记下"读到的是哪一版"：之后写入前会比对，别人中途改了要重读（assertFresh）
    this.markObserved(full);
    // PDF（2026-11-14）：交给 pdfjs 提文本。扫描件提不出来就如实说——别把二进制当文本吐给模型
    if (buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") {
      return this.readPdf(rel, buf);
    }
    if (buf.includes(0)) throw new Error(`${rel} 看起来是二进制文件，不做文本读取。`);
    const text = buf.toString("utf-8");
    // 分页（2026-11-14）：一次吐 20 万字会把模型上下文直接撑爆，而成员真正需要的
    // 往往只是其中一段（对表头、查一行、看日志尾部）。默认 400 行，显式传 offset/limit 精读。
    const lines = text.split("\n");
    const explicit = args.offset !== undefined || args.limit !== undefined;
    // 小文件且没点名分页：保持原样返回（不动既有调用方的输出）
    if (!explicit && lines.length <= READ_LINES && text.length <= READ_CAP) return text;

    const start = Math.max(1, Math.trunc(Number(args.offset ?? 1)) || 1);
    const wantLimit = Math.trunc(Number(args.limit ?? READ_LINES)) || READ_LINES;
    const limit = Math.max(1, Math.min(MAX_READ_LINES, wantLimit));
    if (start > lines.length) {
      return `${rel} 只有 ${lines.length} 行，offset=${start} 超出范围（要从 1 开始）。`;
    }
    const slice = lines.slice(start - 1, start - 1 + limit);
    const last = start + slice.length - 1;
    const head = `[${rel} · 第 ${start}-${last} 行 / 共 ${lines.length} 行]`;
    const tail = last < lines.length ? `\n…（未读完，继续读用 offset=${last + 1}）` : "";
    let out = `${head}\n${slice.join("\n")}${tail}`;
    // 单行本身几十万字（压缩过的 JSON、一行 CSV）时按字符兜底：行数分页拦不住它
    if (out.length > READ_CAP) {
      out = `${out.slice(0, READ_CAP)}\n…（已截断：这一行本身就超过 ${READ_CAP} 字符，用 offset 换一段或让上游拆行）`;
    }
    return out;
  }

  /** PDF 读取（2026-11-14）：只提文字，不渲染、不 OCR */
  private async readPdf(rel: string, buf: Buffer): Promise<string> {
    try {
      const { text, pages, readPages, emptyPages } = await extractPdfText(buf);
      if (!text.trim()) {
        return `${rel} 是 PDF（${pages} 页），但一个字都提取不到——多半是扫描件/图片版。让用户提供文字版或原始文档；不要凭文件名猜内容。`;
      }
      const head = `[PDF · ${pages} 页${readPages < pages ? `（只读了前 ${readPages} 页）` : ""}${emptyPages ? `，其中 ${emptyPages} 页没有文字` : ""}]`;
      const body = text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n…（已截断，共 ${text.length} 字符）` : text;
      return `${head}\n${body}`;
    } catch (err) {
      return `${rel} 是 PDF，但解析失败（${err instanceof Error ? err.message : String(err)}）。可以让用户导出成文本或 Word 再读。`;
    }
  }

  writeFile(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? "");
    // 去 AI 味插件注入（可选）：产出文档/文案/注释在落盘前过一遍。
    // 只影响写出去的文件，不碰模型上下文；插件缺失时这行是恒等变换。
    const raw = String(args.content ?? "");
    const content = this.onWriteContent ? this.onWriteContent(rel, raw) : raw;
    const full = resolveWithin(this.root, rel);
    this.assertWritable(full);
    return this.serialize(full, () => {
      this.assertFresh(full, rel);
      const existed = fs.existsSync(full);
      const before = existed ? fs.readFileSync(full, "utf-8") : "";
      this.onBeforeWrite?.(rel, full, existed);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      this.markObserved(full);
      const c = this.record(rel, before, content);
      return `已写入 ${rel}（${Buffer.byteLength(content, "utf-8")} 字节，+${c.added}/-${c.removed}）\n${c.diff}`;
    });
  }

  async editFile(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? "");
    // patch 模式（2026-11-14）：unified diff 交给 jsdiff 应用。
    // 比 old_string 稳的地方是补丁带上下文行——行号漂移、同名片段重复时不会改错地方；
    // 上下文对不上就整条拒（不猜、不模糊匹配到别的段落）。
    const patch = typeof args.patch === "string" ? args.patch.trim() : "";
    if (patch) return this.applyPatchEdit(rel, patch);
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const all = Boolean(args.replace_all);
    if (!oldStr) throw new Error("old_string 不能为空（整文件替换请用 write_file）");
    const full = resolveWithin(this.root, rel);
    this.assertWritable(full);
    return this.serialize(full, () => {
      if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}`);
      this.assertFresh(full, rel);
      const before = fs.readFileSync(full, "utf-8");
      if (!before.includes(oldStr)) throw new Error(`没找到要替换的原文（${oldStr.slice(0, 40)}…）。先 read_file 再改。`);
      this.onBeforeWrite?.(rel, full, true);
      const after = all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      fs.writeFileSync(full, after, "utf-8");
      this.markObserved(full);
      const c = this.record(rel, before, after);
      return `已改 ${rel}（+${c.added}/-${c.removed}）\n${c.diff}`;
    });
  }

  /** unified diff 落盘：applyPatch 返回 false = 上下文不匹配（jsdiff 会做有限 fuzz，默认 2 行） */
  private applyPatchEdit(rel: string, patch: string): Promise<string> {
    const full = resolveWithin(this.root, rel);
    this.assertWritable(full);
    return this.serialize(full, () => {
      if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}（新建请用 write_file）`);
      this.assertFresh(full, rel);
      const before = fs.readFileSync(full, "utf-8");
      const after = applyPatch(before, patch, { fuzzFactor: 2 });
      if (after === false) {
        throw new Error(
          `补丁的上下文对不上 ${rel}（文件可能已经被改过，或补丁里没有正确的 @@ 头与上下文行）。先 read_file 看清现状再重发。`,
        );
      }
      if (after === before) return `补丁没有产生任何改动：${rel}（检查 @@ 行号与内容是否一致）`;
      this.onBeforeWrite?.(rel, full, true);
      fs.writeFileSync(full, after, "utf-8");
      this.markObserved(full);
      const c = this.record(rel, before, after);
      return `已打补丁 ${rel}（+${c.added}/-${c.removed}）\n${c.diff}`;
    });
  }

  listDir(args: Record<string, unknown>): string {
    const rel = args.path === undefined || args.path === "" ? "." : String(args.path);
    const full = resolveReadable(this.root, this.getReadRoots(), rel).full;
    if (!fs.existsSync(full)) throw new Error(`目录不存在：${rel}`);
    const entries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return "（空目录）";
    // 带上大小与修改时间（2026-11-14）：成员靠这个判断"哪个是刚改的 / 哪个是空壳"，
    // 不用再为每个文件单独 stat 一遍（read_file 读全文才知道大小是很贵的）
    return entries
      .map((e) => {
        if (e.isDirectory()) return `[目录] ${e.name}`;
        try {
          const st = fs.statSync(path.join(full, e.name));
          const size = st.size >= 1024 ? `${(st.size / 1024).toFixed(1)}KB` : `${st.size}B`;
          return `  ${size.padStart(8)}  ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}  ${e.name}`;
        } catch {
          return `                   ${e.name}`;
        }
      })
      .join("\n");
  }

  glob(args: Record<string, unknown>): string {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern 不能为空");
    const re = globToRegExp(pattern);
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
    const caseSensitive = args.caseSensitive === true;
    const flags = caseSensitive ? "" : "i";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    // include（2026-11-14）：只搜匹配的文件，沿用 glob 的同一套通配语义（`**/*.ts`）
    const include = typeof args.include === "string" ? args.include.trim() : "";
    const incRe = include ? globToRegExp(include) : null;
    const scope = args.path === undefined || args.path === "" ? "." : String(args.path);
    const base = resolveWithin(this.root, scope);
    /** 命中上限：到顶就在结果末尾如实说"可能还有"，不能让成员以为只有这些 */
    const LIMIT = 120;
    const hits: string[] = [];
    const scan = (file: string) => {
      if (hits.length >= LIMIT) return;
      try {
        const buf = fs.readFileSync(file);
        if (buf.includes(0)) return;
        const text = buf.toString("utf-8");
        if (text.length > 2_000_000) return;
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length < LIMIT && re.test(line)) hits.push(`${path.relative(this.root, file).replace(/\\/g, "/")}:${i + 1}: ${line.slice(0, 200)}`);
        });
      } catch {
        /* 跳过读不了的文件 */
      }
    };
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || hits.length >= LIMIT) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (!incRe || incRe.test(path.relative(this.root, full).replace(/\\/g, "/"))) scan(full);
        }
      };
      walk(base, 0);
    } else {
      scan(base);
    }
    if (!hits.length) return "没有匹配行。";
    const more = hits.length >= LIMIT ? `\n…（已到 ${LIMIT} 行上限，可能还有更多；加 include 或缩小 path 再搜）` : "";
    return `${hits.join("\n")}${more}`;
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
    // 4) 出站闸（审计 #2）：OUTBOUND 命中先问权限档——计划/询问档不自动放行
    //    （成员工作区里的数据可以被 curl 带出本机，这是真实的外泄通道）；
    //    自动/全权档保持"只审计不拦"。拒了给指路：ESCALATE 让用户决定。
    const outbound = OUTBOUND.test(command);
    if (outbound && this.outboundAllowed && !this.outboundAllowed()) {
      this.onAudit?.({ kind: "cmd_blocked", command, why: "出站/联网命令在当前权限档不自动放行", cwd });
      return `已拒绝执行：出站/联网命令（curl/wget/ssh/上传类）在当前权限档不自动放行。` +
        `改用无需联网的做法；确实需要联网时在回报里写 ESCALATE 说明原因，由用户切「自动」档或单独放行。`;
    }
    if (outbound) this.onAudit?.({ kind: "cmd_net", command, cwd });
    this.onAudit?.({ kind: "cmd_run", command, cwd });
    const signal = this.signalSource?.();
    if (signal?.aborted) return "已被停止：用户点了「停」，这条命令不再执行。";
    try {
      // execa（2026-11-14）：取代 child_process.exec。三处实际差别——
      // ① encoding:null 拿原始 Buffer，才能按 GBK/UTF-8 正确解码（中文 Windows 老程序）；
      // ② timeout + killSignal=SIGKILL：超时直接强杀，不留半个进程占着工作区；
      // ③ 「停」真的杀进程：execa 8 没有 cancelSignal，自己接 AbortSignal。
      const sub = execa(command, {
        shell: true,
        cwd,
        timeout: this.commandTimeoutMs,
        // execa 8 没有 forceKillAfterDelay；留优雅窗口的结果往往是子进程把工作区占着，
        // 下一轮命令跟着失败。Windows 上 SIGKILL 映射成 TerminateProcess。
        killSignal: "SIGKILL",
        reject: false,
        encoding: null,
        windowsHide: true,
        stripFinalNewline: false,
        // 不直接继承 process.env：剔密钥 + 关交互提示（见 cmd-env.ts 头注释）。
        // toolDirs：Windows 上前置 Git 的 usr/bin，让 `grep -rn` / `sed` 这类命令真的能跑。
        env: buildCommandEnv(process.env, { toolDirs: posixToolDirsCached() }),
      });
      const onAbort = () => {
        try {
          sub.kill("SIGKILL");
        } catch {
          /* 已经退出 */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const done = await sub;
        if (signal?.aborted) return `命令已被用户停止（点「停」）：${command}`;
        if (done.timedOut) return `命令超时（${this.commandTimeoutMs / 1000}s）被终止：${command}`;
        return formatCommandResult({
          stdout: done.stdout as Buffer | undefined,
          stderr: done.stderr as Buffer | undefined,
          exitCode: done.exitCode,
          budget: this.outputCap,
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      return `命令执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
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
      case "app_api":
        return this.appApi(args);
      case "ssh_run":
        return this.sshRun(args);
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

  /**
   * 外部应用请求（能力中心 · 连接器）：成员只给 app id + 路径，
   * 凭据与可访问主机都在内核侧（成员拿不到令牌，也就抄不进产物）。
   */
  private async appApi(args: Record<string, unknown>): Promise<string> {
    if (!this.apps) {
      return "外部应用能力未装配（当前进程没有连接器桥接）——请回报此限制，改用命令行或说明需要它。";
    }
    const app = String(args.app ?? "").trim();
    const method = String(args.method ?? "GET").toUpperCase();
    const p = String(args.path ?? "").trim();
    if (!app) return "app 参数必填（能力中心里已启用的连接器 id，如 github / gitee / atomgit / webdav）";
    if (!p) return "path 参数必填（例如 /repos/owner/repo）";
    try {
      return await this.apps.request({ app, method, path: p, body: args.body === undefined ? undefined : String(args.body) });
    } catch (err) {
      return `外部应用请求失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 远程命令（能力中心 · SSH 连接器）：主机与私钥路径都在内核侧，成员只给命令 */
  private async sshRun(args: Record<string, unknown>): Promise<string> {
    if (!this.apps?.ssh) {
      return "SSH 能力未装配（当前进程没有连接器桥接）——请回报此限制，改为请用户提供导出的日志/数据。";
    }
    const app = String(args.app ?? "ssh").trim() || "ssh";
    const command = String(args.command ?? "").trim();
    if (!command) return "command 参数必填（要在远端执行的命令）";
    try {
      return await this.apps.ssh({ app, command });
    } catch (err) {
      return `远程命令失败：${err instanceof Error ? err.message : String(err)}`;
    }
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
      name: "app_api",
      description:
        "调用用户已连接的外部应用（GitHub / Gitee / AtomGit / WebDAV 网盘）：只给 app id 与接口路径，令牌由内核自动带上，你看不到也不需要它。" +
        "返回值是 HTTP 状态 + 响应正文（超长截断）。未连接或主机不匹配会如实报错。只读为主，写操作要先确认对象。",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "连接器 id：github / gitee / atomgit / webdav" },
          method: { type: "string", description: "HTTP 方法：GET / POST / PUT / PATCH / PROPFIND / HEAD（默认 GET，不允许 DELETE）" },
          path: { type: "string", description: "接口路径，不含主机名，例如 /repos/owner/repo 或 /目录/（WebDAV）" },
          body: { type: "string", description: "请求体（JSON 字符串或纯文本），GET 不用填" },
        },
        required: ["app", "path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ssh_run",
      description:
        "在用户已连接的 SSH 服务器上执行一条命令（主机/端口/账号/私钥都由内核带入）。" +
        "只用于只读排查：看日志、看磁盘、看进程。不许改配置、不许重启服务、不许 sudo。",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "连接器 id，默认 ssh" },
          command: { type: "string", description: "要在远端执行的单条命令（加 -n / head 限制输出量）" },
        },
        required: ["command"],
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
      description:
        "读取工作区内的文件。文本按行分页：默认最多 400 行，头里写清是第几行到第几行、共多少行，没读完会给下一页的 offset；" +
        "要精确读某一段就传 offset（从 1 开始）与 limit（最多 2000 行）。PDF 会提取文字（扫描件提不出来会如实说，不要凭文件名猜）。" +
        "其它二进制拒读。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内相对路径" },
          offset: { type: "number", description: "起始行号（1-based，默认 1）" },
          limit: { type: "number", description: "读多少行（默认 400，上限 2000）" },
        },
        required: ["path"],
      },
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
      description:
        "改工作区内的文本文件。两种写法二选一：① patch = unified diff（推荐，带上下文行，改多段一次搞定）；" +
        "② old_string/new_string = 原文精确替换（找不到原文会报错）。都要求先 read_file。返回 diff 摘要。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          patch: {
            type: "string",
            description:
              "unified diff：--- a/路径 / +++ b/路径 / @@ -起,行数 +起,行数 @@ + 上下文行（空格开头）-旧 +新，可多段",
          },
          old_string: { type: "string", description: "要替换的原文（必须唯一，除非 replace_all）" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", description: "替换所有匹配" },
        },
        required: ["path"],
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
      description:
        "在工作区文本文件里按正则搜行，返回 文件:行号: 内容。默认忽略大小写、跳过 node_modules/.git；最多返回 120 行（到上限会在末尾说明）。用 include 限定文件类型比事后过滤省事。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则（不是通配）；解释不了就当字面量" },
          path: { type: "string", description: "搜哪个目录/文件（默认工作区根）" },
          include: { type: "string", description: "只搜匹配的文件，如 **/*.ts、src/**" },
          caseSensitive: { type: "boolean", description: "区分大小写（默认否）" },
        },
        required: ["pattern"],
      },
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
