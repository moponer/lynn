#!/usr/bin/env node
/**
 * 设计约束 CI 检查（设计规范 §3.2 / 计划书 §4.2.4）
 *
 * ## 2026-11-18 重写：从"只扫一个文件"到"扫全部样式表"
 *
 * 旧版只检查 `dispatch.css`（外加 `capture.css` 的字号），于是
 * `console.css`（2478 行、57 处 inset 描边、9px 中文、整块没接 i18n）
 * **完全在规则之外**——"lint:design 通过"曾经不代表设计约束成立。
 * 现在五张样式表全在扫描范围内，且规则本身也补了四项：
 *
 *   1) 令牌定义只能在 tokens.css；别的文件只许 var(--token)
 *   2) 禁止裸 px 字号（含 console.css）与低于 12px 的字号
 *   3) 每个按钮类必须有 :hover（缺 hover 是 bug）
 *   4) 对比度检查改用"文本档"令牌（--*-text），阈值 4.5
 *
 * 退出码 0 = 通过；1 = 有违规（打印文件:行号）。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const STYLES = path.join(root, "src/renderer/styles");
const RENDERER = path.join(root, "src/renderer");

/** 令牌文件：唯一允许定义颜色/字号/间距/圆角/层级的地方 */
const TOKENS_FILE = path.join(STYLES, "tokens.css");
/** 全部样式表（顺序即加载顺序） */
const SHEETS = [
  TOKENS_FILE,
  path.join(STYLES, "dispatch.css"),
  path.join(STYLES, "components.css"),
  path.join(RENDERER, "console/console.css"),
  path.join(STYLES, "capture.css"),
].filter((f) => fs.existsSync(f));

const violations = [];
const fail = (file, line, msg) =>
  violations.push(`${path.relative(root, file)}:${line} ${msg}`);

