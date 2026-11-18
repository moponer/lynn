
const fs = require('fs');
const FILES = [
  'src/renderer/styles/dispatch.css',
  'src/renderer/styles/components.css',
  'src/renderer/console/console.css',
  'src/renderer/styles/capture.css',
];
// z-index 字面值 -> 令牌。映射按"这一层是什么"而不是按数值大小：
//   0/1/2 内部层叠（不参与全局）→ 保留字面值（局部上下文）
//   3/4/5/6/7/8/10  sticky/局部浮层 → --z-sticky
//   20 顶栏 → --z-rail
//   29/30 抽屉与遮罩 → --z-drawer
//   40 浮层 → --z-drawer（与抽屉同层）
//   60 弹层（菜单/命令面板/用量）→ --z-pop
//   80/90 toast/预览 → --z-menu / --z-modal
//   120/200 确认卡 → --z-modal
const Z = {
  3: '--z-sticky', 4: '--z-sticky', 5: '--z-sticky', 6: '--z-sticky',
  7: '--z-sticky', 8: '--z-sticky', 10: '--z-sticky',
  20: '--z-rail', 29: '--z-drawer', 30: '--z-drawer', 40: '--z-drawer',
  60: '--z-pop', 80: '--z-menu', 90: '--z-modal', 120: '--z-modal', 200: '--z-modal',
};
let changed = 0;
for (const f of FILES) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  src = src.replace(/z-index:\s*(-?\d+)(?=\s*[;}])/g, (m, n) => {
    const v = Number(n);
    if (v === 0 || v === 1 || v === 2) return m; // 局部层叠上下文，不进全局阶梯
    const tok = Z[v];
    return tok ? 'z-index: var(' + tok + ')' : m;
  });
  if (src !== before) { fs.writeFileSync(f, src); changed++; console.log('z migrated:', f); }
}
console.log('files:', changed);
