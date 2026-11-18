
const fs = require('fs');
const FILES = ['src/renderer/styles/dispatch.css', 'src/renderer/console/console.css'];
const DEAD = new Set(['gauge-read','gauge-label','cache-badge','near','side-top','miss','flag','spine','md-code','md-hr','zero','feed-who','fv-role','tg-tag','tgroup-others','tgroup-others-h','tg-goto','talk-head','thread-panel','thread-bar','thread-cur','thread-meta','report-preview','sf-section','ui-plugin-set','seal-source','composer-notice','next-h','mini','art-foot','out-row','out-body','ev-audit','ev-cap','ev-grid','evr','sheet-empty','sheet-note','sn-h','se-title','sealcard-empty','sealcard-empty-quiet','spine-empty','sf-member','sf-team','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-side','ui-plugin-slots','prewrap','wd-d','pill-row','rule-h','dot-sm','tnum','st-run','composer-tools','tool-key','next-row','next','sealcard-empty']);

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
function selectorDead(s) {
  const first = /\.([a-zA-Z][\w-]*)/.exec(s);
  if (!first) return false;
  return DEAD.has(first[1]);
}
for (const f of FILES) {
  let src = fs.readFileSync(f, 'utf8');
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
    if (survivors === null) src = src.slice(0, s) + src.slice(b.end);
    else {
      const indent = /^[ \t]*/.exec(src.slice(s, b.open))[0];
      src = src.slice(0, s) + indent + survivors.join(',\n' + indent) + src.slice(b.open);
    }
    removed++;
  }
  fs.writeFileSync(f, src);
  console.log(f, 'removed:', removed, 'lines:', src.split('\n').length);
}
