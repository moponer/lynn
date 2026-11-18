/**
 * 插件命令加载器（2026-11-18 P11-1）。
 *
 * 补的是 26 章第 3 节列的缺口：`contributes.commands` **零加载器**——
 * 字段存在、校验器认它、模板演示过它，但全仓没有任何代码读它。
 * 结果就是「按文档写了斜杠命令，装上发现没反应」。
 *
 * ## 命令是什么
 *
 * 一条命令 = **一个名字 + 一段预置提示词**。用户在指令台（Ctrl+K）里选中它，
 * 这段文本被填进输入台，用户确认后发出。它不是"自动执行"，是**省掉重复打字**。
 *
 * 这个定位很重要：命令不执行任何代码，所以它不涉及权限问题，
 * 也不需要隔离进程——它只是一段文本。
 *
 * ## 两种来源，都支持
 *
 *  1. `plugin.json` 里内联：`"commands": [{ "name": "weekly", "description": "…", "prompt": "…" }]`
 *  2. 独立文件（推荐，长提示词更好维护）：`"commands": ["commands/weekly.md"]`
 *
 * 内联适合短命令；独立文件适合带多段说明的。两种都能用，因为实际写插件时两种都会遇到。
 *
 * ## 命名空间
 *
 * 命令名统一加插件前缀（`lynn.my.plugin:weekly`），避免两个插件抢同一个名字。
 * 界面上显示短名 + 插件名，用户看得到来源。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { checkManifest, type PluginManifest } from "./plugin-manifest";
import { insideBase } from "./path-guard";

/** 一条可执行的插件命令 */
export interface PluginCommand {
  /** 全名（含插件前缀），保证唯一 */
  id: string;
  /** 用户看到的短名 */
  name: string;
  /** 一句话说明（指令台里显示在名字下方） */
  description: string;
  /** 选中后填进输入台的文本 */
  prompt: string;
  /** 来自哪个插件 */
  pluginId: string;
  /** 插件显示名（界面上标来源） */
  pluginName: string;
}

export interface CommandScanResult {
  commands: PluginCommand[];
  errors: string[];
}

/** manifest 里 commands 的两种写法 */
type RawCommand = string | { name?: unknown; description?: unknown; prompt?: unknown };

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
/** 单条提示词上限：命令是"省打字"，不是"塞一整篇文档"（那种应该做成技能） */
const MAX_PROMPT_CHARS = 8000;

/** 从 manifest 里取出命令声明（两种形态都归一成数组） */
function rawCommandsOf(manifest: PluginManifest): RawCommand[] {
  const c = manifest.contributes?.commands as unknown;
  if (!Array.isArray(c)) return [];
  return c as RawCommand[];
}

/**
 * 解析一条命令。
 *
 * 返回 `{ command }` 或 `{ error }`——不抛异常，因为一个坏命令不该拖垮整个插件。
 */
function parseOne(
  raw: RawCommand,
  pluginDir: string,
  manifest: PluginManifest,
): { command?: PluginCommand; error?: string } {
  const pluginId = manifest.id;
  const pluginName = manifest.name || pluginId;
  const short = (n: string) => `${pluginId}:${n}`;

  // 形态一：指向一个 .md 文件
  if (typeof raw === "string") {
    const rel = raw.trim();
    if (!rel) return { error: `${pluginId}：commands 里有空路径` };
    const file = path.resolve(pluginDir, rel);
    if (!insideBase(pluginDir, file)) {
      return { error: `${pluginId}：命令文件越界（${rel}）` };
    }
    if (!fs.existsSync(file)) {
      return { error: `${pluginId}：命令文件不存在（${rel}）` };
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (e) {
      return { error: `${pluginId}：命令文件读不出来（${rel}）：${e instanceof Error ? e.message : String(e)}` };
    }
    /**
     * 从文件名取命令名：`weekly-report.md` → `weekly-report`。
     * 不用一级标题：标题常带空格与中文，做命令名不合适。
     */
    const name = path.basename(rel).replace(/\.md$/i, "");
    if (!NAME_RE.test(name)) {
      return { error: `${pluginId}：命令文件名「${name}」不合法（小写字母开头，只含 a-z 0-9 _ -）` };
    }
    /**
     * 描述取一级标题（`# 周报` → `周报`），取不到就留空。
     * 这是"顺手"而不是"必须"：有标题更好，没有也能用。
     */
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    return {
      command: {
        id: short(name),
        name,
        description: h1.slice(0, 120),
        prompt: text.trim().slice(0, MAX_PROMPT_CHARS),
        pluginId,
        pluginName,
      },
    };
  }

  // 形态二：内联对象
  if (typeof raw !== "object" || raw === null) {
    return { error: `${pluginId}：commands 项必须是字符串路径或对象` };
  }
  const name = String(raw.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    return { error: `${pluginId}：命令名「${name || "(空)"}」不合法（小写字母开头，只含 a-z 0-9 _ -）` };
  }
  const prompt = String(raw.prompt ?? "").trim();
  if (!prompt) {
    return { error: `${pluginId}：命令「${name}」缺少 prompt（选中后要填进输入台的文本）` };
  }
  return {
    command: {
      id: short(name),
      name,
      description: String(raw.description ?? "").trim().slice(0, 120),
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      pluginId,
      pluginName,
    },
  };
}

/**
 * 扫描 `<dataRoot>/plugins/*`，收集所有启用插件的命令。
 *
 * 为什么读 `_state.json` 判启用：那是主进程的单一真相（与技能、UI 卡槽一致）。
 * 不读它就会出现"界面里关了插件，命令还在"这种矛盾。
 */
export function scanPluginCommands(dataRoot: string): CommandScanResult {
  const commands: PluginCommand[] = [];
  const errors: string[] = [];
  const root = path.join(dataRoot, "plugins");
  if (!fs.existsSync(root)) return { commands, errors };

  const disabled = readDisabled(dataRoot);
  const seen = new Set<string>();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const manifestFile = path.join(dir, "plugin.json");
    if (!fs.existsSync(manifestFile)) continue;

    let manifest: PluginManifest;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      const check = checkManifest(raw);
      if (!check.ok) continue; // 坏清单由 PluginHost 报，这里不重复
      manifest = raw as PluginManifest;
    } catch {
      continue;
    }

    if (disabled.has(manifest.id)) continue;

    for (const raw of rawCommandsOf(manifest)) {
      const { command, error } = parseOne(raw, dir, manifest);
      if (error) {
        errors.push(error);
        continue;
      }
      if (!command) continue;
      if (seen.has(command.id)) {
        errors.push(`命令「${command.id}」重复（后注册的被忽略）`);
        continue;
      }
      seen.add(command.id);
      commands.push(command);
    }
  }

  // 稳定顺序：按 id 排。指令台按分组显示，顺序不稳会让用户找不到
  commands.sort((a, b) => a.id.localeCompare(b.id));
  return { commands, errors };
}

/**
 * 读 `_state.json` 里的停用清单（与 `PluginHost.readState` 同一份真相）。
 *
 * 注意结构：它是 `Record<插件id, 是否启用>`，**不是** `{ disabled: [...] }`。
 * 我第一版按后者写，跑测试才发现读不出任何东西——这类"猜结构"的错误
 * 不会报错，只会静默失效，所以必须照源码抄。
 */
function readDisabled(dataRoot: string): Set<string> {
  const file = path.join(dataRoot, "plugins", "_state.json");
  if (!fs.existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const out = new Set<string>();
    for (const [id, enabled] of Object.entries(raw)) {
      if (enabled === false) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}