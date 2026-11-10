// M2-05：会话记忆两层（§4.9 L696–697）
//  - USER.md   —— 用户记忆：偏好/项目背景/约定。永远保留，跨任务跨团队都读。
//  - MEMORY.md —— 助理记忆：她的判断习惯/未完成事项/踩过的坑。随会话累积。
// 纪律：可查看、可 diff、可删、可回滚——每次保存自动留版本；.lynnpack 永不含记忆。
import * as fs from "node:fs";
import * as path from "node:path";

export type MemoryKind = "user" | "memory";

const FILES: Record<MemoryKind, string> = { user: "USER.md", memory: "MEMORY.md" };
const MAX_VERSIONS = 20;

export interface MemoryVersion {
  id: string;
  savedAt: string;
  chars: number;
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
