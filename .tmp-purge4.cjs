
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
// 扩展后的死类名清单（含 lint 新报出的）
const DEAD = new Set(['tnum','gauge-read','gauge-label','cache-badge','cache-dot','gauge-bar','near','side-top','st-run','spine','spine-h','spine-list','miss','flag','seal-source','composer-tools','tool-key','next-row','next-h','mini','rule-h','pill-row','dot-sm','sheet-empty','se-title','sheet-note','sn-h','sealcard-empty','sealcard-empty-quiet','tgroup-others','tgroup-others-h','tg-goto','thread-panel','sf-member','report-preview','sf-team','sf-section','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-set','ui-plugin-side','ui-plugin-slots','prewrap','talk-head','fv-role','wd-d','zero','next','art-foot','feed-who','composer-notice','thread-bar','thread-cur','thread-meta','md-code','md-hr','out-row','out-body','spine-empty','ev-audit','ev-cap','ev-grid','evr']);

let src = fs.readFileSync(FILE, 'utf8');

function scan(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const cleanSel = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    out.push({ start: i, open, end: j, sel: cleanSel });
    i = j;
  }
  return out;
}
const isAt = s => s.startsWith('@') || s.startsWith('from') || s.startsWith('to') || /^\d+%$/.test(s);

// 关键改进：选择器以死类名**开头**（锚点已死）→ 整条规则死，
// 不管后面还挂着哪些活着的从属类（.gauge-read .v 这类）。
function selectorDead(s) {
  const first = /\.([a-zA-Z][\w-]*)/.exec(s);
  if (!first) return false;             // 纯元素选择器保留
  if (!DEAD.has(first[1])) return false;
  // 例外：作为状态修饰符出现（.on / .open / .active）的类不是锚点
  return true;
}

let guard = 0, removed = 0;
while (guard++ < 600) {
  const bs = scan(src);
  let target = null;
  for (const b of bs) {
    if (isAt(b.sel) || !b.sel) continue;
    const sels = b.sel.split(',').map(s => s.trim()).filter(Boolean);
    const survivors = sels.filter(s => !selectorDead(s));
    if (survivors.length === 0) { target = { b, survivors: null }; break; }
    if (survivors.length < sels.length) { target = { b, survivors }; break; }
  }
  if (!target) break;
  const { b, survivors } = target;
  let s = b.start;
  while (s > 0 && /[ \t]/.test(src[s - 1])) s--;
  if (survivors === null) {
    src = src.slice(0, s) + src.slice(b.end);
  } else {
    const indent = /^[ \t]*/.exec(src.slice(s, b.open))[0];
    src = src.slice(0, s) + indent + survivors.join(',\n' + indent) + src.slice(b.open);
  }
  removed++;
}
fs.writeFileSync(FILE, src);
console.log('removed/pruned:', removed, 'lines:', src.split('\n').length);
