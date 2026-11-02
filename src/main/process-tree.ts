import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

/**
 * 进程树击杀：先子孙后自己，确保 shell / 工具子进程不残留。
 * 参考实现：tt-11-dd/tether-ai（MIT）src/main/process-tree.ts。
 * Windows 用 taskkill /t /f（无 POSIX 进程组语义）；其它平台走 pgrep 递归 + 进程组信号。
 */
const execFileAsync = promisify(execFile);

export async function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 已退出
      }
    }
    return;
  }
  const children = await listChildPids(pid);
  await Promise.all(children.map((child) => killProcessTree(child, signal)));
  try {
    process.kill(-pid, signal);
  } catch {
    // 不是组长或已退出
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 已退出
  }
}

/** 崩溃兜底 / 紧急退出用（同步，不能 await） */
export function killProcessTreeSync(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 已退出
      }
    }
    return;
  }
  for (const child of listChildPidsSync(pid)) killProcessTreeSync(child, signal);
  try {
    process.kill(-pid, signal);
  } catch {
    // 已退出
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 已退出
  }
}

export async function listChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return parsePids(stdout);
  } catch {
    return [];
  }
}

export function listChildPidsSync(pid: number): number[] {
  try {
    return parsePids(
      execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    );
  } catch {
    return [];
  }
}

function parsePids(out: string): number[] {
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
