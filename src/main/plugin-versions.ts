/**
 * 插件版本化与可回滚更新（2026-11-18 P12-1）。
 *
 * 补的是最后一个缺口：`update_plugin` 未做——改已装插件只能卸载+重装，
 * 而卸载会把文件移进 `plugins-trash`，重装要重新走导入。
 *
 * ## 为什么不能"直接覆盖"
 *
 * 覆盖会丢掉两样东西：
 *  1. **回滚能力**——新版坏了，旧版已经没了；
 *  2. **审计线索**——出问题时说不清"从哪一版换到哪一版"。
 *
 * 所以更新 = **先归档旧版，再落新版**。任何一步失败都能退回。
 *
 * ## 存放位置
 *
 * ```
 * <dataRoot>/plugins/<id>/              当前版本（生效中的）
 * <dataRoot>/plugins/.versions/<id>/<时间戳>-<版本>/   历史版本（归档）
 * ```
 *
 * 为什么放 `.versions`（点前缀）而不是 `plugins/<id>/_versions`：
 * `PluginHost.scan()` 与 `scanPluginCommands` / `scanPluginMcp` 都跳过点前缀目录，
 * 历史版本不会被误当成"另一个插件"扫进来。这一点必须验证，否则会出现
 * "归档了旧版，结果它又出现在插件列表里"。
 *
 * ## 与 `plugins-trash` 的区别
 *
 * | 目录 | 语义 | 谁用 |
 * |---|---|---|
 * | `.versions/<id>/...` | **同 id 的历史版本**，可一键回退 | 更新 |
 * | `plugins-trash/` | **整个插件被卸载**，人工恢复 | 卸载 |
 *
 * 两者不合并：卸载是"我不要它了"，更新是"我要新版本但留着旧的"。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { insideBase } from "./path-guard";

/** 保留多少个历史版本（超过就删最旧的） */
export const KEEP_VERSIONS = 5;

export interface VersionEntry {
  /** 归档目录名（时间戳-版本） */
  dir: string;
  /** 完整路径 */
  path: string;
  /** 归档时的版本号（来自当时的 plugin.json） */
  version: string;
  /** 归档时间 */
  at: string;
  /** 占用字节数 */
  bytes: number;
}

export interface UpdateResult {
  ok: boolean;
  /** 更新后的版本 */
  version?: string;
  /** 被归档的旧版本目录名 */
  archived?: string;
  issues: { stage: string; message: string }[];
}

const VERSIONS_DIR = ".versions";

/** 历史版本根目录 */
export function versionsRoot(dataRoot: string): string {
  return path.join(dataRoot, "plugins", VERSIONS_DIR);
}

/** 某个插件的历史版本目录 */
export function versionsDirOf(dataRoot: string, pluginId: string): string {
  return path.join(versionsRoot(dataRoot), pluginId);
}

/** 目录体积（递归） */
function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return total;
}

/** 读某目录里 plugin.json 的版本号（读不到就空串） */
function versionOf(dir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "";
  } catch {
    return "";
  }
}

/**
 * 列出某插件的历史版本，**新的在前**。
 *
 * 排序依据是目录名（时间戳前缀），不是 mtime——mtime 会被复制/同步工具改掉，
 * 而目录名是我们自己生成的，可靠。
 */
export function listVersions(dataRoot: string, pluginId: string): VersionEntry[] {
  const dir = versionsDirOf(dataRoot, pluginId);
  if (!fs.existsSync(dir)) return [];
  const out: VersionEntry[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    // 目录名形如 `1758000000000-1.0.0`
    const m = /^(\d+)-(.*)$/.exec(e.name);
    const at = m ? new Date(Number(m[1])).toISOString() : "";
    out.push({
      dir: e.name,
      path: full,
      version: m?.[2] || versionOf(full),
      at,
      bytes: dirSize(full),
    });
  }
  return out.sort((a, b) => (a.dir < b.dir ? 1 : -1));
}

/** 归档当前版本到 `.versions/<id>/<时间戳>-<版本>/`，返回归档目录名 */
export function archiveVersion(dataRoot: string, pluginId: string, liveDir: string): string {
  const version = versionOf(liveDir) || "unknown";
  const stamp = `${Date.now()}-${version.replace(/[^0-9A-Za-z.-]/g, "_")}`;
  const dest = path.join(versionsDirOf(dataRoot, pluginId), stamp);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(liveDir, dest, { recursive: true });
  pruneVersions(dataRoot, pluginId);
  return stamp;
}

