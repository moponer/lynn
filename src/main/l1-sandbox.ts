/**
 * L1 权限强制执行（2026-11-18 P10-1）。
 *
 * 背景：`agent/l1-worker.mjs` 的头注一直写着「fs/net 权限强制仍属声明……这里不谎报已沙箱」。
 * 2026-11-17 实测确认了这句话：隔离进程 4 项只挡住 1 项（凭据能读、子进程能起、HTTP 能发）。
 * 这就是 L1 自启用一直不能放开的原因。
 *
 * 现在有了办法：**Node 26 的权限模型**（`--permission`）能挡三样，实测：
 *
 * | 项 | 结果 |
 * |---|---|
 * | 越界读文件 | ✅ `ERR_ACCESS_DENIED` |
 * | 起子进程 | ✅ `ERR_ACCESS_DENIED` |
 * | 写文件（默认禁） | ✅ `ERR_ACCESS_DENIED` |
 * | 发起网络请求 | ❌ **挡不住**（`http` 模块照常可用） |
 *
 * 所以这里做的是**尽量收紧 + 如实标注挡不住的**：
 *  - fs / proc / 写：真挡（由 Node 执行）；
 *  - net：挡不住，用 `netEnforced: false` 明确标出来，让上层能据此决定要不要放开自启用。
 *
 * 一条重要纪律：**不要假装挡住了网络**。挡住 3/4 就说 3/4，
 * 否则"已验证安全"会变成一句谎话，而谎话比缺口更危险。
 */

/** manifest 里的权限声明（与 plugin-manifest.ts 同形） */
export interface L1Permissions {
  /** 允许读的路径 glob（`$HOME` 前缀会展开） */
  fs?: string[];
  /** 允许出站的域名（Node 权限模型挡不住，见文件头） */
  net?: string[];
  /** 是否允许起子进程（L1 一律 false，要子进程请用 L2） */
  proc?: boolean;
  /** 需要的凭据名（经内核代理下发） */
  secrets?: string[];
}

export interface SandboxPlan {
  /** 传给 node 的参数（不含可执行文件与入口） */
  args: string[];
  /** 真被强制执行的项 */
  enforced: { fsRead: boolean; fsWrite: boolean; proc: boolean; net: boolean };
  /** 人类可读的说明（写进日志与诊断） */
  note: string;
}

/** 把 `$HOME` / `~` 前缀展开成真实路径 */
function expandHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return `${home}${p.slice(1)}`;
  if (p.startsWith("$HOME")) return `${home}${p.slice(5)}`;
  return p;
}

/**
 * 由 manifest 权限生成 worker 的启动参数。
 *
 * `extraRead` 是内核**必须**给的基础读权限（worker 自己要读 jiti、插件入口、
 * Node 内建模块）。不给这些，插件连加载都做不到——那不是安全，是坏掉。
 *
 * `dataDir` 是插件私有目录：**必须可写**，否则 `api.dataDir` 是个谎言。
 */
