
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
const DEAD = new Set(['tnum','gauge-read','gauge-label','cache-badge','cache-dot','gauge-bar','near','side-top','st-run','spine','spine-h','spine-list','miss','flag','seal-source','composer-tools','tool-key','next-row','next-h','mini','rule-h','pill-row','dot-sm','sheet-empty','se-title','sheet-note','sn-h','sealcard-empty','sealcard-empty-quiet','tgroup-others','tgroup-others-h','tg-goto','thread-panel','sf-member','report-preview','sf-team','sf-section','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-set','ui-plugin-side','ui-plugin-slots','prewrap','talk-head','fv-role','wd-d','zero','next','art-foot']);

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
    const rawSel = text.slice(i, open);
    const cleanSel = rawSel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
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

let guard = 0, removed = 0;
while (guard++ < 400) {
  const bs = scan(src);
  let target = null;
  for (const b of bs) {
    if (isAt(b.sel) || !b.sel) continue;
    const sels = b.sel.split(',').map(s => s.trim()).filter(Boolean);
    const survivors = sels.filter(s => {
      const toks = [...s.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
      if (!toks.length) return true;
      return !toks.every(t => DEAD.has(t));
    });
    if (survivors.length === 0) { target = { b, survivors: null }; break; }
    if (survivors.length < sels.length) { target = { b, survivors }; break; }
  }
  if (!target) break;
  const { b, survivors } = target;
  // 连同前面的空白一起删（保持文件整洁）
  let s = b.start;
  while (s > 0 && /[ \t]/.test(src[s - 1])) s--;
  if (survivors === null) {
    src = src.slice(0, s) + src.slice(b.end);
  } else {
    const indent = /^[ \t]*/.exec(src.slice(s, b.open))[0];
    const newSel = indent + survivors.join(',\n' + indent);
    src = src.slice(0, s) + newSel + src.slice(b.open);
  }
  removed++;
}
fs.writeFileSync(FILE, src);
console.log('removed/pruned:', removed, 'lines:', src.split('\n').length);
