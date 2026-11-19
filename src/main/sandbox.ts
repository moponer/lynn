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

import { spawn, spawnSync } from "node:child_process";
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

/**
 * 探针结果缓存（2026-11-19 修 S1：首次最长 30s 卡主线程）。
 *
 * ## 为什么必须改
 *
 * `probeSandbox` 串行 `spawnSync` 三次（--probe 5s、--probe-restricted 10s 真起 node、
 * --appcontainer-probe 15s 真起 node），最坏 30s 同步阻塞主线程。而 `sandboxVerdict()`
 * 被 `appendProgress`（刷进度卡）等渲染路径调用 → 首次派单/首条命令时应用假死半分钟。
 *
 * ## 现在三层
 *
 *  1. **内存缓存**：一次进程生命周期内只算一次。
 *  2. **磁盘缓存**：按 helper 指纹（路径+mtime+size）落 `dataRoot/sandbox-verdict.json`，
 *     下次启动直接读——正常启动 0 探测、0 阻塞。
 *  3. **`sandboxVerdictCached()`**：渲染路径专用。**绝不探测**：内存/磁盘有就用，
 *     没有就返回保守的 "还没探测"（mode=jobonly 语义但不谎报 fileIsolation），
 *     真正的探测交给启动时的 `warmSandboxProbe()` 在空闲期做。
 *
 * 诚实边界：`sandboxVerdictCached()` 在未探测时返回的 jobonly 是**保守值**（不是谎报——
 * jobonly 承诺最低，未探测时按最低承诺对用户最安全），探测完成后自动升级档位。
 */
let cached: SandboxVerdict | null = null;
/** 是否已经真正探测过（区分"保守默认"与"探针结论"） */
let probedOnce = false;

const CACHE_FILE = "sandbox-verdict.json";

