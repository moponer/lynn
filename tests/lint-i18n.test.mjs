/**
 * i18n lint（P6-8 / 18 章 F8）。
 *
 * 这条 lint 的价值不在"能查"，而在**不误报**：这个仓库里中文到处都是，
 * 而大部分是对的（注释、日志、断言、内部键）。见中文就报会得到一万条噪音，
 * 那种 lint 没人看，等于没有。
 *
 * 所以测试的重点是**边界**：
 *  - 用户可见的（JSX 文本 / UI 属性 / UI 字段）必须报；
 *  - 注释、日志、内部键、断言**不许报**；
 *  - 豁免必须带理由（豁免是债，不是默认）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scanFile } from "../scripts/lint-i18n.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * 跑 lint 拿 JSON。
 *
 * 注意：lint 在**发现问题时退出码是 1**（CI 要据此拦合并），而 `execFileSync` 见到非零就抛。
 * 这里要的是它的输出，不是它的结论，所以用 `spawnSync` 并把非零当正常。
 */
function lintJson() {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts/lint-i18n.mjs"), "--json"], {
    encoding: "utf8",
    cwd: repo,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ok(r.stdout && r.stdout.trim().startsWith("{"), `lint 没输出 JSON：${r.stderr?.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

test("JSX 文本节点里的中文要报", () => {
  const issues = scanFile("x.tsx", `export const A = () => <b>界面流畅度</b>;`);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "jsx-text");
  assert.match(issues[0].text, /界面流畅度/);
});

test("UI 属性里的中文要报（placeholder / title / aria-label）", () => {
  const a = scanFile("x.tsx", `export const A = () => <input placeholder="请输入路径" />;`);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "jsx-attr");

  const b = scanFile("x.tsx", `export const A = () => <button title="切到工作台" />;`);
  assert.equal(b.length, 1);

  const c = scanFile("x.tsx", `export const A = () => <div aria-label="视图切换" />;`);
  assert.equal(c.length, 1);
});

test("UI 字段里的中文要报（text / label / title / message）", () => {
  const issues = scanFile("x.ts", `const card = { kind: "system", text: "已建团队" };`);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "ui-field");
});

test("注释里的中文**不许**报（这是最大的噪音源）", () => {
  const src = [
    "// 这里是注释，中文随便写",
    "/* 块注释里也是中文 */",
    "export const A = () => <b>{t(\"x\")}</b>;",
  ].join("\n");
  assert.deepEqual(scanFile("x.tsx", src), []);
});

test("日志与断言里的中文**不许**报（开发者看的，不渲染）", () => {
  const src = [
    "console.log(\"启动失败\");",
    "assert.equal(a, b, \"两边应当相等\");",
    "throw new Error(\"路径越界\");",
  ].join("\n");
  assert.deepEqual(scanFile("x.ts", src), [], "日志/断言/抛错不是 UI 文案，报了就是噪音");
});

test("已走 t() 的文案不许报", () => {
  const src = `export const A = () => <b>{t("perf.title")}</b>;`;
  assert.deepEqual(scanFile("x.tsx", src), []);
});

test("单个汉字不算（可能是单位或符号）", () => {
  assert.deepEqual(scanFile("x.tsx", `export const A = () => <span>秒</span>;`), []);
});

test("英文文案不许报", () => {
  assert.deepEqual(scanFile("x.tsx", `export const A = () => <b>Settings</b>;`), []);
});

test("豁免名单每一条都必须写理由（豁免是债，不是默认）", () => {
  const data = lintJson();
  for (const e of data.exempt) {
    assert.ok(e.file && e.why, `豁免项缺 file 或 why：${JSON.stringify(e)}`);
    assert.ok(e.why.length >= 6, `${e.file} 的豁免理由太短，看不出为什么`);
  }
  // 豁免文件必须真实存在，否则是陈旧条目
  for (const e of data.exempt) {
    assert.ok(fs.existsSync(path.join(repo, e.file)), `豁免的 ${e.file} 不存在了，该删掉这条`);
  }
});

test("扫描范围覆盖渲染层（不是空扫）", () => {
  const data = lintJson();
  assert.ok(data.scanned >= 50, `只扫到 ${data.scanned} 个文件，范围不对`);
  assert.ok(Array.isArray(data.issues));
});

/**
 * 这一条是**技术债的量化**，不是"必须为 0"的断言。
 *
 * 2026-11-17 首次跑出 289 处，分布在 25 个文件。改完它要动 25 个文件里的
 * 每一处用户可见文案（搬进 i18n-strings.ts），那是一轮独立工作。
 * 所以这里锁的是**不许变多**：新增写死中文会立刻失败，存量可以分批还。
 */
test("技术债不许增加：写死中文的处数有上限（存量分批还，但不许再涨）", () => {
  const data = lintJson();
  const count = data.issues.length;
  const BUDGET = 284; // 2026-11-17 实测（从 289 降到 284）；只许往下调，不许往上
  assert.ok(
    count <= BUDGET,
    `写死的用户可见中文从 ${BUDGET} 涨到了 ${count}：新增文案请直接走 t()，不要再加写死的`,
  );
  if (count < BUDGET) {
    console.log(`  提示：已降到 ${count}（预算 ${BUDGET}），可以把 BUDGET 调低锁住成果`);
  }
});