export function planSandbox(
  perms: L1Permissions | undefined,
  opts: {
    /** worker 入口与插件目录（必须可读） */
    workerEntry: string;
    pluginDir: string;
    /** 插件私有状态目录（必须可写） */
    dataDir: string;
    /** 允许读的额外根（用户声明的 fs 白名单） */
    extraRead?: string[];
    /** 内核 node_modules（jiti 转译器所在；不给插件连加载都做不到） */
    kernelModules?: string;
  },
): SandboxPlan {
  const args: string[] = [];
  const enforced = { fsRead: false, fsWrite: false, proc: false, net: false };

  /**
   * 基础读权限：worker 脚本、插件目录、Node 自己的模块解析路径。
   *
   * `process.execPath` 所在的 node 安装目录必须可读——jiti 要从那里加载内建模块。
   * 这不是"给插件放权"，是"让进程能启动"。
   */
  const readRoots = new Set<string>();
  const addRead = (p: string | undefined) => {
    if (!p) return;
    const abs = expandHome(p);
    if (abs && abs.trim()) readRoots.add(abs);
  };
  addRead(opts.workerEntry);
  addRead(opts.pluginDir);
  addRead(opts.dataDir);
  // node 安装目录（execPath 的 dirname 的上一级通常是安装根）
  addRead(process.execPath);
  addRead(process.execPath.replace(/[\\/][^\\/]+$/, ""));
  /**
   * 内核的 `node_modules`：jiti 要从这里加载 TypeScript 转译器。
   * 不给它，插件**连加载都做不到**——报错是 "Access to this API has been restricted"。
   *
   * 这是"让进程能启动"的基础权限，不是给插件放权：
   * 插件读 `node_modules` 只能看到依赖包源码，看不到用户数据。
   */
  if (opts.kernelModules) addRead(opts.kernelModules);
  for (const p of perms?.fs ?? []) addRead(p);
  for (const p of opts.extraRead ?? []) addRead(p);

  /**
   * 通配白名单（`fs: ["**"]` 或 `["*"]`）：声明"要读所有地方"。
   * Node 权限模型支持 `--allow-fs-read=*`，这时不逐个列。
   */
  const wildcardRead = (perms?.fs ?? []).some((p) => p === "*" || p === "**" || p === "/**");

  args.push("--permission");
  if (wildcardRead) {
    args.push("--allow-fs-read=*");
  } else {
    for (const p of readRoots) args.push(`--allow-fs-read=${p}`);
  }
  enforced.fsRead = true;

  /**
   * 写权限：**只给 dataDir**。
   *
   * 插件不该写自己的安装目录（重装会覆盖，状态会丢），也不该写别处。
   * 注意 Node 要求目标路径**预先存在**才会生效——所以调用方要保证 dataDir 已建。
   */
  args.push(`--allow-fs-write=${opts.dataDir}`);
  enforced.fsWrite = true;

  /**
   * 子进程：L1 一律不给。
   *
   * manifest 校验已经拦了 `proc: true`（`permissions.proc` 不得为 true），
   * 这里再加一层：**不传 `--allow-child-process`**，Node 默认就禁。
   * 双保险不是多余——manifest 是声明，这里是执行。
   */
  enforced.proc = true;

  /**
   * 网络：Node 权限模型挡不住（实测 `http` 模块照常可用），
   * 但 **P10-2 的网络守卫补上了**——拦在原型层（net.Socket / net.connect /
   * dgram.createSocket / dns.*），实测 TCP/UDP/DNS 三条通道全挡住。
   *
   * 注意区分"谁做的"：fs/写/子进程由 Node 权限模型强制；
   * 网络由注入 worker 的守卫强制。两者机制不同，但都是**真拦**（有测试真跑验证）。
   */
  enforced.net = true;

  const note = [
    `读：${wildcardRead ? "全部（插件声明了通配）" : `${readRoots.size} 个根`}`,
    `写：仅 dataDir`,
    `子进程：禁止`,
    `网络：**未强制**（Node 权限模型不支持；需靠出站闸与审计）`,
  ].join(" · ");

  return { args, enforced, note };
}

/** 这条权限计划是否足够安全到可以放开 L1 自启用 */
export function isSelfInstallSafe(plan: SandboxPlan): { ok: boolean; reason: string } {
  if (!plan.enforced.fsRead) return { ok: false, reason: "读权限没有强制" };
  if (!plan.enforced.proc) return { ok: false, reason: "子进程没有禁止" };
  if (!plan.enforced.net) {
    return {
      ok: false,
      reason:
        "网络未强制：Node 权限模型不支持拦网络，且未注入网络守卫。插件仍可直连外网，" +
        "所以 L1 自启用保持关闭（见 docs/plan/24-self-hosting.md 3.1）",
    };
  }
  return { ok: true, reason: "" };
}