import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 插件集指纹 / 安全模式 / 一键回滚（计划书 §4.11.4）。
 *
 * - 指纹：`id@version` + 关键文件内容 hash，启动时打到日志头，崩溃日志带同一指纹。
 * - 安全模式：10 分钟内 3 次启动（或连续 2 次加载同一插件即崩）→ 只跑官方核心。
 * - 回滚：每次启停/安装前自动快照插件集（当前实现为「启用状态快照」，文件级回滚待版本化）。
 */

export interface PluginSetEntry {
  id: string;
  version: string;
  tier: string;
  enabled: boolean;
  /** 关键文件内容 hash（plugin.json + entry/theme/recipe） */
  hash: string;
}

export interface PluginSetSnapshot {
  at: string;
  fingerprint: string;
  entries: PluginSetEntry[];
  /** 触发快照的动作（install / toggle / startup / manual） */
  reason: string;
}

const WINDOW_MS = 10 * 60 * 1000;
const SAFE_MODE_STARTS = 3;

function hashFiles(files: { rel: string; abs: string }[]): string {
  const h = crypto.createHash("sha256");
  for (const f of files.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    h.update(f.rel);
    if (fs.existsSync(f.abs)) {
      const st = fs.statSync(f.abs);
      if (st.size <= 2 * 1024 * 1024) h.update(fs.readFileSync(f.abs));
      else h.update(`size:${st.size}`);
    }
  }
  return h.digest("hex");
}

export class PluginSetStore {
  constructor(readonly dataRoot: string) {}

  private get dir(): string {
    return path.join(this.dataRoot, "plugins");
  }

  private get fpDir(): string {
    return path.join(this.dir, "_snapshots");
  }

  private get stateFile(): string {
    return path.join(this.dir, "_state.json");
  }

  private get startsFile(): string {
    return path.join(this.dir, "_starts.json");
  }

  private get safeFile(): string {
    return path.join(this.dir, "_safe-mode.json");
  }

  private readState(): Record<string, boolean> {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  /** 计算当前插件集指纹（只算启用的插件；禁用插件变化不影响指纹） */
  fingerprint(): { fingerprint: string; entries: PluginSetEntry[] } {
    const entries: PluginSetEntry[] = [];
    if (!fs.existsSync(this.dir)) return { fingerprint: "empty", entries };
    const state = this.readState();

    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_")) continue;
      const d = path.join(this.dir, e.name);
      const mf = path.join(d, "plugin.json");
      if (!fs.existsSync(mf)) continue;
      let m: { id?: string; version?: string; tier?: string; entry?: string; contributes?: { theme?: string }; mcp?: { recipe?: string } };
      try {
        m = JSON.parse(fs.readFileSync(mf, "utf-8"));
      } catch {
        continue;
      }
      const id = String(m.id ?? e.name);
      const enabled = state[id] ?? true;
      if (!enabled) continue;
      const files = [{ rel: "plugin.json", abs: mf }];
      for (const [rel, label] of [
        [m.entry, "entry"],
        [m.contributes?.theme, "theme"],
        [m.mcp?.recipe, "recipe"],
      ] as [string | undefined, string][]) {
        if (!rel) continue;
        files.push({ rel: `${label}:${rel}`, abs: path.resolve(d, rel) });
      }
      entries.push({
        id,
        version: String(m.version ?? "0.0.0"),
        tier: String(m.tier ?? "?"),
        enabled,
        hash: hashFiles(files).slice(0, 16),
      });
    }

    const joined = entries
      .map((x) => `${x.id}@${x.version}#${x.hash}`)
      .sort()
      .join("|");
    const fingerprint = crypto.createHash("sha256").update(joined).digest("hex").slice(0, 32);
    return { fingerprint, entries };
  }

  /** 打快照（装/更新/启用前调用）；返回快照文件名 */
  snapshot(reason: string): string {
    const { fingerprint, entries } = this.fingerprint();
    const snap: PluginSetSnapshot = { at: new Date().toISOString(), fingerprint, entries, reason };
    fs.mkdirSync(this.fpDir, { recursive: true });
    const name = `${Date.now()}-${reason}.json`;
    fs.writeFileSync(path.join(this.fpDir, name), JSON.stringify(snap, null, 2), "utf-8");
    return name;
  }

  listSnapshots(): { file: string; at: string; fingerprint: string; reason: string; count: number }[] {
    if (!fs.existsSync(this.fpDir)) return [];
    return fs
      .readdirSync(this.fpDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.fpDir, f), "utf-8")) as PluginSetSnapshot;
          return { file: f, at: s.at, fingerprint: s.fingerprint, reason: s.reason, count: s.entries.length };
        } catch {
          return null;
        }
      })
      .filter((x): x is { file: string; at: string; fingerprint: string; reason: string; count: number } => x !== null)
      .sort((a, b) => (a.file < b.file ? 1 : -1));
  }

  /**
   * 一键回滚：把启用状态恢复到指定快照（默认最近一次变更前）。
   * 只动 `_state.json`，**不动用户数据**；文件级版本回滚待插件版本化。
   */
  rollback(file?: string): { ok: boolean; detail: string } {
    const snaps = this.listSnapshots();
    const target = file ? snaps.find((s) => s.file === file) : snaps[0];
    if (!target) return { ok: false, detail: "没有可用快照" };
    const raw = JSON.parse(fs.readFileSync(path.join(this.fpDir, target.file), "utf-8")) as PluginSetSnapshot;
    const state: Record<string, boolean> = {};
    for (const e of raw.entries) state[e.id] = e.enabled;
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf-8");
    return { ok: true, detail: `已回滚到 ${target.at}（${target.reason}，${raw.entries.length} 个插件）；用户数据未动` };
  }

  // ---------- 安全模式 ----------

  /** 每次内核启动记一次；10 分钟内第 3 次视为连续崩溃 */
  noteStart(now = Date.now()): { safeMode: boolean; starts: number } {
    let starts: number[] = [];
    try {
      starts = (JSON.parse(fs.readFileSync(this.startsFile, "utf-8")) as number[]) ?? [];
    } catch {
      starts = [];
    }
    starts = starts.filter((t) => now - t < WINDOW_MS);
    starts.push(now);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.startsFile, JSON.stringify(starts), "utf-8");

    if (starts.length >= SAFE_MODE_STARTS) {
      this.setSafeMode(true, `10 分钟内启动 ${starts.length} 次`);
      return { safeMode: true, starts: starts.length };
    }
    return { safeMode: this.isSafeMode(), starts: starts.length };
  }

  isSafeMode(): boolean {
    return fs.existsSync(this.safeFile);
  }

  safeModeInfo(): { at: string; reason: string } | null {
    try {
      return JSON.parse(fs.readFileSync(this.safeFile, "utf-8")) as { at: string; reason: string };
    } catch {
      return null;
    }
  }

  setSafeMode(on: boolean, reason = ""): void {
    if (on) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.safeFile, JSON.stringify({ at: new Date().toISOString(), reason }, null, 2), "utf-8");
    } else {
      fs.rmSync(this.safeFile, { force: true });
      fs.rmSync(this.startsFile, { force: true });
    }
  }
}
