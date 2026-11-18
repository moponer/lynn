// M2-10：技能体系（§4.5 L610–621）。
//  - 沿用 Pi 标准 SKILL.md（frontmatter：name / description / allowed-tools）。
//  - **allowed-tools 必须强制**：命中技能后只允许声明子集（元工具始终放行）。
//  - 注入有总预算（默认 20K 字符），超预算降级"仅名称"，避免撑爆系统提示。
//  - 兼容社区 SKILL.md：不认识的字段告警不拒绝。
import * as fs from "node:fs";
import * as path from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
  /** user | project | plugin */
  level: "user" | "project" | "plugin";
  dir: string;
  /** 兼容性告警（不拒绝加载） */
  warnings: string[];
}

export interface SkillParse {
  entry: SkillEntry | null;
  error?: string;
}

/** 解析 SKILL.md：frontmatter YAML 子集（name/description/allowed-tools），宽容未知字段 */
export function parseSkillMd(text: string, dir: string, level: SkillEntry["level"]): SkillParse {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { entry: null, error: `${dir}：SKILL.md 缺 frontmatter（--- ... ---）` };
  const [, fm, body] = m;
  const warnings: string[] = [];
  let name = "";
  let description = "";
  let allowedTools: string[] = [];
  let currentList: "allowed-tools" | null = null;
  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem && currentList === "allowed-tools") {
      allowedTools.push(listItem[1].trim());
      continue;
    }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      warnings.push(`无法解析的行：${line.trim().slice(0, 40)}`);
      continue;
    }
    const [, key, rawVal] = kv;
    currentList = null;
    const val = /^"(.*)"$/.exec(rawVal)?.[1] ?? /^'(.*)'$/.exec(rawVal)?.[1] ?? rawVal.trim();
    if (key === "name") name = val;
    else if (key === "description") description = val;
    else if (key === "allowed-tools") {
      const inline = /^\[(.*)\]$/.exec(val);
      if (inline) {
        allowedTools = inline[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else if (val) {
        allowedTools = val.split(",").map((x) => x.trim()).filter(Boolean);
      } else {
        currentList = "allowed-tools"; // 下面是 - 列表
      }
    } else {
      warnings.push(`未知字段 "${key}" 已忽略（兼容社区 SKILL.md）`);
    }
  }
  if (!name) {
    name = path.basename(dir); // 缺 name 用目录名兜底
    warnings.push(`frontmatter 缺 name，使用目录名 "${name}"`);
  }
  return {
    entry: {
      name,
      description,
      allowedTools,
      body: body.trim(),
      level,
      dir,
      warnings,
    },
  };
}

export interface SkillRoot {
  dir: string;
  level: SkillEntry["level"];
  /** 目录不存在时跳过 */
  /**
   * 声明式过滤（P12-2）。
   *
   * 不传 = 扫整个目录（`skills/` 这种"放进去就生效"的目录）；
   * 传了 = **只加载声明的那些**（插件目录必须传，见下）。
   *
   * 为什么要区分：插件目录里除了 `SKILL.md` 还有 `plugin.json`、`ui.html`、
   * 甚至别的插件的子目录。不按声明过滤，会出现两个问题：
   *  1. 插件作者在 `contributes.skills` 里写错了名字，技能**照样被加载**——
   *     "声明即生效"变成"声明不声明都一样"，那这个字段就没有意义；
   *  2. 一个插件目录里放两个 `SKILL.md`，用户以为只启用了声明的那一个，实际两个都进了。
   *
   * 值可以是**子目录名**或**技能名**（frontmatter 里的 `name`）：
   * 写 `skills: ["weekly-report"]` 时，`<插件>/weekly-report/SKILL.md` 会被加载；
   * 写 `skills: ["."]` 表示"插件根目录自己就是一个技能"。
   */
  declared?: readonly string[];
}

