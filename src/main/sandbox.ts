/**
 * 沙箱接入层（2026-11-17 P5-1b / 13 章 M4–M5）。
 *
 * 这一层的职责只有两件，都是"别撒谎"：
 *  1. **探一次，说清楚现在到底是哪一档**。AppContainer 不可用时，界面上不能还写着"已隔离"。
 *  2. **降级要可见**。13 章 §6 把「组策略禁 AppContainer」列为风险，缓解办法就是自动降级 + 提示；
 *     静默降级等于把安全承诺悄悄作废。
 *
 * 诊断结论（本机实测，2026-11-17）：
 *   当前账户是**内置管理员**（SID 尾号 500），令牌里没有 `S-1-15-2-1`（ALL APPLICATION PACKAGES），
 *   `CreateAppContainerProfile` 返回 0x80070005。这不是我们的 bug —— Windows 的内置管理员
 *   本来就不能使用 AppContainer/打包应用。降级到 jobonly。
 *
 * jobonly 能挡住什么、挡不住什么（都实测过，见 13 章 §5 备注）：
 *   ✅ 进程数上限（用例 7）、内存上限（用例 8）、父进程死则子进程一起死
 *   ❌ 断网、文件 ACL 隔离 —— 这两项只有 AppContainer 能给
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type SandboxMode = "appcontainer" | "jobonly" | "off";

export interface SandboxVerdict {
  /** 真正生效的档位。**只有 launchVerified=true 才可能是 appcontainer**，否则一律 jobonly/off */
  mode: SandboxMode;
  /** profile 与 SID 能拿到（≠ 能隔离！） */
  provisioned: boolean;
  /** 容器内启动进程验证过没有。没验证过就不许宣称隔离 */
  launchVerified: boolean;
  /** 人话原因（写进日志与设置页） */
  reason: string;
  /** helper 路径与可用性 */
  helperPath: string | null;
  /** 探针是否真的跑成功（没跑成功 ≠ 不支持，要说清） */
  probed: boolean;
  /** jobonly 能挡什么、挡不住什么 —— 界面上要照这个说 */
  limits: { processes: number; memoryMb: number; noNetwork: boolean; fileIsolation: boolean };
}

const OFF: SandboxVerdict = {
  mode: "off",
  provisioned: false,
  launchVerified: false,
  reason: "没有原生沙箱 helper（未构建或平台不支持）——当前是工具层边界 + 人审 + 事后审计",
  helperPath: null,
  probed: false,
  limits: { processes: 0, memoryMb: 0, noNetwork: false, fileIsolation: false },
};

/** helper 的几个候选位置：dist（打包后）/ 源码树（开发） */
function candidatePaths(appRoot?: string): string[] {
  const out: string[] = [];
  if (appRoot) out.push(path.join(appRoot, "sandbox-exec.exe"));
  // __dirname 在 dist/main 下；helper 与它同级放在 dist/
  out.push(path.join(__dirname, "..", "sandbox-exec.exe"));
  out.push(path.join(process.cwd(), "dist", "sandbox-exec.exe"));
  out.push(path.join(process.cwd(), "native", "sandbox-exec", "target", "release", "sandbox-exec.exe"));
  return [...new Set(out)];
}

/**
 * 跑一次能力探针。纯本地、同步（一次 ~10ms，可在启动时调一次并缓存）。
 *
 * 探针本身失败（文件不在 / 执行报错）时返回 mode=off 且 probed=false——
 * 「不知道」和「不支持」是两件事，混在一起会让人误判要不要去查。
 */
