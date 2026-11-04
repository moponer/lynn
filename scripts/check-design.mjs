#!/usr/bin/env node
/**
 * 设计约束 CI 检查（设计规范 §3.2 / 计划书 §4.2.4）：
 *
 *  1) 零卡片描边：样式里不允许 `border` / `border-top` 等声明，
 *     唯一例外是制图语法本身（`.crop` 角标定位点）；
 *  2) 四功能色：`:root` 与每个主题块都必须定义 --blue / --seal / --red / --brass；
 *  3) 不设品牌装饰色：任何地方出现 `--accent` 即失败；
 *  4) 行内样式同样零描边：`border:` 只允许 `0` / `none`。
 *
 * 退出码 0 = 通过；1 = 有违规（打印文件:行号）。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cssFile = path.join(root, "src/renderer/styles/dispatch.css");
const rendererDir = path.join(root, "src/renderer");

const violations = [];
const fail = (file, line, msg) => violations.push(`${path.relative(root, file)}:${line} ${msg}`);

// ---------- 1) CSS：按块扫描声明 ----------
function scanCss(file) {
  const text = fs.readFileSync(file, "utf-8");
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  let i = 0;
  let selector = "";
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const sel = text.slice(i, open).trim();
    // 找匹配的右括号
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    if (!sel.startsWith("@") && !sel.startsWith("from") && !sel.startsWith("to") && !/^\d+%$/.test(sel)) {
      const declLine = lineAt(open);
      for (const raw of body.split(";")) {
        const d = raw.trim();
        if (!d) continue;
        if (/^border(-(top|right|bottom|left|block|inline))?\s*:/i.test(d) && !/^border-radius/i.test(d)) {
          const value = d.split(":").slice(1).join(":").trim();
          const isReset = /^(0|none)(\s|!important|$)/i.test(value);
          if (!isReset && !/\.crop/.test(sel)) fail(file, declLine, `描边（零描边规则）：${sel} { ${d} }`);
        }
      }
    }
    i = j;
  }
  return text;
}

const css = scanCss(cssFile);

// ---------- 2) 主题块必须四色齐全 ----------
const themeBlocks = [
  [":root", /:root\s*\{([\s\S]*?)\}/],
  ["夜航·亮", /html\[data-theme="night"\]\[data-mode="light"\]\s*\{([\s\S]*?)\}/],
  ["纸墨·亮", /html\[data-theme="paper"\]\[data-mode="light"\]\s*\{([\s\S]*?)\}/],
  ["纸墨·暗", /html\[data-theme="paper"\]\[data-mode="dark"\]\s*\{([\s\S]*?)\}/],
  ["青瓦·暗", /html\[data-theme="celadon"\]\[data-mode="dark"\]\s*\{([\s\S]*?)\}/],
  ["青瓦·亮", /html\[data-theme="celadon"\]\[data-mode="light"\]\s*\{([\s\S]*?)\}/],
];

for (const [name, re] of themeBlocks) {
  const m = re.exec(css);
  if (!m) {
    fail(cssFile, 1, `缺少主题块：${name}`);
    continue;
  }
  for (const token of ["--blue", "--seal", "--red", "--brass"]) {
    if (!new RegExp(`${token}\\s*:`).test(m[1])) fail(cssFile, 1, `主题「${name}」缺 ${token}`);
  }
}

// ---------- 3) 禁止装饰色 / 4) 行内描边 ----------
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(css|tsx?|html)$/.test(e.name)) checkFile(p);
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, "utf-8");
  text.split("\n").forEach((line, idx) => {
    if (/--accent\b/.test(line)) fail(file, idx + 1, "出现装饰色 token --accent（四色以外不允许品牌装饰色）");
    const inline = /border\s*:\s*(?:["'`])?([^;,"'`}]+)/.exec(line);
    if (inline && /\.tsx?$/.test(file)) {
      const v = inline[1].trim();
      if (!/^(0|none|"0"|'0')$/.test(v)) fail(file, idx + 1, `行内描边：${line.trim().slice(0, 80)}`);
    }
  });
}

checkFile(cssFile);
walk(path.join(rendererDir));

// ---------- 5) 字号必须走 token（禁止裸 px） ----------
for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
  fail(cssFile, 1, `裸字号 ${m[1]}px：改用 var(--fs-*)（最小 10px）`);
}

// ---------- 6) 文本颜色禁止硬编码 hex（主题块除外） ----------
{
  const themeRanges = [];
  for (const m of css.matchAll(/(:root|html\[data-theme[^{]*)\{/g)) {
    const start = m.index;
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    themeRanges.push([start, close]);
  }
  const inTheme = (i) => themeRanges.some(([a, b]) => i >= a && i <= b);
  for (const m of css.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,8})/g)) {
    if (!inTheme(m.index)) fail(cssFile, 1, `文本颜色硬编码 ${m[1]}：改用 token（亮色主题会读不清）`);
  }
}

// ---------- 7) 对比度：六主题的正文/次级文字必须达到 AA ----------
function hexToL(hex) {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const la = hexToL(a);
  const lb = hexToL(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
{
  // 按文件顺序累积每个主题的有效 token（后出现的覆盖先出现的）
  const blocks = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel.startsWith(":root") && !sel.startsWith("html[data-theme")) continue;
    const decls = {};
    for (const d of m[2].split(";")) {
      const mm = /^\s*(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(d);
      if (mm && !mm[1].startsWith("--fs-")) decls[mm[1]] = mm[2];
    }
    blocks.push({ sel, decls });
  }
  const themes = [
    ["夜航·暗", 'html[data-theme="night"][data-mode="dark"]'],
    ["夜航·亮", 'html[data-theme="night"][data-mode="light"]'],
    ["纸墨·亮", 'html[data-theme="paper"][data-mode="light"]'],
    ["纸墨·暗", 'html[data-theme="paper"][data-mode="dark"]'],
    ["青瓦·暗", 'html[data-theme="celadon"][data-mode="dark"]'],
    ["青瓦·亮", 'html[data-theme="celadon"][data-mode="light"]'],
  ];
  for (const [name, sel] of themes) {
    const t = {};
    for (const b of blocks) {
      const parts = b.sel.split(",").map((s) => s.trim());
      if (parts.includes(":root") || parts.includes(sel)) Object.assign(t, b.decls);
    }
    const pairs = [
      ["--ink", 4.5],
      ["--ink-2", 4.5],
      ["--ink-3", 4.5],
      ["--ink-4", 4.5],
    ];
    for (const [fg, min] of pairs) {
      for (const bg of ["--desk", "--sheet", "--sheet-3"]) {
        if (!t[fg] || !t[bg]) continue;
        const c = ratio(t[fg], t[bg]);
        if (c < min) fail(cssFile, 1, `${name}：${fg} on ${bg} 对比度 ${c.toFixed(2)} < ${min}`);
      }
    }
    for (const fg of ["--blue", "--seal", "--red", "--brass"]) {
      if (!t[fg] || !t["--sheet"]) continue;
      const c = ratio(t[fg], t["--sheet"]);
      if (c < 3) fail(cssFile, 1, `${name}：${fg} on --sheet 对比度 ${c.toFixed(2)} < 3.0`);
    }
  }
}

// ---------- 8) CSS 变量契约：每个 var(--x) 必须真的被定义 ----------
// 背景：字体阶梯一度只有引用没有声明（--fs-* 全缺），font-size 计算值整条失效、
// 全站塌成 16px，但没有任何静态检查拦得住。这条规则把"引用-定义"的差集变成红灯。
{
  // 注释里举例的 var(--fs-*) 不算引用：先按行把 /* */ 抹掉，保留行数便于报行号
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const defined = new Set();
  for (const m of code.matchAll(/(?:^|[\s;{,])(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const missing = new Map();
  for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!defined.has(m[1]) && !missing.has(m[1])) {
      missing.set(m[1], code.slice(0, m.index).split("\n").length);
    }
  }
  for (const [name, line] of missing) {
    fail(cssFile, line, `未定义的 CSS 变量 ${name}：var() 会让整条声明在计算值阶段失效`);
  }
}

// ---------- 9) 时间必须走 fmtTime：ISO 原值不许直出到 JSX ----------
// 背景：台账行与印章头曾各自 `{job.at ?? "—"}`，一屏里出现 2026-11-03T10:33:13.816Z，
// 与走 fmtTime 的其它五处差 8 小时、还挤压行宽。裸 ISO 是审计线索的反面。
function scanBareTime(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanBareTime(p);
      continue;
    }
    if (!/\.tsx$/.test(e.name)) continue;
    const text = fs.readFileSync(p, "utf-8");
    text.split("\n").forEach((line, idx) => {
      const s = line.trimStart();
      if (s.startsWith("*") || s.startsWith("//") || s.startsWith("{/*")) return;
      // `{job.at}` / `{job.at ?? "—"}`；同一行里已经调 fmtTime( 的不算
      if (/\{[^{}]*\.at\s*(?:\?\?|\})/.test(line) && !/fmtTime\(/.test(line)) {
        fail(p, idx + 1, `裸时间直出：${line.trim().slice(0, 80)}（改用 fmtTime）`);
      }
    });
  }
}
scanBareTime(rendererDir);

if (violations.length > 0) {
  console.error(`设计约束检查失败（${violations.length} 处）：`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("设计约束检查通过：零描边（仅 crop 角标）、四功能色齐全、无装饰色、CSS 变量引用全部有定义。");
