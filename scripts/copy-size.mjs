// 界面可见文案字数（近似值，用于盯"越写越啰嗦"）：
// 只数 JSX 文本节点与含中文的短字符串，不数注释/类名/import。
import fs from "node:fs";
import path from "node:path";

const roots = ["src/renderer", "src/shared"];
const CJK = /[\u4e00-\u9fa5]/;

function files(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) files(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

let total = 0;
const rows = [];
for (const file of roots.flatMap((r) => files(r))) {
  let src = fs.readFileSync(file, "utf-8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  let n = 0;
  // JSX 文本节点
  for (const m of src.matchAll(/>([^<>{}]{2,})</g)) {
    const t = m[1];
    if (CJK.test(t)) n += [...t].filter((c) => CJK.test(c) || /[\u3000-\u303f\uff00-\uffef]/.test(c)).length;
  }
  // 含中文的字符串字面量（文案常量、title、placeholder）
  for (const m of src.matchAll(/"([^"\n]{2,})"|'([^'\n]{2,})'|`([^`]{2,})`/g)) {
    const t = m[1] ?? m[2] ?? m[3] ?? "";
    if (!CJK.test(t)) continue;
    if (/^[a-z0-9@/.:_-]+$/i.test(t)) continue;
    n += [...t].filter((c) => CJK.test(c) || /[\u3000-\u303f\uff00-\uffef]/.test(c)).length;
  }
  if (n) rows.push([path.relative(".", file).replace(/\\/g, "/"), n]);
  total += n;
}

rows.sort((a, b) => b[1] - a[1]);
for (const [file, n] of rows) console.log(`${String(n).padStart(6)}  ${file}`);
console.log(`${String(total).padStart(6)}  TOTAL（中文可见字数，近似）`);
