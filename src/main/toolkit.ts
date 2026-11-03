// 官方 L1 执行工具集（M0-06）：read/write/edit/list/glob/grep/run_command。
// 三条硬约束：
//   1) 一切路径都钉在 root 里（逃逸直接拒），root 由调用方给（任务工作区 / 项目工作区）；
//   2) 同一文件的写串行（每文件一条 Promise 队列），并发写不会互相覆盖；
//   3) 每次写都留 diff（供 M1-12 的 /undo 检查点与界面展示复用，不另写一套）。
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";

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
  onAudit?: (ev: { kind: "cmd_blocked" | "cmd_net" | "cmd_run"; command: string; why?: string; cwd: string }) => void;
  /** 写之前通知壳（M1-12 检查点）：existed=false 表示这轮新建 */
  onBeforeWrite?: (rel: string, full: string, existed: boolean) => void;
  /** office 能力注入（M2-06）：csv 永远可用；xlsx 由壳按引擎健康决定（缺引擎如实报） */
  office?: {
    read: (file: string) => { table?: { headers: string[]; rows: string[][] }; error?: string };
    write: (file: string, table: { headers: string[]; rows: string[][] }) => { ok: boolean; error?: string };
  };
}

const READ_CAP = 200_000;
const DIFF_CAP = 1_200;

/** 解析路径：必须落在 root 内 */
export function resolveWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, target);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`路径越界：${target} 不在工作区内。只能访问工作区里的文件。`);
  }
  return full;
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

export class Toolkit {
  private queues = new Map<string, Promise<unknown>>();
  private changeLog: FileChange[] = [];
  private readonly root: string;
  private readonly commandTimeoutMs: number;
  private readonly outputCap: number;
  private readonly onAudit?: ToolkitOptions["onAudit"];
  private readonly onBeforeWrite?: ToolkitOptions["onBeforeWrite"];
  private readonly office?: ToolkitOptions["office"];

  constructor(root: string, opts: ToolkitOptions = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 120_000;
    this.outputCap = opts.outputCap ?? 8_000;
    this.onAudit = opts.onAudit;
    this.onBeforeWrite = opts.onBeforeWrite;
    this.office = opts.office;
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
    const full = resolveWithin(this.root, rel);
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
    const full = resolveWithin(this.root, rel);
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

  runCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? "").trim();
    if (!command) return Promise.resolve("命令为空。");
    for (const d of DANGEROUS) {
      if (d.re.test(command)) {
        this.onAudit?.({ kind: "cmd_blocked", command, why: d.why, cwd: this.root });
        return Promise.resolve(`已拒绝执行：${d.why}。这类命令不会自动执行（纵深防御规则，不是 OS 沙箱）。`);
      }
    }
    if (OUTBOUND.test(command)) this.onAudit?.({ kind: "cmd_net", command, cwd: this.root });
    this.onAudit?.({ kind: "cmd_run", command, cwd: this.root });
    const cap = this.outputCap;
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: this.root, timeout: this.commandTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env } },
        (err, stdout, stderr) => {
          const cut = (s: string) => ((s ?? "").length > cap ? (s ?? "").slice(0, cap) + `…（截断，共 ${(s ?? "").length} 字符）` : (s ?? ""));
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
      default:
        throw new Error(`工作区里没有这个工具：${name}`);
    }
  }

  /** office 工具（M2-06）：路径钉在工作区；能力未注入（壳没装配）就如实说 */
  private officeTool(name: string, args: Record<string, unknown>): string {
    if (!this.office) {
      return "office 能力未装配（当前进程没有 office 引擎桥接）——请回报此限制，改用 CSV 或在简报里说明。";
    }
    const rel = String(args.path ?? "");
    const full = resolveWithin(this.root, rel);
    if (name === "office_read_table") {
      const r = this.office.read(full);
      return JSON.stringify(r, null, 2);
    }
    const w = this.office.write(full, {
      headers: (args.headers as string[]) ?? [],
      rows: (args.rows as string[][]) ?? [],
    });
    return JSON.stringify(w, null, 2);
  }
}

/** 官方执行工具的 schema（成员白名单按名字过滤后使用） */
export const TOOLKIT_SCHEMAS = [
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
      description: "在工作区内执行一条命令（120s 超时，输出截断 8K；明显破坏性命令会被拒绝）。",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];
