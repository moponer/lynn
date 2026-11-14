// M2-05：会话记忆两层（§4.9 L696–697）
//  - USER.md   —— 用户记忆：偏好/项目背景/约定。永远保留，跨任务跨团队都读。
//  - MEMORY.md —— 助理记忆：她的判断习惯/未完成事项/踩过的坑。随会话累积。
// 纪律：可查看、可 diff、可删、可回滚——每次保存自动留版本；.lynnpack 永不含记忆。
import * as fs from "node:fs";
import * as path from "node:path";

export type MemoryKind = "user" | "memory";

const FILES: Record<MemoryKind, string> = { user: "USER.md", memory: "MEMORY.md" };
const MAX_VERSIONS = 20;
/** 项目记忆的条数上限与注入预算（2026-11-14） */
const PROJECT_MAX_ENTRIES = 100;
const PROJECT_PROMPT_BUDGET = 2_000;

/** 写入前脱敏：这些形态基本只会是密钥，被注入到提示词里等于泄露 */
function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "***")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=***");
}

export interface MemoryVersion {
  id: string;
  savedAt: string;
  chars: number;
}

/** 一条记忆（行级）：用于定位与删除 */
export interface MemoryEntry {
  /** 在文件里的行号（1 起） */
  line: number;
  /** 行首时间戳（没有就是空串） */
  at: string;
  /** 正文（去掉时间戳后的内容） */
  text: string;
}

/**
 * 解析记忆条目：只认 "- " 开头的条目行。
 * 模板说明行（"# " 开头）与空行不算条目。
 */
export function parseEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const lines = (content ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trimStart().startsWith("- ")) continue;
    const body = raw.trimStart().slice(2).trim();
    if (!body) continue;
    const m = body.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.*)$/);
    out.push({ line: i + 1, at: m ? m[1] : "", text: m ? m[2] : body });
  }
  return out;
}

export interface ForgetResult {
  ok: boolean;
  error?: string;
  /** 删掉的那一条 */
  removed?: MemoryEntry;
  /** 匹配到多条时的候选（让调用方换更具体的关键词） */
  candidates?: { line: number; text: string }[];
  /** 这次保存产生的版本 id（可回滚） */
  versionId?: string;
}

/** 行级 diff（简单 LCS 不做，够用的顺序对齐）：返回 [状态, 行] 列表，状态 = same/+/− */
export function diffLines(a: string, b: string): { t: "same" | "add" | "del"; line: string }[] {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const out: { t: "same" | "add" | "del"; line: string }[] = [];
  // 双指针顺序对齐；旧行不在新行就标删，新行不在旧行就标加（同一文本的多次快照间足够用）
  let i = 0;
  let j = 0;
  const setB = new Set(B);
  const setA = new Set(A);
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      out.push({ t: "same", line: A[i] });
      i += 1;
      j += 1;
    } else if (i < A.length && !setB.has(A[i])) {
      out.push({ t: "del", line: A[i] });
      i += 1;
    } else if (j < B.length && !setA.has(B[j])) {
      out.push({ t: "add", line: B[j] });
      j += 1;
    } else {
      // 两边都有但位置不同：按删除+新增记
      if (i < A.length) {
        out.push({ t: "del", line: A[i] });
        i += 1;
      }
      if (j < B.length) {
        out.push({ t: "add", line: B[j] });
        j += 1;
      }
    }
  }
  return out;
}

const USER_TEMPLATE = `# 用户记忆

<!-- 你的偏好、项目背景、约定、常用路径、称呼习惯。永远保留，跨任务都读。 -->
`;

const MEMORY_TEMPLATE = `# 助理记忆

<!-- 她的判断习惯、做事方法、未完成事项、踩过的坑。随会话累积，可 diff、可回滚。 -->
`;

