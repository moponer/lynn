/**
 * 写作规则插件（humanizer-stream v0.2）宿主桥 —— 一个**可选的外部插件**，规则不内置在本仓。
 *
 * 这一版改为「约束生成」而不是「改写产出」（2026-11-15 用户裁定 0.1 效果不佳）：
 *  插件提供一段写作约束，我们把它拼进**系统提示词**；
 *  模型按它写，输出的每个字都是模型自己的，落盘与上下文完全一致。
 *
 * 三条纪律，决定了它为什么安全：
 *  1. 只在 system prompt 里出现，且每会话只拼一次（规则文本随插件版本固定，
 *     不会因为某轮内容变化而抖动——前缀缓存不受影响）。
 *  2. 不碰模型的任何输出：历史上 0.1 在展示层改写，导致「看到的是 A、落盘的是 B」。
 *  3. 插件缺失 / 版本不匹配 / 抛错 → 注入空串，绝不影响对话。
 *
 * 插件来源（按顺序探测，命中即用）：
 *  - 环境变量 LYNN_HUMANIZER_DIR
 *  - <数据根>/plugins/humanizer-stream   （`deslop install-lynn` 装到这里）
 *  - 与 lynn 仓库并排的 humanizer-stream 检出（开发期）
 */

import fs from "node:fs";
import path from "node:path";

export type WritingProfile = "chat" | "prose" | "code" | "ui";

interface PluginModule {
  api?: number;
  writingRules?: (opts?: { profile?: WritingProfile; locale?: string; maxChars?: number }) => string;
  default?: { writingRules?: PluginModule["writingRules"] };
}

export interface HumanizerHandle {
  dir: string;
  version: string;
  module: PluginModule;
  /** 规则文本（按 profile 缓存；同参同输出，插件自身保证确定性） */
  rules: (profile: WritingProfile, maxChars?: number) => string;
}

let handle: HumanizerHandle | null = null;
let loading: Promise<HumanizerHandle | null> | null = null;
let enabled = true;
const rulesCache = new Map<string, string>();

/** 契约版本：0.2 起是 2（writingRules）。api 1 的旧输出过滤器一律不认。 */
const API_WRITING_RULES = 2;

function probe(): string[] {
  const out: string[] = [];
  const env = process.env.LYNN_HUMANIZER_DIR;
  if (env) return [env]; // 显式指定时只认它，开发和测试都靠这个
  if (process.env.LYNN_DATA_ROOT) out.push(path.join(process.env.LYNN_DATA_ROOT, "plugins", "humanizer-stream"));
  /**
   * 测试环境**不**探测兄弟目录：否则「这台机器上恰好 clone 了一个插件」
   * 会让 lynn 的整套测试行为依赖本机环境。
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
        const make = mod.writingRules ?? mod.default?.writingRules;
        if (typeof make !== "function") {
          // 旧版（api 1 输出过滤器）留在插件目录里：跳过，别让它遮蔽新版本
          if (mod.api === 1) console.warn(`[humanizer] 跳过旧版插件（api 1 输出过滤器）：${dir}`);
          continue;
        }
        if (typeof mod.api === "number" && mod.api !== API_WRITING_RULES) continue;
        handle = {
          dir,
          version: readVersion(dir),
          module: mod,
          rules: (profile, maxChars) => {
            const key = `${profile}::${maxChars ?? ""}`;
            const hit = rulesCache.get(key);
            if (hit !== undefined) return hit;
            try {
              const text = String(make({ profile, locale: "zh", ...(maxChars ? { maxChars } : {}) }) ?? "");
              rulesCache.set(key, text);
              return text;
            } catch (err) {
              console.warn(`[humanizer] 生成规则失败（${profile}）：${(err as Error)?.message ?? err}`);
              rulesCache.set(key, "");
              return "";
            }
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
  chars: number;
} {
  return {
    enabled,
    loaded: Boolean(handle),
    dir: handle?.dir ?? null,
    version: handle?.version ?? null,
    chars: enabled && handle ? handle.rules("chat").length : 0,
  };
}

/**
 * 注入系统提示词的写作规则段。空串表示「没装 / 关了 / 插件出错」——
 * 调用方直接拼上去就行，空串是恒等变换。
 */
export function writingRulesSection(profile: WritingProfile = "chat", maxChars?: number): string {
  if (!enabled || !handle) return "";
  const text = handle.rules(profile, maxChars).trim();
  if (!text) return "";
  return `\n\n【写作规则（约束你自己的措辞：不是给你的角色设定，是硬约束）】\n${text}`;
}
