// 风铃验收侧独立复核：从原材料直接重算，与交付物对账（不复用成员实现）
import * as fs from "node:fs";

const raw = fs.readFileSync("F:/spiker/lynn/experiments/exp6/material/orders-2026Q3.csv", "utf-8")
  .split(/\r?\n/).filter(Boolean);
const header = raw[0].split(",");
const rows = raw.slice(1).map((l, i) => ({ line: i + 2, c: l.split(",") }));

function normDate(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
function num(s) { return parseFloat(String(s).replace(/[￥,]/g, "").trim()); }

// 独立清洗
const seen = new Set(); const clean = []; let dup = 0; let missAmt = 0; let neg = 0; let emptyCity = 0; let badDate = 0; let yen = 0; let badCols = 0;
for (const { line, c } of rows) {
  if (c.length !== 8) { badCols++; continue; }
  const [id, ds, ch, goods, up, qty, amt, city] = c.map(x => x.trim());
  const d = normDate(ds); if (!d) badDate++;
  if (ds.includes("￥")) yen++;
  if (up.includes("￥") || amt.includes("￥")) yen++;
  if (!amt) missAmt++;
  if (num(qty) < 0) neg++;
  if (!city) emptyCity++;
  if (seen.has(id)) { dup++; continue; }
  seen.add(id);
  const unit = num(up), q = num(qty);
  const a = amt ? num(amt) : unit * q;
  if (amt && Math.abs(a - unit * q) > 1e-9) badDate++; // 金额不一致借用计数
  clean.push({ id, d, ch, goods, unit, q, a });
}
console.log(`原始行=${rows.length} 列异常=${badCols} 坏日期=${badDate} 去重=${dup} 保留=${clean.length} 缺金额=${missAmt} 退货=${neg} 空城市=${emptyCity} ￥=${yen}`);

// 月度重算
const months = {};
for (const r of clean) {
  const m = r.d.slice(0, 7);
  months[m] ??= { gmv: 0, n: 0, ret: 0 };
  months[m].gmv += r.a; months[m].n++; if (r.q < 0) months[m].ret++;
}
let q = 0;
for (const m of Object.keys(months).sort()) {
  console.log(`${m}: GMV=${months[m].gmv.toFixed(2)} 订单=${months[m].n} 退货=${months[m].ret}`);
  q += months[m].gmv;
}
console.log(`季度GMV=${q.toFixed(2)}`);

// 与交付的 clean CSV 对账
const del = fs.readFileSync("F:/spiker/lynn/experiments/exp6/deliverables/orders-clean.csv", "utf-8")
  .split(/\r?\n/).filter(Boolean);
const drows = del.slice(1).map(l => l.split(","));
console.log(`cleanCSV行=${drows.length} 表头=[${del[0]}]`);
let idDup = 0; const ids = new Set();
let fmtBad = 0, amtBad = 0;
const dsum = {};
for (const c of drows) {
  if (ids.has(c[0])) idDup++;
  ids.add(c[0]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c[1])) fmtBad++;
  if (!/^-?\d+\.\d{2}$/.test(c[6])) amtBad++;
  const m = c[1].slice(0, 7);
  dsum[m] ??= { gmv: 0, n: 0 };
  dsum[m].gmv += parseFloat(c[6]); dsum[m].n++;
}
console.log(`cleanCSV 订单号重复=${idDup} 日期格式不良=${fmtBad} 金额格式不良=${amtBad}`);
for (const m of Object.keys(dsum).sort()) console.log(`cleanCSV ${m}: GMV=${dsum[m].gmv.toFixed(2)} 订单=${dsum[m].n}`);
