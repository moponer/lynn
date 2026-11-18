/**
 * 符号层（2026-11-17 P4-1 / 10 章 WP17）。
 *
 * 问题：成员定位代码只能"整篇读 + grep 猜"。一份 1,763 行的文件，找入口要先读一遍
 * （12K 截断），再 grep 几个词，再读一遍确认位置——一次任务下来 15 次 read_file 是常态
 * （10 章 §9 基线）。真正缺的不是"读得快"，是**不知道文件里有什么**。
 *
 * 这里给三个能力：文件里的顶层符号清单、按名字全局搜符号、只读某一段符号的正文。
 *
 * **不用 tree-sitter 是有意的**：它要原生依赖，与本项目「完全本地、离线可用、随包分发」
 * 的约束冲突（打包体积 + 编译链 + 平台二进制）。这里用**词法扫描**：按语言的顶层声明
 * 形状匹配，再用括号/缩进配对算范围。它不是真语法树——异形写法（宏生成的函数、
 * 一行多个声明、跨行的花哨签名）会漏，所以：
 *  - 每个结果都如实标注 `精确度: 词法扫描（不是语法树）`；
 *  - 找不到符号时提示可以用 grep 兜底，而不是让成员以为"文件里没有"。
 * 宁可能力弱一点但如实，也不要一个假装精确的符号器。
 */

import * as path from "node:path";

export type Lang = "ts" | "js" | "py" | "rs" | "go" | "unknown";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "const"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "mod"
  | "macro";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1 开始 */
  line: number;
  /** 1 开始，含末行 */
  endLine: number;
  exported: boolean;
  /** 单行签名（截断到 120 字），用于 repo_map 里"这个文件有什么" */
  signature: string;
}

export function langOf(file: string): Lang {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "js";
  if (ext === ".py") return "py";
  if (ext === ".rs") return "rs";
  if (ext === ".go") return "go";
  return "unknown";
}

/** 我们只对这几类文本做符号扫描；二进制/超大文件直接跳过 */
export function isScannable(file: string, sizeBytes: number): boolean {
  if (sizeBytes > 1_500_000) return false;
  return langOf(file) !== "unknown";
}

const trimSig = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
};

/**
 * 从 `fromLine`（0 基）开始找配对的花括号，返回闭合行号（0 基）。
 * 找不到闭合就返回文件末行——范围宁可给宽，也不要把函数截断成半个。
 */
function matchBrace(lines: string[], fromLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = fromLine; i < lines.length; i += 1) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Python 的块靠缩进：回到 def 同级或更浅就结束；行尾的空白不该算进范围 */
function matchIndent(lines: string[], fromLine: number): number {
  const indentOf = (s: string): number => {
    const m = /^[ \t]*/.exec(s);
    return m ? m[0].length : 0;
  };
  const baseIndent = indentOf(lines[fromLine]);
  let lastContent = fromLine;
  for (let i = fromLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue; // 空行不结束块，但也不算内容
    if (indentOf(line) <= baseIndent) return lastContent;
    lastContent = i;
  }
  return lastContent;
}

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
  nameGroup: number;
}

/** 顶层声明形状（词法层，刻意保守：只认"一眼是声明"的写法） */
const PATTERNS: Record<Exclude<Lang, "unknown">, Pattern[]> = {
  ts: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const", nameGroup: 1 },
  ],
  js: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", nameGroup: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const", nameGroup: 1 },
  ],
  py: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
  ],
  rs: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct", nameGroup: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum", nameGroup: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait", nameGroup: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "mod", nameGroup: 1 },
    { re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/, kind: "impl", nameGroup: 1 },
    { re: /^\s*macro_rules!\s*([A-Za-z_]\w*)/, kind: "macro", nameGroup: 1 },
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: "struct", nameGroup: 1 },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface", nameGroup: 1 },
    { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: "type", nameGroup: 1 },
  ],
};

/**
 * 扫描一个文件的顶层符号。纯函数、确定性：同一份文本永远同样的结果。
 * `nested` 为 false 时只认顶格（缩进 ≤ 1 个 tab / 2 空格）的声明，避免把方法体里的
 * 局部函数也算成顶层符号——那会让 repo_map 全是噪音。
 */
export function scanSymbols(text: string, lang: Lang, nested = false): CodeSymbol[] {
  if (lang === "unknown") return [];
  const lines = text.split(/\r?\n/);
  const patterns = PATTERNS[lang];
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("//") || line.trim().startsWith("#") || line.trim().startsWith("*")) {
      continue;
    }
    if (!nested) {
      const indent = (/^[ \t]*/.exec(line)?.[0] ?? "").length;
      // 顶层 = 顶格。缩进过的声明是方法/局部函数/嵌套类型，不该出现在"这个文件有什么"里
      // （find_symbol 走 nested=true，那时才往里看）
      if (indent > 0) continue;
    }
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const name = m[p.nameGroup];
      if (!name) continue;
      const key = `${name}@${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const endLine = lang === "py" ? matchIndent(lines, i) : matchBrace(lines, i);
      out.push({
        name,
        kind: p.kind,
        line: i + 1,
        endLine: endLine + 1,
        exported: /\bexport\b|\bpub\b|^[A-Z]/.test(line) && lang !== "py" ? /\bexport\b|\bpub\b/.test(line) : true,
        signature: trimSig(line),
      });
      break;
    }
  }
  return out;
}

/** 按名字找符号：完全相等优先，其次前缀，最后子串（大小写不敏感） */
export function matchSymbols(symbols: readonly CodeSymbol[], query: string): CodeSymbol[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const exact: CodeSymbol[] = [];
  const prefix: CodeSymbol[] = [];
  const partial: CodeSymbol[] = [];
  for (const s of symbols) {
    const n = s.name.toLowerCase();
    if (n === lower) exact.push(s);
    else if (n.startsWith(lower)) prefix.push(s);
    else if (n.includes(lower)) partial.push(s);
  }
  // 同一档里短的在前：名字越短通常越接近"你要找的那个"，getUser 排在 getUserById 之前
  const byLen = (a: CodeSymbol, b: CodeSymbol): number => a.name.length - b.name.length || a.name.localeCompare(b.name);
  return [...exact.sort(byLen), ...prefix.sort(byLen), ...partial.sort(byLen)];
}

/** 结构化回执（10 章 §5）：所有符号工具都按这个形状回，模型不用猜。 */
export function receipt(input: {
  ok: boolean;
  kind: string;
  target?: string;
  summary: string;
  next?: string;
  extra?: Record<string, unknown>;
}): string {
  const body: Record<string, unknown> = {
    ok: input.ok,
    kind: input.kind,
    ...(input.target ? { target: input.target } : {}),
    summary: input.summary,
    ...(input.next ? { next: input.next } : {}),
    precision: "词法扫描（不是语法树）",
    ...(input.extra ?? {}),
  };
  return JSON.stringify(body, null, 1);
}