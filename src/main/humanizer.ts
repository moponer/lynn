/**
 * 去 AI 味（humanizer-stream）宿主桥 —— 一个**可选的外部插件**，不内置规则。
 *
 * 为什么放在这里而不是内联进 kernel：
 *  规则会长、会改、会有人想单独发一个包。内核只该知道「有个文本过滤器」，
 *  不该知道「首先/其次要删掉」。所以这里只做三件事：找到插件、加载它、调它。
 *
 * 关键约束（决定了它为什么不影响 token / 缓存）：
 *  1. 只在**展示边界**调用。写进 history 与落盘的永远是模型原文。
 *  2. 不发起任何模型请求，也不碰请求体（提示词一个字不改）。
 *  3. 插件缺失 / 版本不匹配 / 抛错 → 一律透传原文，绝不让用户看不到模型的话。
 *
 * 插件来源（按顺序探测，命中即用）：
 *  - 环境变量 LYNN_HUMANIZER_DIR
 *  - ~/.lynn/plugins/humanizer-stream      （`deslop install-lynn` 装到这里）
 *  - 与 lynn 仓库并排的 humanizer-stream 检出（开发期）
 */

import fs from "node:fs";
import path from "node:path";

export interface HumanizerProfile {
  profile?: "prose" | "chat" | "mild" | "code" | "all";
  mode?: "text" | "code";
  lang?: "zh" | "en" | "auto";
  emoji?: "strip" | "keep";
}

interface Filter {
  text(input: string, extra?: HumanizerProfile): string;
}

interface PluginModule {
  api?: number;
  profileForFile?: (file: string) => { profile: string; mode: string };
  createFilter?: (opts?: HumanizerProfile) => Filter;
  createTextFilter?: (opts?: HumanizerProfile) => Filter;
  default?: { createFilter?: (opts?: HumanizerProfile) => Filter };
}

export interface HumanizerHandle {
  dir: string;
  version: string;
  module: PluginModule;
  filter: (opts?: HumanizerProfile) => Filter | null;
}

let handle: HumanizerHandle | null = null;
let loading: Promise<HumanizerHandle | null> | null = null;
let enabled = true;
/** 每次调用都新建 filter 太碎，按 profile 缓存一个 */
const filterCache = new Map<string, Filter>();

function probe(): string[] {
  const out: string[] = [];
  const env = process.env.LYNN_HUMANIZER_DIR;
  if (env) return [env]; // 显式指定时只认它，开发和测试都靠这个
  if (process.env.LYNN_DATA_ROOT) out.push(path.join(process.env.LYNN_DATA_ROOT, "plugins", "humanizer-stream"));
  /**
   * 测试环境**不**探测兄弟目录：否则「这台机器上恰好 clone 了一个插件」
   * 会让 lynn 的整套测试输出被改写，测出来的东西和发布版不是一回事。
   */
  if (process.env.NODE_TEST_CONTEXT) return out;
  // __dirname = <repo>/dist/main 或 <app>/dist/main
  out.push(path.join(__dirname, "..", "..", "..", "humanizer-stream"));
  out.push(path.join(__dirname, "..", "..", "..", "..", "humanizer-stream"));
  return out;
}

function entryOf(dir: string): string | null {
  for (const rel of ["index.js", "src/index.js", "dist/index.js"]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 加载插件（幂等；失败也不重试，避免每次启动都撞同一个错） */
export function loadHumanizer(dataRoot?: string): Promise<HumanizerHandle | null> {
  if (loading) return loading;
  loading = (async () => {
    const dirs = dataRoot ? [path.join(dataRoot, "plugins", "humanizer-stream"), ...probe()] : probe();
    for (const dir of dirs) {
      const entry = entryOf(dir);
      if (!entry) continue;
      try {
        // 主进程编译成 CommonJS，动态 import 会被降级成 require：
        // 它只认文件路径，不认 file:// URL。两条都试一遍，谁成就用谁。
        let mod: PluginModule;
        try {
          mod = (await import(pathToUrl(entry))) as PluginModule;
        } catch {
          mod = (await import(entry)) as PluginModule;
        }
        const make = mod.createFilter ?? mod.createTextFilter ?? mod.default?.createFilter;
        if (typeof make !== "function") continue;
        // 契约版本必须对得上：宁可不加载，也不猜着跑
        if (typeof mod.api === "number" && mod.api !== 1) continue;
        const version = readVersion(dir);
        handle = {
          dir,
          version,
          module: mod,
          filter: (opts) => {
            const key = JSON.stringify(opts ?? {});
            const hit = filterCache.get(key);
            if (hit) return hit;
            try {
              const f = make(opts);
              if (f && typeof f.text === "function") {
                filterCache.set(key, f);
                return f;
              }
            } catch {
              // 插件内部炸了：当作没有
            }
            return null;
          },
        };
        return handle;
      } catch (err) {
        console.warn(`[humanizer] 加载失败 ${entry}: ${(err as Error)?.message ?? err}`);
      }
    }
    return null;
  })();
  return loading;
}

function pathToUrl(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
}

function readVersion(dir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function setHumanizerEnabled(on: boolean): void {
  enabled = on;
}

export function humanizerStatus(): {
  enabled: boolean;
  loaded: boolean;
  dir: string | null;
  version: string | null;
} {
  return { enabled, loaded: Boolean(handle), dir: handle?.dir ?? null, version: handle?.version ?? null };
}

/**
 * 展示层过滤。任何异常都返回原文——这条路径在用户等回复的关键路径上，
 * 宁可留着 AI 味，也不能让回复消失。
 */
export function humanizeDisplay(text: string, profile: HumanizerProfile["profile"] = "chat"): string {
  if (!enabled || !handle || !text || !text.trim()) return text;
  const f = handle.filter({ profile });
  if (!f) return text;
  try {
    const out = f.text(text);
    return out && out.trim() ? out : text;
  } catch {
    return text;
  }
}

/**
 * 写盘前过滤（成员产出的文档/文案/代码注释）。
 * 源码走 code 档：只碰注释；其它文本走 prose。认不出类型就原样返回。
 */
export function humanizeFileText(file: string, text: string): string {
  if (!enabled || !handle || !text || !text.trim()) return text;
  let profile: HumanizerProfile["profile"] = "prose";
  let mode: HumanizerProfile["mode"] = "text";
  try {
    const guess = handle.module.profileForFile?.(file);
    if (guess?.profile) {
      profile = guess.profile as HumanizerProfile["profile"];
      mode = (guess.mode as HumanizerProfile["mode"]) ?? "text";
    } else if (/\.(js|mjs|cjs|ts|tsx|jsx|rs|go|java|kt|py|rb|php|c|h|cpp|cs|swift|sh|ps1|sql|css|scss|vue|svelte|lua)$/i.test(file)) {
      profile = "code";
      mode = "code";
    }
  } catch {
    profile = "prose";
    mode = "text";
  }
  const f = handle.filter({ profile, mode });
  if (!f) return text;
  try {
    const out = f.text(text);
    return out && out.trim() ? out : text;
  } catch {
    return text;
  }
}