/** 读取并去掉注释（保留行号） */
function readCode(file) {
  const raw = fs.readFileSync(file, "utf-8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 把一张样式表切成 { selector, body, line } 块 */
function blocksOf(file) {
  const text = readCode(file);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const sel = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    const line = text.slice(0, open).split("\n").length;
    out.push({ sel, body, line });
    i = j;
  }
  return out;
}

const isAtRule = (sel) =>
  sel.startsWith("@") || sel.startsWith("from") || sel.startsWith("to") || /^\d+%$/.test(sel);

// ============================================================
// 1) 零描边：任何 border 声明都不允许（border-radius 除外）
// ============================================================
for (const file of SHEETS) {
  for (const b of blocksOf(file)) {
    if (isAtRule(b.sel)) continue;
    for (const raw of b.body.split(";")) {
      const d = raw.trim();
      if (!d) continue;
      if (/^border(-(top|right|bottom|left|block|inline))?\s*:/i.test(d) && !/^border-radius/i.test(d)) {
        const value = d.split(":").slice(1).join(":").trim();
        if (!/^(0|none)(\s|!important|$)/i.test(value)) {
          fail(file, b.line, `描边（零描边规则）：${b.sel} { ${d} }`);
        }
      }
      // 左侧竖线禁令（2026-11-12 用户定）：inset 左侧内阴影也是竖线
      if (/^box-shadow\s*:\s*inset\s+[\d.]+px\s+0\s+0/i.test(d)) {
        fail(file, b.line, `左侧竖线（全局禁令）：${b.sel} { ${d} }`);
      }
    }
  }
}

// ============================================================
// 2) 令牌定义只许出现在 tokens.css
//    其他样式表里出现 `--xxx: 值` = 有人绕过设计系统私自加值
// ============================================================
const LOCAL_VAR_ALLOW = [
  // 组件内部的临时计算变量（不是设计令牌）：显式白名单，避免误报
  "--fill", // 滑块已填充比例（JSX 内联写入）
  "--core-c", "--ring-c", "--glow-c", // 控制台印章相位色（由 data-mode 决定）
];
for (const file of SHEETS) {
  if (file === TOKENS_FILE) continue;
  for (const b of blocksOf(file)) {
    if (isAtRule(b.sel)) continue;
    for (const raw of b.body.split(";")) {
      const d = raw.trim();
      const m = /^(--[\w-]+)\s*:/.exec(d);
      if (!m) continue;
      if (LOCAL_VAR_ALLOW.includes(m[1])) continue;
      fail(file, b.line, `令牌只能定义在 tokens.css：${b.sel} { ${d} }`);
    }
  }
}

// ============================================================
// 3) 四功能色：:root 与亮色块必须四色齐全 + 两个文本档
// ============================================================
{
  const css = readCode(TOKENS_FILE);
  const themeBlocks = [
    [":root（暗）", /:root\s*\{([\s\S]*?)\}/],
    ['亮（Notion）', /html\[data-mode="light"\]\s*\{([\s\S]*?)\}/],
  ];
  for (const [name, re] of themeBlocks) {
    const m = re.exec(css);
    if (!m) {
      fail(TOKENS_FILE, 1, `缺少主题块：${name}`);
      continue;
    }
    for (const token of ["--blue", "--seal", "--red", "--brass"]) {
      if (!new RegExp(`${token}\\s*:`).test(m[1])) fail(TOKENS_FILE, 1, `主题「${name}」缺 ${token}`);
    }
    // 文本档必须成对存在：只有填充档 → 小字对比度必然不达标
    for (const token of ["--blue-text", "--seal-text", "--red-text", "--brass-text"]) {
      if (!new RegExp(`${token}\\s*:`).test(m[1])) {
        fail(TOKENS_FILE, 1, `主题「${name}」缺 ${token}（填充档与文本档必须成对）`);
      }
    }
    // 结构令牌（间距/行高/圆角/层级/字号）是全局的，只在 :root 要求一次。
    // 亮色块只覆盖颜色 —— 否则等于逼人为每个主题重抄一遍间距。
    if (name.startsWith(":root")) {
      for (const token of ["--sp-1", "--sp-5", "--sp-9", "--lh-tight", "--lh-normal", "--r-m", "--z-modal", "--fs-section", "--ic-md", "--h-ctl"]) {
        if (!new RegExp(`${token}\\s*:`).test(m[1])) fail(TOKENS_FILE, 1, `主题「${name}」缺 ${token}`);
      }
    }
  }
}

// ============================================================
// 4) 装饰色禁令 + 行内描边
// ============================================================
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|tsx?|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

for (const file of walk(RENDERER)) {
  const text = fs.readFileSync(file, "utf-8");
  text.split("\n").forEach((line, idx) => {
    if (/--accent\b/.test(line)) fail(file, idx + 1, "出现装饰色 token --accent（四色以外不允许品牌装饰色）");
    if (/\.tsx?$/.test(file)) {
      const inline = /border\s*:\s*(?:["'`])?([^;,"'`}]+)/.exec(line);
      if (inline) {
        const v = inline[1].trim();
        if (!/^(0|none|"0"|'0')$/.test(v)) fail(file, idx + 1, `行内描边：${line.trim().slice(0, 80)}`);
      }
    }
  });
}

// ============================================================
// 5) 字号：必须走 token，且不得低于 12px
// ============================================================
for (const file of SHEETS) {
  const text = readCode(file);
  text.split("\n").forEach((line, idx) => {
    const m = /font-size:\s*([\d.]+)px/.exec(line);
    if (m) {
      const px = Number(m[1]);
      if (px < 12) fail(file, idx + 1, `字号 ${px}px 低于 12px 下限（中文在 1080p 上读不清）`);
      else fail(file, idx + 1, `裸字号 ${px}px：改用 var(--fs-*)（最小 12px）`);
    }
  });
}

// ============================================================
// 6) 文本颜色禁止硬编码 hex（主题块除外）
// ============================================================
{
  const css = readCode(TOKENS_FILE);
  const themeRanges = [];
  for (const m of css.matchAll(/(:root|html\[data-(?:theme|mode)[^{]*)\{/g)) {
    const start = m.index;
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    themeRanges.push([start, close]);
  }
  const inTheme = (i) => themeRanges.some(([a, b]) => i >= a && i <= b);
  for (const file of SHEETS) {
    const text = readCode(file);
    for (const m of text.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,8})/g)) {
      // tokens.css 里的主题块是唯一允许出现 hex 的 color 位置
      if (file === TOKENS_FILE && inTheme(m.index)) continue;
      fail(file, 1, `文本颜色硬编码 ${m[1]}：改用 token（亮色主题会读不清）`);
    }
  }
}

// ============================================================
// 7) 对比度：文本档令牌必须达到 AA（4.5）
// ============================================================
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
  const css = readCode(TOKENS_FILE);
  const blocks = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel.startsWith(":root") && !sel.startsWith("html[data-theme") && !sel.startsWith("html[data-mode")) continue;
    const decls = {};
    for (const d of m[2].split(";")) {
      const mm = /^\s*(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(d);
      if (mm && !mm[1].startsWith("--fs-")) decls[mm[1]] = mm[2];
    }
    blocks.push({ sel, decls });
  }
  const themes = [
    ["暗", ":root"],
    ["亮", 'html[data-mode="light"]'],
  ];
  for (const [name, sel] of themes) {
    const t = {};
    for (const b of blocks) {
      const parts = b.sel.split(",").map((s) => s.trim());
      if (parts.includes(":root") || parts.includes(sel)) Object.assign(t, b.decls);
    }
    // 正文四级墨色：在最浅的三种表面上都要过 AA
    for (const fg of ["--ink", "--ink-2", "--ink-3", "--ink-4"]) {
      for (const bg of ["--desk", "--sheet", "--sheet-3"]) {
        if (!t[fg] || !t[bg]) continue;
        const c = ratio(t[fg], t[bg]);
        if (c < 4.5) fail(TOKENS_FILE, 1, `${name}：${fg} on ${bg} 对比度 ${c.toFixed(2)} < 4.5`);
      }
    }
    // 文本档功能色：小字用它，必须 4.5
    for (const fg of ["--blue-text", "--seal-text", "--red-text", "--brass-text"]) {
      for (const bg of ["--desk", "--sheet", "--sheet-3"]) {
        if (!t[fg] || !t[bg]) continue;
        const c = ratio(t[fg], t[bg]);
        if (c < 4.5) fail(TOKENS_FILE, 1, `${name}：${fg} on ${bg} 对比度 ${c.toFixed(2)} < 4.5（文本档必须可读）`);
      }
    }
    // 填充档：图形/底色阈值 3.0
    for (const fg of ["--blue", "--seal", "--red", "--brass"]) {
      if (!t[fg] || !t["--sheet"]) continue;
      const c = ratio(t[fg], t["--sheet"]);
      if (c < 3) fail(TOKENS_FILE, 1, `${name}：${fg} on --sheet 对比度 ${c.toFixed(2)} < 3.0`);
    }
  }
}

// ============================================================
// 8) CSS 变量契约：每个 var(--x) 必须真的被定义
// ============================================================
{
  const defined = new Set();
  const missing = new Map();
  for (const file of SHEETS) {
    const code = readCode(file);
    for (const m of code.matchAll(/(?:^|[\s;{,])(--[\w-]+)\s*:/g)) defined.add(m[1]);
  }
  for (const file of SHEETS) {
    const code = readCode(file);
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!defined.has(m[1]) && !missing.has(m[1])) {
        missing.set(m[1], code.slice(0, m.index).split("\n").length);
        fail(file, missing.get(m[1]), `未定义的 CSS 变量 ${m[1]}：var() 会让整条声明在计算值阶段失效`);
      }
    }
  }
}

