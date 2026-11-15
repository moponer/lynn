// 成员回报展示（2026-11-15）的源码级回归：
// 这三条都是"看起来对、实际被别的规则盖住"的坑，光靠肉眼走查很难每次都验到。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const feed = fs.readFileSync(path.join(root, "src/renderer/desk/Feed.tsx"), "utf-8");
const css = fs.readFileSync(path.join(root, "src/renderer/styles/dispatch.css"), "utf-8");
const rich = fs.readFileSync(path.join(root, "src/renderer/components/RichText.tsx"), "utf-8");

test("回报正文：不再按字数硬切 Markdown（切在表格行中间会渲染出一张残表）", () => {
  assert.ok(!/\.slice\(\s*0\s*,\s*LIMIT\s*\)/.test(feed), "正文不该再按字数截断");
  assert.ok(!/const LIMIT = 420/.test(feed), "截断常量应已删除");
  assert.match(feed, /feed-fold\$\{long \? " long" : ""\}/, "折叠状态要落在 feed-fold 的 class 上（long/open）");
  assert.match(feed, /onDoubleClick=/, "双击正文也该能开关全文");
});

test("展开全文必须真解除限高：折叠正文的默认态不限高，且规则排在工具卡限高之后", () => {
  const toolIdx = css.indexOf(".feed-item.tool .feed-body {");
  const baseIdx = css.indexOf(".feed-item .feed-fold > .feed-body {");
  assert.ok(toolIdx > -1, "工具卡正文的限高规则仍在（短正文靠它定基调）");
  assert.ok(baseIdx > toolIdx, "折叠正文规则必须写在工具卡限高之后，否则同权重被盖回 320px");
  const base = css.slice(baseIdx, css.indexOf("}", baseIdx));
  assert.match(base, /max-height:\s*none/, "展开态（默认）不能被限高");
  assert.match(base, /overflow:\s*visible/);
  // 只有"收起 + 长文"才裁切
  const closed = css.slice(css.indexOf(".feed-item .feed-fold.long:not(.open) > .feed-body {"));
  const closedBlock = closed.slice(0, closed.indexOf("}"));
  assert.match(closedBlock, /max-height:\s*300px/);
  assert.match(closedBlock, /overflow:\s*hidden/);
});

test("表格排版：外层横向滚动壳 + 单元格不继承 anywhere + 表头不折行", () => {
  assert.match(rich, /md-table-wrap/, "表格要有横向滚动壳，放不下时整表滚而不是把列压扁");
  const wrap = /\.md-table-wrap \{([^}]*)\}/.exec(css);
  assert.ok(wrap, "缺 .md-table-wrap 规则");
  assert.match(wrap[1], /overflow-x:\s*auto/);
  assert.match(wrap[1], /min-width:\s*0/, "flex 子项不设 min-width:0 时滚动壳会被 min-content 撑宽，滚动永远不触发");
  const cells = /\.md th, \.md td \{([^}]*)\}/.exec(css);
  assert.ok(cells, "缺 .md th, .md td 规则");
  assert.match(cells[1], /overflow-wrap:\s*normal/, "继承 .feed-body 的 anywhere 会把词切成两半");
  assert.match(cells[1], /word-break:\s*normal/);
  assert.match(cells[1], /min-width:/, "列要有最小宽度，表头才不会竖排");
  const th = /\.md th \{([^}]*)\}/.exec(css);
  assert.ok(th && /white-space:\s*nowrap/.test(th[1]), "表头必须 nowrap");
});
