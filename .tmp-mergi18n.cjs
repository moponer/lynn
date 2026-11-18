
const fs = require('fs');
const FILE = 'src/shared/i18n-strings.ts';
let src = fs.readFileSync(FILE, 'utf8');
const ZH = JSON.parse(fs.readFileSync('.tmp-i18n-zh.json', 'utf8'));
const EN = JSON.parse(fs.readFileSync('.tmp-i18n-en.json', 'utf8'));

// 已有 key 不重复插入
function existingKeys(block) {
  const set = new Set();
  for (const m of block.matchAll(/^\s*"([\w.]+)"\s*:/gm)) set.add(m[1]);
  return set;
}

// ZH_STRINGS 的结尾：第一个 "};" 出现在 EN_STRINGS 声明之前
const enIdx = src.indexOf('export const EN_STRINGS');
const zhBlock = src.slice(0, enIdx);
const zhEnd = zhBlock.lastIndexOf('};');
const zhHave = existingKeys(zhBlock);
const zhAdd = Object.entries(ZH).filter(([k]) => !zhHave.has(k));
const zhText = '\n  // ===== 控制台与通用补充（2026-11-18 设计系统重建时补齐）=====\n' +
  zhAdd.map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',').join('\n') + '\n';
src = src.slice(0, zhEnd) + zhText + src.slice(zhEnd);

// EN_STRINGS：找它的结尾（文件末尾的 "};"）
const enIdx2 = src.indexOf('export const EN_STRINGS');
const enBlock = src.slice(enIdx2);
const enEnd = enBlock.lastIndexOf('};');
const enHave = existingKeys(enBlock);
const enAdd = Object.entries(EN).filter(([k]) => !enHave.has(k));
const enText = '\n  // ===== Console & shared (added 2026-11-18) =====\n' +
  enAdd.map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',').join('\n') + '\n';
src = src.slice(0, enIdx2 + enEnd) + enText + src.slice(enIdx2 + enEnd);

fs.writeFileSync(FILE, src);
console.log('zh added:', zhAdd.length, 'en added:', enAdd.length);
