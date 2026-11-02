import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 任务卷宗（计划书 §4.8）：`~/.lynn/tasks/<id>/`
 *   timeline.jsonl —— 全量事件，逐条追加、永不改写
 *   artifacts/     —— 产出工件，永久保留
 *   summary.md     —— 滚动摘要（给人和模型省窗口）
 *
 * 卷宗与工单实体分开：`task-store` 管权威状态，这里管证据与过程。
 */

export interface TimelineEvent {
  at: string;
  kind: "created" | "assign" | "report" | "reject" | "approve" | "transition" | "artifact" | "note" | "session";
  member?: string;
  text: string;
  meta?: Record<string, unknown>;
}

export class TaskCase {
  constructor(readonly dataRoot: string) {}

  dir(id: string): string {
    return path.join(this.dataRoot, "tasks", id);
  }

  artifactsDir(id: string): string {
    return path.join(this.dir(id), "artifacts");
  }

  timelineFile(id: string): string {
    return path.join(this.dir(id), "timeline.jsonl");
  }

  summaryFile(id: string): string {
    return path.join(this.dir(id), "summary.md");
  }

  /** 追加事件：永不改写（审计与回查的底） */
  append(id: string, ev: Omit<TimelineEvent, "at"> & { at?: string }): void {
    fs.mkdirSync(this.artifactsDir(id), { recursive: true });
    const line = JSON.stringify({ at: ev.at ?? new Date().toISOString(), ...ev }) + "\n";
    fs.appendFileSync(this.timelineFile(id), line, "utf-8");
  }

  readTimeline(id: string): TimelineEvent[] {
    const f = this.timelineFile(id);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TimelineEvent);
  }

  /** 安全文件名：只留 basename，去掉路径分隔与非法字符 */
  private safeName(name: string): string {
    const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!base || base === "." || base === "..") throw new Error(`非法工件名: ${name}`);
    return base;
  }

  /** 把一个真实文件收进 artifacts/（永久保留），返回卷宗内相对路径 */
  importArtifact(id: string, srcPath: string): { ref: string; abs: string; bytes: number } {
    const abs = path.resolve(srcPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`不是文件: ${srcPath}`);
    const dir = this.artifactsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    let name = this.safeName(abs);
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      // 同名不覆盖：加时间戳后缀，保持"永不改写"
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      name = `${stamp}-${name}`;
      target = path.join(dir, name);
    }
    fs.copyFileSync(abs, target);
    const ref = `artifacts/${name}`;
    this.append(id, { kind: "artifact", text: `收录工件 ${name}`, meta: { ref, bytes: st.size } });
    return { ref, abs: target, bytes: st.size };
  }

  /** 直接写一个工件（文本/二进制） */
  writeArtifact(id: string, name: string, content: string | Buffer): { ref: string; abs: string; bytes: number } {
    const dir = this.artifactsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, this.safeName(name));
    fs.writeFileSync(target, content);
    const bytes = fs.statSync(target).size;
    const ref = `artifacts/${path.basename(target)}`;
    this.append(id, { kind: "artifact", text: `写入工件 ${path.basename(target)}`, meta: { ref, bytes } });
    return { ref, abs: target, bytes };
  }

  /**
   * 证据是否可点开验证：
   *  - `artifacts/x`、相对路径、绝对路径 → 必须真的存在；
   *  - http(s) 快照 → 离线无法验证，返回 false（不假装验过）。
   */
  verifyRef(id: string, ref: string): boolean {
    if (!ref || ref.trim() === "") return false;
    if (/^https?:\/\//i.test(ref)) return false;
    const candidates = path.isAbsolute(ref)
      ? [ref]
      : [path.join(this.dir(id), ref), path.resolve(ref), path.join(this.dataRoot, ref)];
    return candidates.some((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  }

  /** 滚动摘要：追加一行（时间 + 事件）；文件不存在则建头 */
  appendSummary(id: string, line: string): void {
    fs.mkdirSync(this.dir(id), { recursive: true });
    const f = this.summaryFile(id);
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, `# 任务 ${id} · 滚动摘要\n\n`, "utf-8");
    }
    const at = new Date().toLocaleString("zh-CN", { hour12: false });
    fs.appendFileSync(f, `- ${at} ${line}\n`, "utf-8");
  }

  readSummary(id: string): string {
    const f = this.summaryFile(id);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "";
  }
}