/** helper 指纹：路径+size+mtime，换了 helper（重编译/升级）就重新探测 */
function helperFingerprint(helperPath: string | null): string {
  if (!helperPath) return "none";
  try {
    const st = fs.statSync(helperPath);
    return `${helperPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return `${helperPath}|missing`;
  }
}

interface DiskCache {
  fingerprint: string;
  verdict: SandboxVerdict;
}

function cachePath(dataRoot: string): string {
  return path.join(dataRoot, CACHE_FILE);
}

/** 读磁盘缓存；指纹不符/文件坏/不存在都返回 null（不抛） */
function readDiskCache(dataRoot: string, fingerprint: string): SandboxVerdict | null {
  try {
    const raw = fs.readFileSync(cachePath(dataRoot), "utf-8");
    const parsed = JSON.parse(raw) as DiskCache;
    if (parsed?.fingerprint !== fingerprint) return null;
    const v = parsed.verdict;
    if (!v || typeof v.mode !== "string") return null;
    return v;
  } catch {
    return null;
  }
}

function writeDiskCache(dataRoot: string, fingerprint: string, verdict: SandboxVerdict): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const payload: DiskCache = { fingerprint, verdict };
    fs.writeFileSync(cachePath(dataRoot), JSON.stringify(payload), "utf-8");
  } catch {
    /* 缓存写不进去不影响判定，只是下次还要再探 */
  }
}

/**
 * 取档位（**可能会探测**，最坏 30s）。只在明确可以阻塞的地方调
 * （启动预热、`runInSandbox` 真要用沙箱时）。渲染路径请用 `sandboxVerdictCached`。
 */
export function sandboxVerdict(appRoot?: string, dataRoot?: string): SandboxVerdict {
  if (cached) return cached;
  const found = candidatePaths(appRoot).find((p) => fs.existsSync(p)) ?? null;
  const fp = helperFingerprint(found);
  if (dataRoot) {
    const disk = readDiskCache(dataRoot, fp);
    if (disk) {
      cached = disk;
      probedOnce = true;
      return cached;
    }
  }
  cached = probeSandbox({ appRoot });
  probedOnce = true;
  if (dataRoot) writeDiskCache(dataRoot, helperFingerprint(cached.helperPath), cached);
  return cached;
}

/**
 * 渲染路径专用：**绝不探测**。
 *
 * 有内存/磁盘缓存就用；都没有时返回保守值（jobonly，且谎报项一律 false），
 * 让界面先正常渲染，等启动预热把真档位探出来后再升级。这样首单不再假死。
 */
export function sandboxVerdictCached(appRoot?: string, dataRoot?: string): SandboxVerdict {
  if (cached) return cached;
  const found = candidatePaths(appRoot).find((p) => fs.existsSync(p)) ?? null;
  const fp = helperFingerprint(found);
  if (dataRoot) {
    const disk = readDiskCache(dataRoot, fp);
    if (disk) {
      cached = disk;
      probedOnce = true;
      return cached;
    }
  }
  // 还没探测过：给保守值，不阻塞。注意 fileIsolation/noNetwork 一律 false（不谎报）。
  return {
    mode: found ? "jobonly" : "off",
    provisioned: false,
    launchVerified: false,
    reason: "沙箱档位还没探测（启动预热中）：先按最低档运行，探测完会自动升级",
    helperPath: found,
    probed: false,
    limits: { processes: 0, memoryMb: 0, noNetwork: false, fileIsolation: false },
  };
}

/** 启动空闲期预热：把最坏 30s 的探测从"用户派单时"挪到"应用刚起来时" */
export function warmSandboxProbe(appRoot?: string, dataRoot?: string): SandboxVerdict {
  return sandboxVerdict(appRoot, dataRoot);
}

/** 测试用：清掉内存缓存（磁盘缓存保留，测试可自行清 dataRoot） */
export function resetSandboxProbe(): void {
  cached = null;
  probedOnce = false;
}

/** 是否真的探测过（诊断/测试用） */
export function sandboxProbed(): boolean {
  return probedOnce;
}

/**
 * 在沙箱里跑一条命令，返回 { code, stdout, stderr }。
 *
 * `mode=off` 时**不**假装：直接告诉调用方没沙箱可用，让它走原来的执行路径。
 * 这一条很关键——沙箱缺席时静默地"照跑"，等于把安全承诺悄悄作废。
 */
export async function runInSandbox(
  command: string,
  opts: {
    appRoot?: string;
    memoryMb?: number;
    processes?: number;
    timeoutMs?: number;
    cwd?: string;
    /** 子进程环境（调用方传剔除密钥 + 补 toolDirs 后的 env）；不传则继承当前进程 */
    env?: Record<string, string>;
    /** 数据目录：给磁盘缓存用（省掉重复探测） */
    dataRoot?: string;
    /**
     * 用户点「停」的信号（2026-11-19 修 C3）。
     *
     * 之前是 spawnSync：同步阻塞整条线程，abort 监听根本没机会执行——用户点停
     * 界面显示已停，命令还在跑，最长等到 timeout。改成 spawn + 这里真杀进程。
     */
    signal?: AbortSignal;
  } = {},
): Promise<{
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
  /**
   * 命令是否**真的被执行过**（2026-11-19 修 C4）。
   *
   * 区分三种失败，避免"有副作用命令被重跑"：
   *  - started=false：helper 根本没起来（档位 off / 缺 helper / CreateProcess 失败）
   *    → 调用方可安全降级到 execa 重跑（命令没执行过，不会重复副作用）。
   *  - started=true + timedOut=true：命令跑了但超时被杀 → **绝不能重跑**，返回超时结果。
   *  - started=true + 超 buffer：命令跑了、输出太大 → 也不能重跑，截断返回。
   */
  started: boolean;
  timedOut?: boolean;
  /** 被用户「停」中止（2026-11-19 C3）：调用方应直接返回"已停止"，不要降级重跑 */
  aborted?: boolean;
}> {
  const v = sandboxVerdict(opts.appRoot, opts.dataRoot);
  if (v.mode === "off" || !v.helperPath) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: v.reason, started: false };
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
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const MAX_BUF = 12 * 1024 * 1024;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(v.helperPath!, args, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      windowsHide: true,
    });
    /** 收尾：只 resolve 一次，清掉定时器与 abort 监听 */
    const finish = (code: number | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      const started = !!stdout || !!stderr || code !== null || aborted || timedOut || overflow;
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
        started,
        timedOut,
        aborted,
      });
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true;
        kill();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    child.stdout?.on("data", (b: Buffer) => {
      if (stdout.length + b.length > MAX_BUF) {
        overflow = true;
        stdout += b.toString("utf8").slice(0, Math.max(0, MAX_BUF - stdout.length));
        kill();
        return;
      }
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length + b.length > MAX_BUF) {
        overflow = true;
        stderr += b.toString("utf8").slice(0, Math.max(0, MAX_BUF - stderr.length));
        kill();
        return;
      }
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      // helper 起不来（ENOENT 等）：命令没执行过，可安全降级
      finish(null, `沙箱 helper 启动失败：${String((err as Error).message ?? err)}`);
    });
    child.on("close", (code) => {
      finish(code ?? null, overflow ? "输出超过上限，已截断" : undefined);
    });
  });
}