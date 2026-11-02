// 孤儿 worker 清理：上一轮异常退出后，Pi 子进程可能还挂在后台。
// 做法与 tether 的 agent-orphans 同形：worker 启动写标记（pid + entry），正常退出删标记；
// 下次启动时把「还活着但没有本进程照看」的标记对应进程杀掉，死标记直接清掉。
import * as fs from "node:fs";
import * as path from "node:path";
import { killProcessTree } from "./process-tree";

export interface WorkerMarker {
  pid: number;
  entry: string;
  startedAt: string;
}

const markerFile = (dir: string, pid: number) => path.join(dir, `${pid}.json`);

export function writeWorkerMarker(dir: string, marker: WorkerMarker): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerFile(dir, marker.pid), JSON.stringify(marker), "utf-8");
  } catch {
    /* 标记失败不影响运行 */
  }
}

export function clearWorkerMarker(dir: string, pid: number): void {
  try {
    fs.unlinkSync(markerFile(dir, pid));
  } catch {
    /* 已经没了 */
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在，只是不归我们；ESRCH：真的没了
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 清理孤儿。返回被杀掉的 pid 列表。
 * 只处理「entry 与当前 entry 一致」的标记，避免误杀别的应用的同名进程。
 */
export function reapOrphanWorkers(
  dir: string,
  opts: {
    entry: string;
    alive?: (pid: number) => boolean;
    kill?: (pid: number) => void;
  },
): number[] {
  const alive = opts.alive ?? defaultAlive;
  const kill = opts.kill ?? ((pid: number) => void killProcessTree(pid, "SIGKILL"));
  const killed: number[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return killed;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let marker: WorkerMarker | null = null;
    try {
      marker = JSON.parse(fs.readFileSync(file, "utf-8")) as WorkerMarker;
    } catch {
      marker = null;
    }
    const pid = marker?.pid ?? Number(name.replace(/\.json$/, ""));
    const sameEntry = !marker?.entry || path.resolve(marker.entry) === path.resolve(opts.entry);
    if (Number.isFinite(pid) && pid > 0 && sameEntry && alive(pid)) {
      try {
        kill(pid);
        killed.push(pid);
      } catch {
        /* 杀不掉就留着下次 */
      }
    }
    clearWorkerMarker(dir, pid);
  }
  return killed;
}