/** 发现技能：`<root>/<name>/SKILL.md`；坏文件告警不炸整体 */
export function discoverSkills(roots: SkillRoot[]): { entries: SkillEntry[]; errors: string[] } {
  const entries: SkillEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    /**
     * 声明过滤（P12-2）。
     *
     * 不传 `declared` = 扫整个目录（`skills/` 这种"放进去就生效"的目录）。
     * 传了 = 只认声明的那些，且**声明了但找不到要报错**——
     * 静默忽略会让"我明明声明了"变成哑谜。
     */
    const declared = root.declared ? new Set(root.declared) : null;
    const hit = new Set<string>();
    for (const d of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      /**
       * 声明过滤，要同时满足两件事：
       *  - **目录名命中** → 一定要读（这是快路径）；
       *  - **目录名没命中** → 只有在"声明里还有未被认领的项"时才读一次，
       *    因为声明可能写的是 frontmatter 里的技能名，不读文件无从判断。
       *
       * 但"读"和"报错"要分开：`byNameProbe` 模式下读到的坏文件**不报错**——
       * 它本来就没被声明，作者不该因为放了个无关文件被指责。
       */
      const byDir = declared ? declared.has(d.name) : true;
      const byNameProbe = Boolean(declared) && !byDir && [...declared!].some((x) => !hit.has(x));
      if (!byDir && !byNameProbe) continue;

      const file = path.join(root.dir, d.name, "SKILL.md");
      if (!fs.existsSync(file)) {
        // 只有"按目录名声明了却没有文件"才算错；探测性读取找不到文件是正常的
        if (byDir && declared) {
          errors.push(`技能目录 "${d.name}" 里没有 SKILL.md（在 contributes.skills 里声明了）`);
        }
        continue;
      }
      try {
        const { entry, error } = parseSkillMd(fs.readFileSync(file, "utf-8"), path.join(root.dir, d.name), root.level);
        if (error) {
          // 探测性读取的坏文件不报错：它没被声明，不该因它分心
          if (byDir) errors.push(error);
          continue;
        }
        if (entry) {
          if (declared && !byDir && !declared.has(entry.name)) continue;
          if (seen.has(entry.name)) {
            errors.push(`技能 "${entry.name}" 重复（${root.level} 的被先注册的覆盖，就近原则）`);
            continue;
          }
          seen.add(entry.name);
          hit.add(d.name);
          hit.add(entry.name);
          entries.push(entry);
        }
      } catch (err) {
        if (byDir) errors.push(`${file} 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    /**
     * 声明了但一个都没找到：明确报出来。
     * 这是"声明即生效"的另一半——声明了没生效也要说，不能只默默少一个技能。
     */
    if (declared) {
      for (const want of declared) {
        if (!hit.has(want)) {
          errors.push(`contributes.skills 声明了 "${want}"，但 ${root.dir} 下没有对应的 SKILL.md`);
        }
      }
    }
  }
  return { entries, errors };
}

/**
 * 外部技能的工具名映射（2026-11-17 P2-2）。
 *
 * 社区 SKILL.md 写的是**别的运行时**的工具名（Read/Bash/Write/Edit/Glob/Grep/WebFetch…）。
 * 我们原样收下会出两个事故：
 *  1. `isToolAllowed` 按名单强制——一旦命中，风铃的全部工具都被判为"不在子集"，等于把她锁死；
 *  2. 工具名对不上，模型以为真有个叫 Bash 的工具可调，调了就是未知工具。
 * 所以加载期就翻译成我们的名字；不认识的名字**直接丢弃**（不猜），并留一条告警。
 * 丢弃是安全的：`allowedTools` 为空 = 不限制（见 isToolAllowed）。
 */
const TOOL_ALIASES: Record<string, string[]> = {
  Read: ["read_file", "read_artifact", "office_read_table"],
  Write: ["write_file", "office_write_docx", "office_write_table"],
  Edit: ["edit_file", "write_file"],
  MultiEdit: ["edit_file"],
  Bash: ["run_command"],
  Shell: ["run_command"],
  Glob: ["glob", "list_dir"],
  Grep: ["grep"],
  LS: ["list_dir"],
  WebFetch: ["browser_navigate", "browser_extract"],
  WebSearch: ["browser_navigate", "browser_extract"],
  Browser: ["browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_extract"],
  // 成员侧（成员技能同表）
  read_file: ["read_file"],
  write_file: ["write_file"],
  edit_file: ["edit_file"],
  run_command: ["run_command"],
  glob: ["glob"],
  grep: ["grep"],
  list_dir: ["list_dir"],
};

/** 把外部工具名翻译成本仓的真实名字；不认识的返回空数组（调用方负责告警） */
export function mapAllowedTools(names: readonly string[]): { mapped: string[]; unknown: string[] } {
  const out = new Set<string>();
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || name === "*") {
      if (name === "*") out.add("*");
      continue;
    }
    const hit = TOOL_ALIASES[name];
    if (hit) for (const t of hit) out.add(t);
    else unknown.push(name);
  }
  return { mapped: [...out].sort(), unknown };
}

/** 命中技能：description/name/body 里的 2-gram 与输入求交，命中 ≥2 才算（宁缺勿滥） */
export function matchSkills(text: string, entries: SkillEntry[]): SkillEntry[] {
  const q = text.trim();
  if (!q) return [];
  const hits: { e: SkillEntry; score: number }[] = [];
  for (const e of entries) {
    const bag = `${e.name} ${e.description} ${e.body.slice(0, 500)}`;
    let score = 0;
    for (let i = 0; i + 2 <= q.length; i += 1) {
      if (bag.includes(q.slice(i, i + 2))) score += 1;
    }
    if (score >= 2) hits.push({ e, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 3).map((h) => h.e);
}

export const SKILL_BUDGET = 20_000;

export interface SkillInjection {
  text: string;
  /** true = 超预算，已降级为仅名称 */
  degraded: boolean;
}

/** 技能注入（预算 20K 字符）：全文 → 超预算降级为名称+一句话 */
export function buildInjection(active: SkillEntry[], budget = SKILL_BUDGET): SkillInjection {
  if (!active.length) return { text: "", degraded: false };
  const full = active
    .map((e) => `【技能：${e.name}】${e.description ? `（${e.description}）` : ""}\n${e.body}`)
    .join("\n\n");
  if (full.length <= budget) return { text: full, degraded: false };
  const names = active
    .map((e) => `- ${e.name}${e.description ? `：${e.description}` : ""}`)
    .join("\n");
  return {
    text: `【技能列表（内容超预算，已降级为仅名称；需要详情时请用户查看 SKILL.md）】\n${names}`,
    degraded: true,
  };
}

/** allowed-tools 强制：激活集非空时，工具必须在子集内（metaTools 始终放行） */
export function isToolAllowed(tool: string, active: SkillEntry[], metaTools: readonly string[]): boolean {
  if (!active.length) return true;
  if (metaTools.includes(tool)) return true;
  return active.some((e) => e.allowedTools.includes(tool) || e.allowedTools.includes("*"));
}
