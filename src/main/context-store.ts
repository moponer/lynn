import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 三层存储的「温层」（计划书 §4.8）：滚动摘要 + 最近 N 轮。
 *
 * 热层 = 当前轮上下文（内存，kernel.history）
 * 温层 = 本文件（`~/.lynn/session/context.json`）：摘要 + 最近若干轮，重开线程时恢复"说到哪了"
 * 冷层 = `session/timeline.jsonl` 与任务卷宗（原文一字不动，永不丢）
 *
 * 说明：计划书写的是 SQLite；这里先用 JSON 落盘（字段与语义一致），
 * SQLite/ FTS 化在 M2-04 知识库时一并做，避免为摘要单独引入原生依赖。
 */

export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface ContextFile {
  summary: string;
  /** 已被摘要掉的轮次数（审计用） */
  summarizedTurns: number;
  recent: StoredTurn[];
  updatedAt: string;
}

const MAX_SUMMARY_CHARS = 4000;

export class ContextStore {
  constructor(readonly dataRoot: string) {}

  private get file(): string {
    return path.join(this.dataRoot, "session", "context.json");
  }

  read(): ContextFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<ContextFile>;
      return {
        summary: typeof raw.summary === "string" ? raw.summary : "",
        summarizedTurns: typeof raw.summarizedTurns === "number" ? raw.summarizedTurns : 0,
        recent: Array.isArray(raw.recent) ? (raw.recent as StoredTurn[]) : [],
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return { summary: "", summarizedTurns: 0, recent: [], updatedAt: new Date().toISOString() };
    }
  }

  private write(c: ContextFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), "utf-8");
    fs.renameSync(tmp, this.file);
  }

  append(role: StoredTurn["role"], content: string): ContextFile {
    const c = this.read();
    c.recent.push({ role, content, at: new Date().toISOString() });
    c.updatedAt = new Date().toISOString();
    this.write(c);
    return c;
  }

  /** 恢复上下文：只带摘要 + 最近若干轮；摘要当一条前置说明 */
  asMessages(limit = 10): { role: "user" | "assistant"; content: string }[] {
    const c = this.read();
    const recent = c.recent.slice(-limit).map((t) => ({ role: t.role, content: t.content }));
    if (!c.summary) return recent;
    return [{ role: "user", content: `（更早的对话已压缩成摘要，供参考）\n${c.summary}` }, ...recent];
  }

  /**
   * 超过阈值就压缩：把较早的轮次压成规则摘要，只留最近 N 轮。
   * 规则摘要（非模型）：保留早期用户请求的首句，避免"摘要烧钱且不可预期"。
   */
  maybeCompact(opts: { keepRecent?: number; maxTurns?: number; maxChars?: number } = {}): {
    compacted: boolean;
    moved: number;
    total: number;
  } {
    const keepRecent = opts.keepRecent ?? 10;
    const maxTurns = opts.maxTurns ?? 24;
    const maxChars = opts.maxChars ?? 20000;
    const c = this.read();
    const chars = c.recent.reduce((n, t) => n + t.content.length, 0);
    if (c.recent.length <= maxTurns && chars <= maxChars) {
      return { compacted: false, moved: 0, total: c.recent.length };
    }

    const moveCount = Math.max(0, c.recent.length - keepRecent);
    const moving = c.recent.slice(0, moveCount);
    const kept = c.recent.slice(moveCount);

    const lines = moving
      .filter((t) => t.role === "user")
      .map((t) => `- ${t.content.replace(/\s+/g, " ").slice(0, 80)}`);
    const merged = [c.summary, ...lines].filter(Boolean).join("\n");
    // 只保留尾部，别让摘要自己变成大上下文
    const summary = merged.length > MAX_SUMMARY_CHARS ? `…\n${merged.slice(-MAX_SUMMARY_CHARS)}` : merged;

    this.write({
      summary,
      summarizedTurns: c.summarizedTurns + moveCount,
      recent: kept,
      updatedAt: new Date().toISOString(),
    });
    return { compacted: true, moved: moveCount, total: kept.length };
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
