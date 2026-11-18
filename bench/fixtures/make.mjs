#!/usr/bin/env node
/**
 * 生成基准素材（确定性，可重复跑）。
 * 全部落在 bench/ 下，不进 ~/.lynn，也不影响主仓库测试。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const write = (rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
};

// ---------- B1：销售 CSV ----------
const regions = ["华东", "华南", "华北", "西南", "东北"];
const rows = regions.map((r, i) => ({ region: r, amount: 12000 + i * 3500, orders: 30 + i * 7 }));
const total = rows.reduce((s, r) => s + r.amount, 0);
write("input/sales.csv", ["区域,销售额,订单数", ...rows.map((r) => `${r.region},${r.amount},${r.orders}`), `合计,${total},${rows.reduce((s, r) => s + r.orders, 0)}`, ""].join("\n"));

// ---------- B2：sum([]) 返回 NaN ----------
write(
  "fixtures/repo-b2/package.json",
  JSON.stringify({ name: "repo-b2", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2),
);
write(
  "fixtures/repo-b2/src/sum.js",
  `export function sum(list) {
  // BUG: 空数组时 reduce 没有初始值，返回 undefined，被 Number() 变成 NaN
  return Number(list.reduce((a, b) => a + b));
}
`,
);
write(
  "fixtures/repo-b2/test/sum.test.js",
  `import test from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

test("空数组返回 0", () => {
  assert.equal(sum([]), 0);
});

test("普通数组求和", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
`,
);

// ---------- B6：slugify 只做了一半 ----------
write(
  "fixtures/repo-b6/package.json",
  JSON.stringify({ name: "repo-b6", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2),
);
write(
  "fixtures/repo-b6/src/slugify.js",
  `export function slugify(text) {
  // 只做了小写，空格与非法字符还没处理（B6 的第一次打回点）
  return String(text).toLowerCase();
}
`,
);
write(
  "fixtures/repo-b6/test/slugify.test.js",
  `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("小写", () => assert.equal(slugify("Hello"), "hello"));
test("空格转连字符", () => assert.equal(slugify("Hello World"), "hello-world"));
test("去掉非字母数字", () => assert.equal(slugify("Hello, World!"), "hello-world"));
`,
);

// ---------- B5：200 个待重命名文件 ----------
const renameDir = path.join(root, "fixtures", "rename");
fs.mkdirSync(renameDir, { recursive: true });
for (let i = 1; i <= 200; i += 1) {
  fs.writeFileSync(path.join(renameDir, `IMG_${String(i).padStart(4, "0")}.JPG`), `placeholder ${i}\n`, "utf-8");
}

// ---------- B4：本地表格页 ----------
const web = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>B4 列表</title></head>
<body>
<table id="list">
<thead><tr><th>名称</th><th>价格</th><th>库存</th></tr></thead>
<tbody>
${[1, 2, 3, 4, 5]
  .map((i) => `<tr><td>商品${i}</td><td>${i * 10}.00</td><td>${100 - i}</td></tr>`)
  .join("\n")}
<tr><td>商品6</td><td>60.00</td><td>94</td></tr>
</tbody></table>
</body></html>
`;
write("fixtures/web/list.html", web);

console.log("素材已生成：");
console.log("  input/sales.csv（合计", total, "）");
console.log("  fixtures/repo-b2 / repo-b6 / rename(200) / web/list.html");
