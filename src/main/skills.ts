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
}

/** 发现技能：<root>/<name>/SKILL.md；坏文件告警不炸整体 */
export function discoverSkills(roots: SkillRoot[]): { entries: SkillEntry[]; errors: string[] } {
  const entries: SkillEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    for (const d of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(root.dir, d.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      try {
        const { entry, error } = parseSkillMd(fs.readFileSync(file, "utf-8"), path.join(root.dir, d.name), root.level);
        if (error) {
          errors.push(error);
          continue;
        }
        if (entry) {
          if (seen.has(entry.name)) {
            errors.push(`技能 "${entry.name}" 重复（${root.level} 的被先注册的覆盖，就近原则）`);
            continue;
          }
          seen.add(entry.name);
          entries.push(entry);
        }
      } catch (err) {
        errors.push(`${file} 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { entries, errors };
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