export class MemoryStore {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "memory");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(kind: MemoryKind): string {
    return path.join(this.dir, FILES[kind]);
  }

  private versionsDir(kind: MemoryKind): string {
    return path.join(this.dir, `${kind}-versions`);
  }

  load(kind: MemoryKind): string {
    try {
      const raw = fs.readFileSync(this.file(kind), "utf-8");
      if (raw.trim()) return raw;
    } catch {
      /* 首次 */
    }
    const template = kind === "user" ? USER_TEMPLATE : MEMORY_TEMPLATE;
    fs.writeFileSync(this.file(kind), template, "utf-8");
    return template;
  }

  save(kind: MemoryKind, text: string): string {
    const content = (text ?? "").trim()
      ? text
      : kind === "user"
        ? USER_TEMPLATE
        : MEMORY_TEMPLATE;
    // 存档改之前的版本
    try {
      const prev = fs.readFileSync(this.file(kind), "utf-8");
      if (prev.trim()) this.archive(kind, prev);
    } catch {
      /* 还没有 */
    }
    fs.writeFileSync(this.file(kind), content, "utf-8");
    return this.archive(kind, content);
  }

  private archive(kind: MemoryKind, text: string): string {
    const dir = this.versionsDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${kind}-${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(dir, `${id}.md`), text, "utf-8");
    this.prune(kind);
    return id;
  }

  /**
   * 删掉一条记忆（2026-11-13）：此前只能追加与整版回滚，"删掉某一条"做不到——
   * 于是取消掉的事实只能靠追加一条"已作废"糊过去，记忆越滚越绕。
   *
   * 语义：
   *  - 按关键词定位（大小写不敏感；中文按包含匹配）
   *  - 命中 0 条 = 失败并说清；命中多条 = 失败并列出候选（要求更具体的关键词，不猜哪条）
   *  - 命中 1 条 = 删掉并落一版（可回滚）
   */
  forget(kind: MemoryKind, keyword: string): ForgetResult {
    const kw = (keyword ?? "").trim().toLowerCase();
    if (!kw) return { ok: false, error: "关键词不能为空" };
    const content = this.load(kind);
    const lines = content.split(/\r?\n/);
    const entries = parseEntries(content);
    const hits = entries.filter((e) => e.text.toLowerCase().includes(kw));
    if (hits.length === 0) {
      return { ok: false, error: `没有匹配「${keyword}」的记忆条目（当前 ${entries.length} 条）` };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `匹配到 ${hits.length} 条，换更具体的关键词再删（我不动手猜删哪条）`,
        candidates: hits.map((e) => ({ line: e.line, text: e.text.slice(0, 120) })),
      };
    }
    const target = hits[0];
    const next = lines.filter((_, i) => i !== target.line - 1).join("\n");
    // save 会把改前的内容归档一版 → 删错了能回滚
    const versionId = this.save(kind, next);
    return { ok: true, removed: target, versionId };
  }

  versions(kind: MemoryKind): MemoryVersion[] {
    const dir = this.versionsDir(kind);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { id: f.replace(/\.md$/, ""), savedAt: st.mtime.toISOString(), chars: st.size };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, MAX_VERSIONS);
  }

  /** 两版对比：现在 vs 指定版本 */
  diff(kind: MemoryKind, versionId?: string): { from: string; to: string; changes: { t: "same" | "add" | "del"; line: string }[] } {
    const now = this.load(kind);
    let from = "";
    if (versionId) {
      const full = path.join(this.versionsDir(kind), `${versionId}.md`);
      if (!versionId.match(/^[a-z]+-[a-z0-9]+$/) || !fs.existsSync(full)) throw new Error(`记忆版本不存在：${versionId}`);
      from = fs.readFileSync(full, "utf-8");
    } else {
      const vs = this.versions(kind);
      if (vs.length) {
        const full = path.join(this.versionsDir(kind), `${vs[vs.length - 1].id}.md`);
        from = fs.readFileSync(full, "utf-8");
      } else {
        from = now;
      }
    }
    return { from: versionId ?? "(上一版)", to: "(当前)", changes: diffLines(from, now) };
  }

  rollback(kind: MemoryKind, versionId: string): string {
    const full = path.join(this.versionsDir(kind), `${versionId}.md`);
    if (!versionId.match(/^[a-z]+-[a-z0-9]+$/) || !fs.existsSync(full)) throw new Error(`记忆版本不存在：${versionId}`);
    const text = fs.readFileSync(full, "utf-8");
    fs.writeFileSync(this.file(kind), text, "utf-8");
    return text;
  }

  /**
   * 两层拼进 system prompt 的记忆段（USER 全文 + MEMORY 全文；空模板不占空间）。
   * 行首写入时间戳（`- 2026-11-09 13:22 事实`）在注入时剥掉：磁盘保留可追溯，
   * prompt 只留事实——否则同一条记忆重存一次，system prompt 中段就变，整段前缀缓存作废。
   */
  systemPromptSection(): string {
    const stripStamp = (text: string) => text.replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+/gm, "- ");
    const user = stripStamp(this.load("user"));
    const mem = stripStamp(this.load("memory"));
    const parts: string[] = [];
    if (user.trim().split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--")).length > 0) {
      parts.push(`【用户记忆（USER.md，跨任务保留）】\n${user.trim()}`);
    }
    if (mem.trim().split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--")).length > 0) {
      parts.push(`【助理记忆（MEMORY.md）】\n${mem.trim()}`);
    }
    return parts.length ? `\n${parts.join("\n\n")}\n` : "";
  }

  // ---------- 项目级记忆（2026-11-14） ----------
  // 为什么单独一层：USER/MEMORY 是"跨任务的她本人"，项目事实（这个仓库怎么跑测试、谁负责哪块、
  // 上次为什么这么改）属于**这个项目**，塞进全局记忆会互相污染，换个项目就看到别人的事。

  private projectFile(projectId: string): string {
    const safe = String(projectId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) throw new Error("项目 id 不合法");
    return path.join(this.dir, "projects", `${safe}.md`);
  }

  loadProject(projectId: string): string {
    try {
      return fs.readFileSync(this.projectFile(projectId), "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * 记一条项目事实（同一项目跨会话可见）。
   *  - 去重：归一化（小写 + 去掉标点空白）后与已有条目比，重复的不算新增；
   *  - 脱敏：常见密钥形态写入前替换成 ***（项目记忆会被注入提示词）；
   *  - 上限 100 条：超出丢最旧的（项目记忆是"当前事实"，不是流水账）。
   */
  learnProject(projectId: string, entry: string): { ok: boolean; added?: boolean; error?: string } {
    const text = redactSecrets(String(entry ?? "").trim().replace(/\s+/g, " ")).slice(0, 500);
    if (!text) return { ok: false, error: "记忆内容不能为空" };
    let file: string;
    try {
      file = this.projectFile(projectId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const entries = parseEntries(this.loadProject(projectId));
    const key = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
    if (entries.some((e) => key(e.text) === key(text))) return { ok: true, added: false };

    const keep = entries.length >= PROJECT_MAX_ENTRIES ? entries.slice(entries.length - PROJECT_MAX_ENTRIES + 1) : entries;
    const lines = keep.map((e) => `- ${e.at ? `${e.at} ` : ""}${e.text}`);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    lines.push(`- ${stamp} ${text}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# 项目记忆\n\n${lines.join("\n")}\n`, "utf-8");
    return { ok: true, added: true };
  }

  /** 项目记忆注入段：只取最近若干条（2K 字预算），头里说清这是局部 */
  projectSection(projectId?: string): string {
    if (!projectId) return "";
    const entries = parseEntries(this.loadProject(projectId));
    if (!entries.length) return "";
    const picked: string[] = [];
    let chars = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const line = `- ${entries[i].text}`;
      if (chars + line.length > PROJECT_PROMPT_BUDGET && picked.length) break;
      picked.unshift(line);
      chars += line.length;
    }
    const dropped = entries.length - picked.length;
    return `\n【项目记忆（这个项目的事实，跨会话保留${dropped ? `；只列最近 ${picked.length} 条` : ""}）】\n${picked.join("\n")}\n`;
  }

  private prune(kind: MemoryKind): void {
    const dir = this.versionsDir(kind);
    const vs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const v of vs.slice(MAX_VERSIONS)) {
      try {
        fs.rmSync(path.join(dir, v.f), { force: true });
      } catch {
        /* 删不掉就留着 */
      }
    }
  }
}
