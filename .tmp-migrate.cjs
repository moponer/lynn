
const fs = require('fs');
const FILES = [
  'src/renderer/styles/dispatch.css',
  'src/renderer/styles/components.css',
  'src/renderer/console/console.css',
  'src/renderer/styles/capture.css',
];
const SCALE = [
  [2,'--sp-1'],[3,'--sp-2'],[4,'--sp-3'],[6,'--sp-4'],[8,'--sp-5'],
  [10,'--sp-6'],[12,'--sp-7'],[14,'--sp-8'],[16,'--sp-9'],[20,'--sp-10'],
  [24,'--sp-11'],[32,'--sp-12'],[40,'--sp-13'],
];
function nearest(n) {
  let best = SCALE[0], bd = Infinity;
  for (const s of SCALE) { const d = Math.abs(s[0] - n); if (d < bd) { bd = d; best = s; } }
  return best[1];
}
// z-index 字面值 -> 令牌
const Z = { 3:'--z-sticky',4:'--z-sticky',5:'--z-sticky',6:'--z-sticky',7:'--z-sticky',8:'--z-sticky',10:'--z-sticky',
  20:'--z-rail',29:'--z-drawer',30:'--z-drawer',40:'--z-drawer',60:'--z-pop',80:'--z-menu',90:'--z-modal',120:'--z-modal',200:'--z-modal' };

for (const f of FILES) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;

  // 间距：padding / margin / gap 族里的裸 px -> 令牌（0/1/2 保留）
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

  // z-index -> 令牌（局部 0/1/2/auto 保留）
  src = src.replace(/z-index:\s*(-?\d+)(?=\s*[;}])/g, (m, n) => {
    const v = Number(n);
    if (v === 0 || v === 1 || v === 2) return m;
    const tok = Z[v];
    return tok ? 'z-index: var(' + tok + ')' : m;
  });

  if (src !== before) { fs.writeFileSync(f, src); console.log('migrated:', f); }
}
console.log('done');
