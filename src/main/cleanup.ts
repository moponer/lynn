import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 数据清理（2026-11-10 工作区生命周期 P2-1）。
 *
 * 只做三类**低价值、可再生**的数据，且全部在数据根内：
 *  - `tasks/<id>/scratch/`：过程文件（下载/解压/测试输出），超 TTL 直接删；
 *  - `checkpoints/`：逐轮文件检查点，超 TTL 删；
 *  - `logs/*.log`（保留当前 agent.log）：超 TTL 删。
 *
 * **永不自动删**：`deliverables/`、`tasks/<id>/artifacts/`、用户项目目录、
 * `tasks/<id>/workspace/`（sandbox 完整工作树——目前只统计大小，交给用户手动处理）。
 */

export interface Retention {
  scratchDays: number;
  checkpointDays: number;
  logDays: number;
}

export const DEFAULT_RETENTION: Retention = { scratchDays: 14, checkpointDays: 7, logDays: 7 };

export interface DataUsage {
  totalBytes: number;
  tasksBytes: number;
  scratchBytes: number;
  artifactsBytes: number;
  sandboxBytes: number;
  logsBytes: number;
  checkpointsBytes: number;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      /* 读不到的跳过，不编数字 */
    }
  }
  return total;
}

/** 只统计显示用的用量；单个目录读不到就当 0（并如实体现在 total 里） */
export function measureUsage(dataRoot: string): DataUsage {
  const tasksDir = path.join(dataRoot, "tasks");
  const ids = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  let scratch = 0;
  let artifacts = 0;
  let sandbox = 0;
  for (const id of ids) {
    const base = path.join(tasksDir, id);
    scratch += dirSize(path.join(base, "scratch"));
    artifacts += dirSize(path.join(base, "artifacts"));
    sandbox += dirSize(path.join(base, "workspace"));
  }
  const logs = dirSize(path.join(dataRoot, "logs"));
  const checkpoints = dirSize(path.join(dataRoot, "checkpoints"));
  return {
    totalBytes: scratch + artifacts + sandbox + logs + checkpoints,
    tasksBytes: scratch + artifacts + sandbox,
    scratchBytes: scratch,
    artifactsBytes: artifacts,
    sandboxBytes: sandbox,
    logsBytes: logs,
    checkpointsBytes: checkpoints,
  };
}

/** 删一个目录/文件；返回释放的字节。失败返回 0（不抛，清理不该炸主流程） */
function removePath(p: string): number {
  let size = 0;
  try {
    const st = fs.statSync(p);
    size = st.isDirectory() ? dirSize(p) : st.size;
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    return size;
  } catch {
    return 0;
  }
}

function olderThan(p: string, cutoff: number): boolean {
  try {
    return fs.statSync(p).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

/**
 * 执行清理：按 TTL 删 scratch / checkpoints / 旧日志。
 * `now` 可注入，便于测试；返回真实释放字节与被删路径（界面如实展示）。
 */
export function runCleanup(
  dataRoot: string,
  retention: Retention = DEFAULT_RETENTION,
  now = Date.now(),
): { freedBytes: number; removed: string[] } {
  const removed: string[] = [];
  let freedBytes = 0;
  const cut = (days: number) => now - Math.max(0, days) * 86_400_000;

  // 1) 每张单的 scratch
  const tasksDir = path.join(dataRoot, "tasks");
  if (fs.existsSync(tasksDir)) {
    for (const e of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const scratch = path.join(tasksDir, e.name, "scratch");
      if (!fs.existsSync(scratch)) continue;
      // scratch 目录本身的 mtime 可能在持续写入时不更新：逐个子项判
      for (const child of fs.readdirSync(scratch, { withFileTypes: true })) {
        const p = path.join(scratch, child.name);
        if (!olderThan(p, cut(retention.scratchDays))) continue;
        const freed = removePath(p);
        if (freed > 0) {
          freedBytes += freed;
          removed.push(p);
        }
      }
    }
  }

  // 2) 检查点（目录里的文件/子目录都按 mtime 判）
  const cp = path.join(dataRoot, "checkpoints");
  if (fs.existsSync(cp)) {
    for (const child of fs.readdirSync(cp, { withFileTypes: true })) {
      const p = path.join(cp, child.name);
      if (!olderThan(p, cut(retention.checkpointDays))) continue;
      const freed = removePath(p);
      if (freed > 0) {
        freedBytes += freed;
        removed.push(p);
      }
    }
  }

  // 3) 日志：当前 agent.log / server.log 留着；轮转文件按 TTL
  const logs = path.join(dataRoot, "logs");
  if (fs.existsSync(logs)) {
    for (const child of fs.readdirSync(logs, { withFileTypes: true })) {
      if (!child.isFile() || !/\.log(\.\d+)?$/i.test(child.name)) continue;
      if (/^(agent|server)\.log$/i.test(child.name)) continue;
      const p = path.join(logs, child.name);
      if (!olderThan(p, cut(retention.logDays))) continue;
      const freed = removePath(p);
      if (freed > 0) {
        freedBytes += freed;
        removed.push(p);
      }
    }
  }

  return { freedBytes, removed };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
