
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
let src = fs.readFileSync(FILE, 'utf8');
const log = [];
function rep(oldS, newS, label) {
  if (!src.includes(oldS)) { log.push('MISS ' + label); return; }
  src = src.split(oldS).join(newS);
  log.push('ok ' + label);
}

// ---- 1) :root 令牌块 -> 指针 ----
const rootStart = src.indexOf(':root {');
const rootEnd = src.indexOf('}', src.indexOf('--scroll-thumb-hover', rootStart));
const lightStart = src.indexOf('html[data-mode="light"] {');
const lightEnd = src.indexOf('\n}', src.indexOf('--scroll-thumb-hover', lightStart));
if (rootStart >= 0 && lightEnd > 0) {
  src = src.slice(0, rootStart) +
    '/* 令牌（颜色 / 字号 / 间距 / 圆角 / 层级 / 阴影 / 动效）全部在 tokens.css。\n' +
    '   本文件只消费 var(--token)，不再定义任何值——这是"改一处、全站跟着变"的前提。\n' +
    '   加载顺序：tokens.css → dispatch.css → components.css → capture.css（见 main.tsx）。 */' +
    src.slice(lightEnd + 2);
  log.push('ok root->pointer');
}

// ---- 2) body 基线 ----
rep(
`html, body {
  margin: 0;
  padding: 0;
  background: #0a0e12;
  color: var(--ink);
  font-family: var(--f-cjk);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}`,
`html, body {
  margin: 0;
  padding: 0;
  background: var(--desk);
  color: var(--ink);
  font-family: var(--f-cjk);
  /* 基线字号必须显式声明：此前 body 没有 font-size，凡是没写 font-size 的
     元素都继承浏览器默认 16px（向导步骤条就踩了这个坑）。 */
  font-size: var(--fs-body);
  line-height: var(--lh-normal);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}`, 'body-baseline');

// ---- 3) 图标尺寸 ----
rep(
`svg.ic { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
svg.ic.sm { width: 13px; height: 13px; }
svg.ic.lg { width: 20px; height: 20px; }`,
`/* 图标五个落点全部走令牌（--ic-xs/sm/md/lg/xl），不再写裸 px。
   此前 sm=13 / lg=20，另有 12/14 的局部覆盖，同一个 24 网格图标出现在 5 个尺寸上。 */
svg.ic { width: var(--ic-md); height: var(--ic-md); stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
svg.ic.xs { width: var(--ic-xs); height: var(--ic-xs); }
svg.ic.sm { width: var(--ic-sm); height: var(--ic-sm); }
svg.ic.lg { width: var(--ic-lg); height: var(--ic-lg); }
svg.ic.xl { width: var(--ic-xl); height: var(--ic-xl); }`, 'icon-sizes');

// ---- 4) 硬编码 hover -> 令牌 ----
rep('.crumb-chip:hover { background: #202b37; color: var(--ink); }', '.crumb-chip:hover { background: var(--hover-bg); color: var(--ink); }', 'hover-crumb');
rep('.usage-meter-btn:hover { background: #222d39; color: var(--ink); }', '.usage-meter-btn:hover { background: var(--hover-bg-2); color: var(--ink); }', 'hover-usage');
rep('.icon-btn:hover { background: #202b37; color: var(--ink-2); }', '.icon-btn:hover { background: var(--hover-bg); color: var(--ink-2); }', 'hover-icon');
rep('.ghost-btn:hover { background: #222d39; color: var(--ink); }', '.ghost-btn:hover { background: var(--hover-bg-2); color: var(--ink); }', 'hover-ghost');
rep('.job:hover { background: #18212c; }', '.job:hover { background: var(--hover-bg); }', 'hover-job');
rep('.btn-accept:hover { background: #6fbada; }', '.btn-accept:hover { background: var(--blue-hover); }', 'hover-accept');
rep('.btn-reject:hover { background: #32424f; color: var(--ink); }', '.btn-reject:hover { background: var(--hover-bg-2); color: var(--ink); }', 'hover-reject');

// ---- 5) 旧青蓝 rgba ----
rep('rgba(94,169,201,.10)', 'var(--blue-wash)', 'old-blue-1');
rep('rgba(94,169,201,.6)', 'var(--blue-line)', 'old-blue-2');
rep('rgba(94,169,201,.7)', 'var(--blue-line)', 'old-blue-3');
rep('rgba(94,169,201,.55)', 'var(--blue-line)', 'old-blue-4');
rep('rgba(94, 169, 201, .10)', 'var(--blue-wash)', 'old-blue-5');
rep('rgba(146,174,194,.05)', 'var(--rule-soft)', 'old-gray-1');
rep('rgba(146,174,194,.045)', 'var(--rule-soft)', 'old-gray-2');
rep('rgba(146,174,194,.08)', 'var(--rule-soft)', 'old-gray-3');
rep('rgba(146,174,194,.09)', 'var(--rule-soft)', 'old-gray-4');
rep('rgba(146,174,194,.12)', 'var(--rule)', 'old-gray-5');
rep('rgba(146, 174, 194, .12)', 'var(--rule)', 'old-gray-6');
rep('rgba(146, 174, 194, .08)', 'var(--rule-soft)', 'old-gray-7');
rep('rgba(146, 174, 194, .06)', 'var(--rule-soft)', 'old-gray-8');
rep('rgba(120,150,170,.12)', 'var(--rule)', 'old-gray-9');
rep('rgba(120,150,170,.10)', 'var(--rule-soft)', 'old-gray-10');

// ---- 6) 重复 :root ----
rep(`/* ---------- 交互底色 / 强调字色（只留暗亮两套） ---------- */
:root {
  --hover-bg: #151c20;
  --hover-bg-2: #1b2429;
  --on-accent: #0a0d0f;
}

/* 亮色主题下不再用硬编码深色做 hover（那是"文字消失"的根因） */
`, `/* 交互底色 / 强调字色已在 tokens.css 定义，这里不再重复声明——
   重复声明意味着"后写的赢"，是这次重建里被清掉的一类债。 */
`, 'dup-root');

// ---- 7) sf-sub 撞名 ----
rep(`.sf-sub {
  display: block; margin-top: var(--sp-2);
  font-family: var(--f-mono); font-size: var(--fs-label); letter-spacing: 0; color: var(--ink-4);
}`, `/* 弹窗标题下的副标题。
   2026-11-18 改名：这个类此前与下面的"表单分组"共用 .sf-sub 一个名字，
   后者把 display 改成 flex，把标题副文本悄悄变成了 flex 列。 */
.sf-subtitle {
  display: block; margin-top: var(--sp-2);
  font-family: var(--f-mono); font-size: var(--fs-label); letter-spacing: 0; color: var(--ink-4);
}`, 'sf-sub-rename');

// ---- 8) .sf-card.wide 死规则 ----
rep(`.sf-card.wide { width: 720px; max-height: 88vh; display: flex; flex-direction: column; }
.sf-card.wide .sf-body { overflow-y: auto; padding-bottom: var(--sp-9); }`,
`/* .sf-card.wide 的最终尺寸在文件后部声明（1120×860）。
   这里不再给一个会被覆盖的 720px 版本 —— 两套尺寸并存时，读代码的人无法判断哪个是真的。 */`, 'sf-card-wide');

fs.writeFileSync(FILE, src);
console.log(log.join('\n'));
console.log('lines:', src.split('\n').length);
