// M2-04：本地知识库（§3.5 L309；§4.6 L632）。
//  - 权威是 ~/.lynn/knowledge/*.md（用户可直接编辑）；FTS5 trigram 索引只为检索。
//  - 中文检索必须 trigram（unicode61 按字切召回不可用）；查询 <3 字符如实拒绝（trigram 的硬约束）。
//  - 增量索引：mtime 没变就不重读；文件删了索引同步删；体积如实报。
import * as fs from "node:fs";
import * as path from "node:path";

export interface KbHit {
  file: string;
  title: string;
  /** 命中片段（前后各留 40 字） */
  snippet: string;
  score: number;
}

export interface KbIndexStats {
  docs: number;
  /** FTS 索引行数（≈文档 3 字滑窗数，中文膨胀 ~3x，如实报） */
  tokens: number;
  dbBytes: number;
  indexedAt: string;
}

const SNIPPET = 40;

function safeQuery(q: string): string | null {
  // 只保留中英文/数字，空格切词后 OR 连接（查不全就查不全，不猜意图）
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length >= 3); // trigram 需要 ≥3 字符
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

function snippetOf(body: string, q: string): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const term of q.split(/\s+/)) {
    const t = term.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase();
    if (t.length >= 3) {
      idx = lower.indexOf(t);
      if (idx >= 0) break;
    }
  }
  if (idx < 0) return body.slice(0, SNIPPET * 2).trim();
  const start = Math.max(0, idx - SNIPPET);
  const end = Math.min(body.length, idx + SNIPPET);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

export class KnowledgeStore {
  readonly dir: string;
  private db: unknown;
  readonly backend: "sqlite" | "unavailable";

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "knowledge");
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
      this.db = new DatabaseSync(path.join(dataRoot, "knowledge.db"));
      (this.db as { exec: (s: string) => void }).exec(`
        CREATE TABLE IF NOT EXISTS docs (
          file TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL,
          chars INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(file UNINDEXED, body, tokenize='trigram');
      `);
      this.backend = "sqlite";
    } catch {
      this.backend = "unavailable";
    }
  }

  private run(sql: string, ...args: unknown[]): unknown {
    return (this.db as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(sql).run(...args);
  }

  private all<T>(sql: string, ...args: unknown[]): T[] {
    return (this.db as { prepare: (s: string) => { all: (...a: unknown[]) => T[] } }).prepare(sql).all(...args) as T[];
  }

  /** 单文件索引（mtime 变了才重读重排）；返回是否实际索引 */
  indexFile(full: string, now: Date = new Date()): boolean {
    if (this.backend !== "sqlite") return false;
    const rel = path.relative(this.dir, full).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const st = fs.statSync(full);
    const cur = this.all<{ mtime_ms: number }>("SELECT mtime_ms FROM docs WHERE file = ?", rel);
    if (cur.length && cur[0].mtime_ms === st.mtimeMs) return false;
    const body = fs.readFileSync(full, "utf-8");
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.basename(rel, ".md");
    this.run("DELETE FROM docs WHERE file = ?", rel);
    this.run("DELETE FROM docs_fts WHERE file = ?", rel);
    this.run("INSERT INTO docs (file, title, mtime_ms, chars) VALUES (?, ?, ?, ?)", rel, title, st.mtimeMs, body.length);
    this.run("INSERT INTO docs_fts (file, body) VALUES (?, ?)", rel, body);
    void now;
    return true;
  }

  /** 全量增量索引 + 清掉已删除文件的索引 */
  reindex(): { indexed: number; removed: number } {
    let indexed = 0;
    let removed = 0;
    if (this.backend !== "sqlite") return { indexed, removed };
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".md")) {
          files.push(path.relative(this.dir, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(this.dir);
    for (const rel of files) {
      if (this.indexFile(path.join(this.dir, rel))) indexed += 1;
    }
    // 已删除的文件同步删索引
    const known = this.all<{ file: string }>("SELECT file FROM docs");
    for (const { file } of known) {
      if (!files.includes(file)) {
        this.run("DELETE FROM docs WHERE file = ?", file);
        this.run("DELETE FROM docs_fts WHERE file = ?", file);
        removed += 1;
      }
    }
    return { indexed, removed };
  }

  search(q: string, limit = 8): { hits: KbHit[]; error?: string } {
    if (this.backend !== "sqlite") return { hits: [], error: "知识库索引不可用（node:sqlite 缺失）" };
    const match = safeQuery(q);
    if (!match) return { hits: [], error: "查询太短：trigram 检索至少要 3 个字符（中英文均可）" };
    let rows: { file: string; title: string; body: string; rank: number }[];
    try {
      rows = this.all<{ file: string; title: string; body: string; rank: number }>(
        `SELECT d.file, d.title, f.body, f.rank FROM docs_fts f JOIN docs d ON d.file = f.file WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`,
        match,
        limit,
      );
    } catch (err) {
      return { hits: [], error: `检索失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const plain = q.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, " ");
    return {
      hits: rows.map((r) => ({ file: r.file, title: r.title, snippet: snippetOf(r.body, plain), score: Number(r.rank) })),
    };
  }

  read(rel: string): { title: string; body: string } | null {
    const full = path.join(this.dir, rel);
    if (!fs.existsSync(full) || !full.startsWith(this.dir)) return null;
    const body = fs.readFileSync(full, "utf-8");
    return { title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.basename(rel, ".md"), body };
  }

  list(): { file: string; title: string; chars: number }[] {
    if (this.backend !== "sqlite") return [];
    return this.all<{ file: string; title: string; chars: number }>("SELECT file, title, chars FROM docs ORDER BY title").map((r) => ({
      file: r.file,
      title: r.title,
      chars: r.chars,
    }));
  }

  stats(): KbIndexStats {
    const dbPath = path.join(path.dirname(this.dir), "knowledge.db");
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(dbPath).size;
    } catch {
      /* 还没建 */
    }
    let tokens = 0;
    if (this.backend === "sqlite") {
      try {
        tokens = Number(this.all<{ c: number }>("SELECT COUNT(*) AS c FROM docs_fts")[0]?.c ?? 0);
      } catch {
        tokens = 0;
      }
    }
    return { docs: this.list().length, tokens, dbBytes, indexedAt: new Date().toISOString() };
  }
}
