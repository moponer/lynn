// 逐轮文件检查点（M1-12）：每次写之前留一份原文件，`/undo` 恢复上一轮改动。
// 记录只在壳里，成员侧只负责"写之前喊一声"，不碰备份逻辑。
import * as fs from "node:fs";
import * as path from "node:path";

interface Entry {
  rel: string;
  full: string;
  backup?: string;
  existed: boolean;
}

export class CheckpointStore {
  private current: { turnId: string; dir: string; entries: Entry[] } | null = null;

  constructor(private readonly root: string) {}

  /** 每轮开始调用；只保留最近 10 份检查点 */
  begin(turnId: string): void {
    this.discard();
    const dir = path.join(this.root, turnId);
    fs.mkdirSync(dir, { recursive: true });
    this.current = { turnId, dir, entries: [] };
    this.prune();
  }

  /** Toolkit 在覆盖文件前调用：existed=false 表示这轮新建的文件，撤销时要删掉 */
  beforeWrite(rel: string, full: string, existed: boolean): void {
    const cur = this.current;
    if (!cur) return;
    let backup: string | undefined;
    if (existed) {
      try {
        backup = path.join(cur.dir, `${cur.entries.length}-${path.basename(full)}`);
        fs.copyFileSync(full, backup);
      } catch {
        backup = undefined;
      }
    }
    cur.entries.push({ rel, full, backup, existed });
  }

  status(): { turnId: string; files: string[] } | null {
    if (!this.current || !this.current.entries.length) return null;
    return { turnId: this.current.turnId, files: [...new Set(this.current.entries.map((e) => e.rel))] };
  }

  /** 撤销本轮：有备份的还原，本轮新建的删除。返回给人看的计数 */
  undo(): { restored: string[]; removed: string[] } {
    const cur = this.current;
    if (!cur) return { restored: [], removed: [] };
    const restored: string[] = [];
    const removed: string[] = [];
    for (const e of [...cur.entries].reverse()) {
      try {
        if (e.existed && e.backup) {
          fs.mkdirSync(path.dirname(e.full), { recursive: true });
          fs.copyFileSync(e.backup, e.full);
          restored.push(e.rel);
        } else if (!e.existed) {
          fs.rmSync(e.full, { force: true });
          removed.push(e.rel);
        }
      } catch {
        /* 单个文件失败不影响其它文件回滚，计数里不重复 */
      }
    }
    fs.rmSync(cur.dir, { recursive: true, force: true });
    this.current = null;
    return { restored, removed };
  }

  /** 用户验收/新会话时丢弃本轮检查点 */
  discard(): void {
    const cur = this.current;
    if (!cur) return;
    fs.rmSync(cur.dir, { recursive: true, force: true });
    this.current = null;
  }

  private prune(): void {
    try {
      const dirs = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, at: fs.statSync(path.join(this.root, d.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const d of dirs.slice(10)) fs.rmSync(path.join(this.root, d.name), { recursive: true, force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
}
