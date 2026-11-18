
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
const DEAD = ['tnum','gauge-read','gauge-label','cache-badge','cache-dot','gauge-bar','side-top','st-run','spine-h','spine-list','flag','seal-source','composer-tools','tool-key','next-row','next-h','rule-h','pill-row','dot-sm','sheet-empty','tgroup-others','tg-goto','sealcard-empty','thread-panel','sf-member','report-preview','sheet-note','sf-team','sf-section','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-set','ui-plugin-side','ui-plugin-slots','prewrap','talk-head','fv-role','wd-d','zero','next'];

let src = fs.readFileSync(FILE, 'utf8');
let removed = 0;

// 逐个删除"选择器块"：从上一个 } 或 ; 之后的空白开始，到块结束的 } 为止
function removeBlocks(text, cls) {
  const re = new RegExp('(^|[\\n}])([^{}]*\\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])[^{}]*)\\{([^{}]*)\\}', 'g');
  let out = text;
  let count = 0;
  let m;
  while ((m = re.exec(out))) {
    const whole = m[0];
    const selector = m[2];
    // 只删"这个类作为主选择器"的块；不删 .foo .cls 这种从属规则（父类还在用）
    const ownSel = selector.split(',').map(s => s.trim()).filter(s => s.length);
    const allOwn = ownSel.every(s => {
      // 允许 .cls、.cls.on、.cls:hover、.cls[data-x]、.cls + .cls
      const parts = s.split(/\s+/);
      return parts.length <= 2 && parts.every(p => new RegExp('\\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(p) || p === '+' || p === '>' || p === '~');
    });
    if (!allOwn) { re.lastIndex = m.index + 1; continue; }
    out = out.slice(0, m.index) + (m[1] === '}' ? '}' : '') + out.slice(m.index + whole.length);
    count++;
    re.lastIndex = 0;
  }
  return { out, count };
}

for (const cls of DEAD) {
  const r = removeBlocks(src, cls);
  src = r.out;
  removed += r.count;
}
fs.writeFileSync(FILE, src);
console.log('removed blocks:', removed);