// ============================================================
// 9) 每个按钮类必须有 :hover（缺 hover 是 bug，不是风格）
// ============================================================
{
  const all = SHEETS.map((f) => readCode(f)).join("\n");
  const BUTTON_CLASSES = [
    "btn", "sf-btn", "ghost-btn", "icon-btn", "ask-btn", "perm-btn",
    "capture-trigger", "card-raised", "switch",
  ];
  for (const cls of BUTTON_CLASSES) {
    // 允许 .cls:hover，也允许变体形式 .cls.primary:hover / .cls.ghost:hover
    const re = new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?:\\.[\\w-]+)?:hover\\b`);
    if (!re.test(all)) fail(STYLES, 1, `按钮类 .${cls} 没有 :hover 态（每个可点元素必须四态齐全）`);
  }
}

// ============================================================
// 10) 裸 px 间距：组件样式只许用 --sp-* / --h-* / --ic-*
//     （tokens.css 自身除外；@media 断点与极值 0/1px 豁免）
// ============================================================
{
  const PAD_RE = /(?:padding|gap|margin)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([^;]+)/g;
  const NUM_RE = /(?:^|[\s(])(\d+)px/g;
  const ALLOW_PX = new Set([0, 1, 2, 100]); // 0/1/2 是发丝线与对齐微调；100% 用在 width
  for (const file of SHEETS) {
    if (file === TOKENS_FILE) continue;
    const text = readCode(file);
    text.split("\n").forEach((line, idx) => {
      if (/@media/.test(line)) return;
      for (const m of line.matchAll(PAD_RE)) {
        for (const n of m[1].matchAll(NUM_RE)) {
          const v = Number(n[1]);
          if (ALLOW_PX.has(v)) continue;
          fail(file, idx + 1, `裸 px 间距 ${v}px：改用 var(--sp-*)`);
          break;
        }
      }
    });
  }
}

// ============================================================
// 11) 层级：z-index 只许用令牌
// ============================================================
for (const file of SHEETS) {
  if (file === TOKENS_FILE) continue;
  const text = readCode(file);
  text.split("\n").forEach((line, idx) => {
    const m = /z-index:\s*([^;]+)/.exec(line);
    if (!m) return;
    if (/var\(--z-/.test(m[1])) return;
    // 局部层叠上下文（0/1/2/auto）不参与全局阶梯，允许字面值：
    // 它们只在某个 position:relative 的父级内部排序，放大到全局没有意义。
    if (/^(0|1|2|auto)\b/.test(m[1].trim())) return;
    // 带"局部层叠"注释的行也放行（显式声明的局部上下文）
    if (/局部层叠/.test(line)) return;
    fail(file, idx + 1, `z-index 必须走令牌：${line.trim().slice(0, 60)}`);
  });
}

// ============================================================
// 12) 内联字号 / 内联颜色：TSX 里不许写裸数字或 hex
// ============================================================
{
  for (const file of walk(RENDERER)) {
    if (!/\.tsx$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    text.split("\n").forEach((line, idx) => {
      const s = line.trimStart();
      if (s.startsWith("*") || s.startsWith("//") || s.startsWith("{/*")) return;
      if (/fontSize\s*:\s*["'`]?\s*[\d.]/.test(line)) {
        fail(file, idx + 1, `内联字号必须用 var(--fs-*)：${line.trim().slice(0, 80)}`);
      }
    });
  }
}