/** 只保留最近 KEEP_VERSIONS 个版本 */
export function pruneVersions(dataRoot: string, pluginId: string): string[] {
  const removed: string[] = [];
  const all = listVersions(dataRoot, pluginId);
  for (const old of all.slice(KEEP_VERSIONS)) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true });
      removed.push(old.dir);
    } catch {
      /* 删不掉就留着，不影响主流程 */
    }
  }
  return removed;
}

/**
 * 回滚到某个历史版本。
 *
 * 语义是"换回来"，不是"撤销更新"：
 *  1. 把当前版本也归档（这样回滚本身也能回滚，不会变成单行道）；
 *  2. 用历史版本覆盖当前目录；
 *  3. 返回新（旧）版本号。
 */
export function rollbackToVersion(
  dataRoot: string,
  pluginId: string,
  versionDir: string,
): UpdateResult {
  const pluginsRoot = path.join(dataRoot, "plugins");
  const live = path.join(pluginsRoot, pluginId);
  if (!insideBase(pluginsRoot, live)) {
    return { ok: false, issues: [{ stage: "path", message: `插件落点越界：${pluginId}` }] };
  }
  const src = path.join(versionsDirOf(dataRoot, pluginId), versionDir);
  if (!insideBase(versionsDirOf(dataRoot, pluginId), src) || !fs.existsSync(src)) {
    return { ok: false, issues: [{ stage: "missing", message: `没有这个历史版本：${versionDir}` }] };
  }

  // 当前版本先归档：回滚也要能回滚，否则用户点错了就回不去
  let archived: string | undefined;
  if (fs.existsSync(live)) {
    try {
      archived = archiveVersion(dataRoot, pluginId, live);
    } catch (e) {
      return {
        ok: false,
        issues: [{ stage: "archive", message: `归档当前版本失败，未做回滚：${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  }

  const staging = path.join(pluginsRoot, `_rollback-${pluginId}-${Date.now()}`);
  try {
    fs.cpSync(src, staging, { recursive: true });
    if (fs.existsSync(live)) fs.rmSync(live, { recursive: true, force: true });
    fs.renameSync(staging, live);
    return { ok: true, version: versionOf(live), ...(archived ? { archived } : {}), issues: [] };
  } catch (e) {
    // 失败就把暂存清掉，别在 plugins/ 里留半成品
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, issues: [{ stage: "io", message: e instanceof Error ? e.message : String(e) }] };
  }
}

/**
 * 用新包替换已装插件（`update_plugin` 的核心）。
 *
 * 与导入的区别：导入遇到同名直接拒；更新**先归档再替换**。
 *
 * 原子性靠"暂存 + rename"：先把新包拷到 `plugins/_updating-<id>-<ts>`，
 * 归档旧版成功后才删旧版、rename 新版。任一步失败，旧版还在原位。
 */
export function updatePluginFromDir(
  dataRoot: string,
  pluginId: string,
  newPkgDir: string,
): UpdateResult {
  const pluginsRoot = path.join(dataRoot, "plugins");
  const live = path.join(pluginsRoot, pluginId);
  if (!insideBase(pluginsRoot, live)) {
    return { ok: false, issues: [{ stage: "path", message: `插件落点越界：${pluginId}` }] };
  }
  if (!fs.existsSync(live)) {
    return { ok: false, issues: [{ stage: "missing", message: `插件 ${pluginId} 还没装过，请用导入而不是更新` }] };
  }

  // 1) 先归档旧版（失败就整个中止——没有回滚能力的更新不如不做）
  let archived: string;
  try {
    archived = archiveVersion(dataRoot, pluginId, live);
  } catch (e) {
    return {
      ok: false,
      issues: [{ stage: "archive", message: `归档旧版本失败，已中止：${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  // 2) 新包拷到暂存（同盘 rename 是原子的）
  const staging = path.join(pluginsRoot, `_updating-${pluginId}-${Date.now()}`);
  try {
    fs.cpSync(newPkgDir, staging, { recursive: true });
  } catch (e) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      issues: [{ stage: "stage", message: `拷贝新版本失败，旧版未动：${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  // 3) 换上去
  try {
    fs.rmSync(live, { recursive: true, force: true });
    fs.renameSync(staging, live);
    return { ok: true, version: versionOf(live), archived, issues: [] };
  } catch (e) {
    // 换失败：尽力把旧版放回去（从刚归档的那份）
    try {
      const restore = path.join(versionsDirOf(dataRoot, pluginId), archived);
      if (fs.existsSync(restore) && !fs.existsSync(live)) {
        fs.cpSync(restore, live, { recursive: true });
      }
    } catch {
      /* 恢复也失败就如实报，别假装成功 */
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      issues: [
        {
          stage: "swap",
          message: `替换失败，已尝试恢复旧版：${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
}