// 命令执行环境（2026-11-14）：成员跑的每条命令都用这里算出来的 env，不再直接继承 process.env。
//
// 三件事，都很直接：
//   1) 剔密钥：命令能 `echo $X`、`node -e`、`python -c` 读环境，主进程里的 API key / token
//      不该顺着继承漏进任务工作区。出站闸（OUTBOUND 正则）只拦 curl/wget 这种字面量，
//      拦不住脚本自己发请求，所以这里必须按变量名先筛一遍。
//   2) 关掉交互：分页器、编辑器、凭据提示、包管理器的确认框——这些都会等一个不会来的输入，
//      表现是"命令超时 120s"，实际是卡在提示上（成员最高频的假失败）。
//   3) 编码：强制 Python stdio 与 locale 走 UTF-8，少一类中文乱码。
//
// 只做 env，不碰命令文本：不做 shell 解析，也不假装这是沙箱（OS 级隔离是另一件事）。

import * as fs from "node:fs";
import * as path from "node:path";

/** 变量名里带这些词就当成凭据剔除（命名覆盖大部分 SDK/云厂商习惯） */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|COOKIE|AUTH)(_|$)/i;

/** 关掉"等人输入"的那批开关；值覆盖用户原值（这些设错的后果都是挂住） */
const HARDEN: Readonly<Record<string, string>> = {
  PAGER: "cat",
  GIT_PAGER: "cat",
  LESS: "FRX",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
  GCM_INTERACTIVE: "never",
  EDITOR: "true",
  VISUAL: "true",
  TERM: "dumb",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  npm_config_yes: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  DEBIAN_FRONTEND: "noninteractive",
};

export interface CommandEnvOptions {
  /** 追加/覆盖（少量调用方需要已解析的变量；测试也用它） */
  extra?: Record<string, string | undefined>;
  /** CI=true 会改变部分工具行为；调用方可显式不设（对应 LYNN_BASH_NO_CI 环境变量） */
  noCi?: boolean;
  /** 只为测试可注入 */
  platform?: NodeJS.Platform;
  /**
   * 要前置进 PATH 的工具目录（见 posixToolDirs）。
   * 明确传 [] = 不前置；不传 = 也不前置（纯函数不探测磁盘，探测交给调用方，测试才好写）。
   */
  toolDirs?: string[];
}

/**
 * Windows 上补齐 POSIX 命令的目录（grep/sed/awk/find/sort/uniq 都在 Git 的 usr/bin 里）。
 *
 * 为什么用它而不是自己实现或捆绑二进制：Git for Windows 是开发者机器上现成的东西，
 * 一条 PATH 就能让成员写的 `grep -rn` 真的能跑；不下载、不打包、不引入新许可。
 * 顺序：LYNN_POSIX_TOOLS（用户自备）→ 打包自带的 resources/bin → Git for Windows。
 * 只返回真实存在的目录（PowerShell 侧 stat 一次，后面按进程缓存）。
 */
export function posixToolDirs(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  if (platform !== "win32") return out;

  const custom = env.LYNN_POSIX_TOOLS;
  if (custom) {
    for (const p of custom.split(path.delimiter)) if (p.trim() && exists(p.trim())) out.push(p.trim());
  }
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (res) {
    const bundled = path.join(res, "bin");
    if (exists(bundled)) out.push(bundled);
  }
  for (const p of [
    env.ProgramFiles ? path.join(env.ProgramFiles, "Git", "usr", "bin") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Git", "usr", "bin") : "",
    "C:\\Program Files\\Git\\usr\\bin",
  ]) {
    if (p && exists(p)) out.push(p);
  }
  return [...new Set(out)];
}

/** 进程级缓存：每条命令都 stat 四五个目录不值当（用户装/卸 Git 需要重启应用，可接受） */
let toolDirsCache: string[] | null = null;
export function posixToolDirsCached(): string[] {
  if (toolDirsCache === null) toolDirsCache = posixToolDirs();
  return toolDirsCache;
}

/** 纯函数：从宿主环境算出"给成员命令用"的环境（不读磁盘、不读全局状态） */
export function buildCommandEnv(
  base: Record<string, string | undefined>,
  opts: CommandEnvOptions = {},
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SECRET_NAME.test(k)) continue;
    // LYNN_* 是内核自己的路径/开关（数据根、Pi 目录等），成员命令不需要知道
    if (k.startsWith("LYNN_")) continue;
    out[k] = v;
  }

  Object.assign(out, HARDEN);

  // 工具目录前置进 PATH（Windows 上补 grep/sed/awk/find）。
  // 键名大小写不敏感：Windows 上宿主给的通常是 `Path`，写死 `PATH` 会多出一条死变量。
  if (opts.toolDirs && opts.toolDirs.length) {
    const sep = platform === "win32" ? ";" : ":";
    const key =
      Object.keys(out).find((k) => k.toLowerCase() === "path") ?? (platform === "win32" ? "Path" : "PATH");
    out[key] = [...opts.toolDirs, out[key] ?? ""].filter(Boolean).join(sep);
  }

  // CI 只在没人设置时补；LYNN_BASH_NO_CI 是逃生口（有些工具在 CI 下会跳过交互式确认）
  if (!opts.noCi && !base.LYNN_BASH_NO_CI && out.CI === undefined) out.CI = "1";

  // Windows 上 LANG 基本不起作用（msvcrt 走 ANSI 代码页），别塞无意义变量
  if (platform !== "win32") {
    if (!out.LANG) out.LANG = "C.UTF-8";
    if (!out.LC_ALL) out.LC_ALL = "C.UTF-8";
  }

  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return out;
}

/** 便于测试与自检：某个变量名会不会被当成凭据剔掉 */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}
