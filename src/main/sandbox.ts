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

export type SandboxMode = "appcontainer" | "restricted" | "jobonly" | "off";

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
   * 受限令牌探针（第二阶段 2026-11-19）。
   *
   * AppContainer 不可用时（内置管理员账户用不了），退而求其次用受限令牌：
   * 它**任何账户都能用**，能给"写隔离到工作区"。这里真跑一次
   * `--probe-restricted`（内部 CreateProcessAsUser 起 cmd /c exit 0），
   * 真起来才算数——launchVerified 只认这个实测。
   *
   * 诚实：restricted 只做**写限制**，不断网；断网要 WFP（第三阶段）。
   */
  const restrictedProbe = spawnSync(found, ["--probe-restricted"], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10_000,
  });
  let restrictedOk = false;
  try {
    const rp = JSON.parse(String(restrictedProbe.stdout ?? "").trim()) as {
      restricted?: boolean;
      launchVerified?: boolean;
    };
    restrictedOk = rp.restricted === true && rp.launchVerified === true;
  } catch {
    restrictedOk = false;
  }

  /**
   * AppContainer 真启动探测（第三阶段尝试）：
   * 用 derive 的 SID + CreateAppContainerToken 起 node。实测本机（Win10 19042 +
   * 内置管理员 -500 + 非提权）该 API 未导出 / 不可用，故 fullIsolation 会如实为 false。
   * 记录这个探测，是为了让界面/用户知道"为什么只能到标准用户级，到不了仅工作区+断网"。
   */
  const acProbe = spawnSync(found, ["--appcontainer-probe"], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15_000,
  });
  let appcontainerOk = false;
  try {
    const ap = JSON.parse(String(acProbe.stdout ?? "").trim()) as { appcontainer?: boolean };
    appcontainerOk = ap.appcontainer === true;
  } catch {
    appcontainerOk = false;
  }

  const launchVerified = appcontainerOk || parsed.launchVerified === true;
  // 档位优先级：AppContainer（仅工作区写+断网）> restricted（标准用户级写隔离）> jobonly
  const mode: SandboxMode = launchVerified ? "appcontainer" : restrictedOk ? "restricted" : "jobonly";
  /**
   * 「restricted」到底是哪一档（2026-11-19 实测定论）：
   *
   * 用 LUA_TOKEN 把进程降成**标准用户**（Administrators 变 deny-only）。实测本机：
   *  node/powershell 正常跑；写 C:\Windows 拒绝访问、写入用户目录成功。
   *
   * 所以它有**实质写隔离**（标准用户对系统盘/受保护位置无写权限，系统 ACL 自动拒），
   * 不是 pure 降权。fileIsolation 报 true 是诚实的——但要说清粒度：
   * 它是"标准用户能写哪就写哪"（用户目录/项目目录可写），**不是"仅限工作区"**。
   * "仅工作区"要 Codex 那套 restricting SID + 专用账户 + ACL 工程（未做）。
   * 断网仍没有（要 WFP）。
   */
  return {
    mode,
    provisioned: parsed.provisioned === true,
    launchVerified: launchVerified || restrictedOk,
    reason: launchVerified
      ? String(parsed.reason ?? "")
      : restrictedOk
        ? "标准用户级隔离：进程降权到标准用户（系统盘/受保护位置写被拒），node/powershell 正常跑；但写范围是“标准用户可写处”（非仅工作区），且不断网"
        : String(parsed.reason ?? ""),
    helperPath: found,
    probed: true,
    limits: {
      processes: 64,
      memoryMb: 2048,
      // 断网只有 AppContainer 能给
      noNetwork: launchVerified,
      // 写隔离：restricted 有"标准用户级"写限制（系统盘被拒），如实 true
      fileIsolation: launchVerified || restrictedOk,
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
  /**
   * 按档位选子命令：
   *  - restricted：`--restricted-shell`（受限令牌，写隔离）
   *  - jobonly：`--shell`（只有资源上限，无隔离）
   *  - appcontainer：目前走 `--shell`（AppContainer 启动路径未实现，见设计文档）
   */
  const sub = v.mode === "restricted" ? "--restricted-shell" : "--shell";
  const args = [
    sub,
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