export function probeSandbox(opts: { appRoot?: string; timeoutMs?: number } = {}): SandboxVerdict {
  if (process.platform !== "win32") {
    return { ...OFF, reason: "非 Windows 平台：本项目的沙箱方案基于 AppContainer / Job Object，这里不适用" };
  }
  const found = candidatePaths(opts.appRoot).find((p) => fs.existsSync(p));
  if (!found) return OFF;

  const run = spawnSync(found, ["--probe"], { encoding: "utf8", timeout: opts.timeoutMs ?? 5000 });
  const stdout = String(run.stdout ?? "").trim();
  if (run.status !== 0 || !stdout.startsWith("{")) {
    return {
      mode: "off",
      provisioned: false,
      launchVerified: false,
      reason: `沙箱探针没能给出结论（${(run.stderr || "").trim().slice(0, 120) || `exit=${run.status}`}）——按 off 处理，不假装已隔离`,
      helperPath: found,
      probed: false,
      limits: { processes: 0, memoryMb: 0, noNetwork: false, fileIsolation: false },
    };
  }
  let parsed: { provisioned?: boolean; launchVerified?: boolean; reason?: string; mode?: string } = {};
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { ...OFF, helperPath: found, probed: false, reason: "探针输出不是 JSON" };
  }
  /**
   * 档位判定的唯一依据：**launchVerified**。
   *
   * 探针报 `mode` 只是它的建议；这里再夹一道，是因为"能建 profile"和"能隔离进程"
   * 是两回事——只有真正在容器里跑通过进程，才允许对外说 appcontainer。
   * 宁可保守地标 jobonly，也不要让界面显示"已隔离"而实际全通。
   */
  const launchVerified = parsed.launchVerified === true;
  const mode: SandboxMode = launchVerified ? "appcontainer" : "jobonly";
  return {
    mode,
    provisioned: parsed.provisioned === true,
    launchVerified,
    reason: String(parsed.reason ?? ""),
    helperPath: found,
    probed: true,
    limits: {
      processes: 64,
      memoryMb: 2048,
      // 断网与文件隔离只有 AppContainer 能给；jobonly 下如实说"没有"
      noNetwork: launchVerified,
      fileIsolation: launchVerified,
    },
  };
}

/** 探针结果缓存：一次进程生命周期内不变（AppContainer 能力不会中途变） */
let cached: SandboxVerdict | null = null;
export function sandboxVerdict(appRoot?: string): SandboxVerdict {
  if (!cached) cached = probeSandbox({ appRoot });
  return cached;
}
/** 测试用：清掉缓存 */
export function resetSandboxProbe(): void {
  cached = null;
}

/**
 * 在沙箱里跑一条命令，返回 { code, stdout, stderr }。
 *
 * `mode=off` 时**不**假装：直接告诉调用方没沙箱可用，让它走原来的执行路径。
 * 这一条很关键——沙箱缺席时静默地"照跑"，等于把安全承诺悄悄作废。
 */
export function runInSandbox(
  command: string,
  opts: {
    appRoot?: string;
    memoryMb?: number;
    processes?: number;
    timeoutMs?: number;
    cwd?: string;
    /** 子进程环境（调用方传剔除密钥 + 补 toolDirs 后的 env）；不传则继承当前进程 */
    env?: Record<string, string>;
  } = {},
): { ok: boolean; code: number | null; stdout: string; stderr: string; reason?: string } {
  const v = sandboxVerdict(opts.appRoot);
  if (v.mode === "off" || !v.helperPath) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: v.reason };
  }
  const args = [
    "--shell",
    "--memory-mb",
    String(opts.memoryMb ?? v.limits.memoryMb),
    "--processes",
    String(opts.processes ?? v.limits.processes),
    "--",
    command,
  ];
  const res = spawnSync(v.helperPath, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 12 * 1024 * 1024,
    /**
     * helper 自己就是 `CreateProcessW(..., cwd=null, ...)`，子进程继承 helper 的 cwd——
     * 所以把 helper 的 cwd 设成成员工作区，子进程就在正确目录里跑。
     */
    cwd: opts.cwd,
    // 用调用方传的（已剔除密钥的）env；没传则继承当前进程（旧行为）
    ...(opts.env ? { env: opts.env } : {}),
    windowsHide: true,
  });
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    ...(res.error ? { reason: String(res.error).slice(0, 200) } : {}),
  };
}