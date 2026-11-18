
const fs = require('fs');
const FILE = 'src/renderer/styles/dispatch.css';
let src = fs.readFileSync(FILE, 'utf8');

// 找出所有 "selector { body }" 的位置（跳过注释与 @ 规则内部）
function blocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    // 跳过注释
    if (text[i] === '/' && text[i+1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const open = text.indexOf('{', i);
    if (open === -1) break;
    // 选择器文本 = 从 i 到 open，其中可能含注释
    const rawSel = text.slice(i, open);
    const cleanSel = rawSel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    out.push({ start: i, selStart: i, open, end: j, sel: cleanSel, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const isAt = s => s.startsWith('@') || s.startsWith('from') || s.startsWith('to') || /^\d+%$/.test(s);
const props = b => b.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split(':')[0].trim());

// 找到"同一选择器 + 重复属性"的后出现的块，只删掉重复的那几条声明；
// 若删完块为空则整块删除。这样不丢注释、不动顺序。
let guard = 0;
while (guard++ < 200) {
  const bs = blocks(src).filter(b => !isAt(b.sel) && b.sel.length);
  const seen = new Map(); // sel -> Set(props)
  let target = null;
  for (const b of bs) {
    const ps = props(b.body);
    if (!seen.has(b.sel)) { seen.set(b.sel, new Set(ps)); continue; }
    const have = seen.get(b.sel);
    const dup = ps.filter(p => have.has(p));
    if (dup.length) { target = { b, dup }; break; }
    ps.forEach(p => have.add(p));
  }
  if (!target) break;

  const { b, dup } = target;
  // 从 body 里移除重复声明（保留顺序与注释）
  const parts = b.body.split(';');
  const kept = [];
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    const p = t.split(':')[0].trim();
    if (dup.includes(p)) continue;
    kept.push(raw);
  }
  const newBody = kept.join(';');
  if (newBody.trim() === '') {
    // 整块删除（连同前面的空白与紧邻注释）
    let s = b.start;
    while (s > 0 && /\s/.test(src[s - 1])) s--;
    src = src.slice(0, s) + src.slice(b.end);
  } else {
    src = src.slice(0, b.open + 1) + newBody + src.slice(b.end - 1);
  }
}
fs.writeFileSync(FILE, src);
console.log('dedupe done, lines:', src.split('\n').length);