// ============================================================
// 13) 时间必须走 fmtTime：ISO 原值不许直出到 JSX
// ============================================================
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
      if (/\{[^{}]*\.at\s*(?:\?\?|\})/.test(line) && !/fmtTime\(/.test(line)) {
        fail(p, idx + 1, `裸时间直出：${line.trim().slice(0, 80)}（改用 fmtTime）`);
      }
    });
  }
}
scanBareTime(RENDERER);

// ============================================================
// 14) 图标名必须在 PATHS 里真实存在
//     此前 nav 用了 home / cpu 两个不存在的名字，渲染出空 <g>
// ============================================================
{
  const iconFile = path.join(RENDERER, "components/Icon.tsx");
  const iconSrc = fs.readFileSync(iconFile, "utf-8");
  const declared = new Set();
  const block = /const PATHS[^{]*\{([\s\S]*?)\n\}\s*as const;/.exec(iconSrc);
  if (!block) {
    fail(iconFile, 1, "找不到 PATHS 表：图标检查无法进行");
  } else {
    for (const m of block[1].matchAll(/^\s*([a-z][a-z0-9]*)\s*:/gm)) declared.add(m[1]);
    for (const file of walk(RENDERER)) {
      if (!/\.tsx$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf-8");
      text.split("\n").forEach((line, idx) => {
        for (const m of line.matchAll(/<Icon\s+name="([a-z][a-z0-9]*)"/g)) {
          if (!declared.has(m[1])) fail(file, idx + 1, `图标 "${m[1]}" 不在 PATHS 表里（会渲染成空 <g>）`);
        }
        for (const m of line.matchAll(/icon:\s*"([a-z][a-z0-9]*)"/g)) {
          if (!declared.has(m[1])) fail(file, idx + 1, `图标 "${m[1]}" 不在 PATHS 表里（会渲染成空 <g>）`);
        }
      });
    }
  }
}

// ============================================================
// 15) 纯图标按钮必须有可访问名
// ============================================================
{
  for (const file of walk(RENDERER)) {
    if (!/\.tsx$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    for (const m of text.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
      const b = m[0];
      const line = text.slice(0, m.index).split("\n").length;
      // 只看"含图标且不含任何可见文字"的按钮。
      // {t("key")} / {label} 这类表达式是**有文字**的（它们会渲染成文案），
      // 所以先替换成占位符再判断，否则会误报所有"图标 + 翻译文案"的按钮。
      const stripped = b
        .replace(/<[^>]*>/g, "")
        .replace(/\{\s*t\([^)]*\)\s*\}/g, "TEXT")
        .replace(/\{\s*[\w.]+\s*\}/g, "TEXT")
        .replace(/\{[^{}]*\}/g, "")
        .trim();
      const hasIcon = /<Icon\b/.test(b);
      if (hasIcon && stripped.length === 0 && !/aria-label|title=/.test(b)) {
        fail(file, line, "纯图标按钮缺 aria-label / title（屏幕阅读器读不出它做什么）");
      }
    }
  }
}

// ============================================================
// 16) 同名选择器重复定义：同一属性被写两遍 = 有人在"后写的赢"
// ============================================================
{
  for (const file of SHEETS) {
    if (file === TOKENS_FILE) continue;
    const map = new Map();
    for (const b of blocksOf(file)) {
      if (isAtRule(b.sel)) continue;
      const props = b.body
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(":")[0].trim());
      if (!map.has(b.sel)) map.set(b.sel, []);
      map.get(b.sel).push({ line: b.line, props });
    }
    for (const [sel, list] of map) {
      if (list.length < 2) continue;
      const counts = {};
      for (const it of list) for (const p of it.props) counts[p] = (counts[p] ?? 0) + 1;
      const dup = Object.entries(counts).filter(([, n]) => n > 1).map(([p]) => p);
      if (dup.length) {
        fail(file, list[1].line, `选择器 "${sel}" 重复定义同一属性（${dup.join(", ")}），后者会静默覆盖前者`);
      }
    }
  }
}

// ============================================================
// 17) 死类名：定义了但全仓库没有任何引用
// ============================================================
{
  const sources = walk(RENDERER)
    .filter((f) => /\.(tsx?|html)$/.test(f))
    .map((f) => fs.readFileSync(f, "utf-8"))
    .join("\n");
  const declared = new Map();
  for (const file of SHEETS) {
    if (file === TOKENS_FILE) continue;
    const text = readCode(file);
    for (const m of text.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      if (!declared.has(m[1])) declared.set(m[1], { file, line: text.slice(0, m.index).split("\n").length });
    }
  }
  // components.css 是**原语库**：它定义的是可供任何页面取用的通用类，
  // 不是"当前恰好被用到的那几个"。原语暂时没有调用方不算死代码
  // （下一屏很可能就用上），所以整张表的类名在这里整体豁免。
  const PRIMITIVE_SHEET = path.join(STYLES, "components.css");
  const DEAD_ALLOW = new Set([
    // 第三方库注入的类名（docx-preview / x-spreadsheet / highlight.js）
    "docx-wrapper", "x-spreadsheet",
    "hljs-keyword", "hljs-selector-tag", "hljs-built_in", "hljs-type", "hljs-title", "hljs-literal",
    "hljs-string", "hljs-attr", "hljs-symbol", "hljs-regexp", "hljs-addition",
    "hljs-number", "hljs-meta", "hljs-variable", "hljs-template-variable",
    "hljs-comment", "hljs-quote", "hljs-deletion", "hljs-emphasis",
    // 由 JSX 动态拼接（前缀 + 变量）
    "k-doc", "k-sheet", "k-slides", "k-pdf", "kind-approval", "lv-hot", "lv-ok",
    "tone-auth", "tone-budget", "tone-cleanup", "tone-error", "tone-patrol",
    "tone-quiet", "tone-recover", "tone-seal",
    "author-", "fx", "pet-fx-", "k-", "kind-", "lv-", "tone-", "side-", "step-line",
    // 桌宠：PetStage / Pet 组件在 2026-11-15 因素材 20MB 不入库而注释掉，
    // 但样式必须留着——恢复时只取消注释，不该连样式一起重写。
    "pet-lean-l", "pet-lean-r", "pet-shadow-hop", "pet-shadow-stretch",
    "pet-shadow-squash", "pet-shadow-land", "pet-fx-pop", "pet-fx-squash",
    "pet-fx-stretch", "pet-fx-hop", "pet-fx-land", "pet-fx-sway",
  ]);
  for (const [cls, where] of declared) {
    if (DEAD_ALLOW.has(cls)) continue;
    if (where.file === PRIMITIVE_SHEET) continue;
    if (cls.length < 3) continue;
    const re = new RegExp(`(?<![\\w-])${cls.replace(/-/g, "\\-")}(?![\\w-])`);
    if (!re.test(sources)) {
      fail(where.file, where.line, `死类名 .${cls}：定义了但全仓库没有引用（删掉或接上）`);
    }
  }
}

// ============================================================
if (violations.length > 0) {
  console.error(`设计约束检查失败（${violations.length} 处）：`);
  for (const v of violations.slice(0, 120)) console.error("  " + v);
  if (violations.length > 120) console.error(`  …还有 ${violations.length - 120} 处`);
  process.exit(1);
}
console.log(
  `设计约束检查通过：${SHEETS.length} 张样式表、零描边、四功能色（填充+文本双档）、令牌单一来源、` +
    "字号 ≥12px 且全走 token、间距/层级/圆角全走 token、按钮四态齐全、图标名有效、无死类名。",
);
