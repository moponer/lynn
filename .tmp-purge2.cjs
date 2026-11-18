
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
const DEAD = new Set(['tnum','gauge-read','gauge-label','cache-badge','cache-dot','gauge-bar','near','side-top','st-run','spine','spine-h','spine-list','miss','flag','seal-source','composer-tools','tool-key','next-row','next-h','mini','rule-h','pill-row','dot-sm','sheet-empty','se-title','sheet-note','sn-h','sealcard-empty','sealcard-empty-quiet','tgroup-others','tgroup-others-h','tg-goto','thread-panel','sf-member','report-preview','sf-team','sf-section','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-set','ui-plugin-side','ui-plugin-slots','prewrap','talk-head','fv-role','wd-d','zero','next']);

let src = fs.readFileSync(FILE, 'utf8');

// 把整份 CSS 切成 [前置文本, selector, body, ...] 的块序列
function parse(text) {
  const blocks = [];
  let i = 0;
  let head = '';
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) { head += text.slice(i); break; }
    head += text.slice(i, open);
    const sel = head;
    head = '';
    let depth = 1, j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    blocks.push({ sel, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return { blocks, tail: head };
}

function classTokens(sel) {
  const out = [];
  for (const m of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.push(m[1]);
  return out;
}

function isAtRule(sel) {
  const t = sel.trim();
  return t.startsWith('@') || t.startsWith('from') || t.startsWith('to') || /^\d+%$/.test(t);
}

const { blocks, tail } = parse(src);
const kept = [];
let dropped = 0, pruned = 0;

for (const b of blocks) {
  if (isAtRule(b.sel)) { kept.push(b); continue; }
  const sels = b.sel.split(',').map(s => s.trim()).filter(Boolean);
  const survivors = sels.filter(s => {
    const toks = classTokens(s);
    if (!toks.length) return true;             // 元素选择器（html/body）保留
    // 该选择器里"所有类"都死了 -> 这条选择器可以删
    return !toks.every(t => DEAD.has(t));
  });
  if (survivors.length === 0) { dropped++; continue; }
  if (survivors.length < sels.length) {
    pruned++;
    // 保留原始缩进风格
    const indentMatch = /^\s*/.exec(b.sel);
    b.sel = (indentMatch ? indentMatch[0] : '') + survivors.join(',\n');
  }
  kept.push(b);
}

// 重组：保留块之间的原始注释与空白 —— 简化处理：块之间用换行
let out = '';
for (const b of kept) {
  out += b.sel + '{' + b.body + '}\n';
}
fs.writeFileSync(FILE, out);
console.log('dropped blocks:', dropped, 'pruned selectors:', pruned, 'kept:', kept.length);
