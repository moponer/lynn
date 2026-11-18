
const fs = require('fs');
const FILES = [
  'src/renderer/styles/dispatch.css',
  'src/renderer/styles/components.css',
  'src/renderer/console/console.css',
  'src/renderer/styles/capture.css',
];
// 13 档刻度的 px 值 -> 令牌名
const SCALE = [
  [2,'--sp-1'],[3,'--sp-2'],[4,'--sp-3'],[6,'--sp-4'],[8,'--sp-5'],
  [10,'--sp-6'],[12,'--sp-7'],[14,'--sp-8'],[16,'--sp-9'],[20,'--sp-10'],
  [24,'--sp-11'],[32,'--sp-12'],[40,'--sp-13'],
];
// 最近档：把 5/7/9/11/13/18/22 这类"没有名字"的值吸附到刻度上。
// 这是收敛，不是失真：相邻档差 2px，肉眼不可辨，但从此有名字、可被统一调整。
function nearest(n) {
  let best = SCALE[0], bd = Infinity;
  for (const s of SCALE) {
    const d = Math.abs(s[0] - n);
    if (d < bd) { bd = d; best = s; }
  }
  return best[1];
}
let changed = 0;
for (const f of FILES) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  src = src.replace(
    /(^|[;{\s])((?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?)\s*:\s*([^;}]+)/g,
    (full, pre, prop, value) => {
      const nv = value.replace(/(^|[\s(])(\d+)px/g, (m, ws, n) => {
        const v = Number(n);
        if (v === 0 || v === 1 || v === 2) return m;
        return ws + 'var(' + nearest(v) + ')';
      });
      return pre + prop + ': ' + nv;
    }
  );
  if (src !== before) { fs.writeFileSync(f, src); changed++; console.log('rounded:', f); }
}
console.log('files:', changed);
