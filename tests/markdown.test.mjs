// 聊天输出的极简 Markdown：只解析结构，不产出 HTML
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, inlineOf } from "../dist/shared/markdown.js";

test("行内：粗体/行内代码保留，斜体只去标记（正文禁止斜体）", () => {
  const spans = inlineOf("收到 **重点** 和 `code`，还有 *旁注* 与 _强调_");
  assert.deepEqual(
    spans.map((s) => [s.t, s.v]),
    [
      ["text", "收到 "],
      ["strong", "重点"],
      ["text", " 和 "],
      ["code", "code"],
      ["text", "，还有 "],
      ["text", "旁注"],
      ["text", " 与 "],
      ["text", "强调"],
    ],
  );
});

test("半截标记不吞字（流式未闭合）", () => {
  const spans = inlineOf("**还没闭合");
  assert.equal(spans.map((s) => s.v).join(""), "**还没闭合");
});

test("编号列表成块：连续的 1. 2. 3. 合成一个 ol", () => {
  const md = [
    "收到，我拆三步：",
    "",
    "1. 派单 A",
    "2. 派单 B",
    "3. 收款",
    "",
    "完事我再报。",
  ].join("\n");
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.t), ["p", "ol", "p"]);
  assert.equal(blocks[1].items.length, 3);
  assert.equal(blocks[1].items[2][0].v, "收款");
});

test("无序列表 + 缩进续行：并进上一条，不另起段落", () => {
  const blocks = parseMarkdown("- 第一项\n- 第二项\n  补充说明\n\n收尾段");
  assert.deepEqual(blocks.map((b) => b.t), ["ul", "p"]);
  const second = blocks[0].items[1].map((s) => s.v).join("");
  assert.equal(second, "第二项\n补充说明");
});

test("围栏代码块原样保留；未闭合也照原样收到结尾", () => {
  const blocks = parseMarkdown("先看：\n```ts\nconst a = 1;\n```\n后记");
  assert.deepEqual(blocks.map((b) => b.t), ["p", "code", "p"]);
  assert.equal(blocks[1].lang, "ts");
  assert.equal(blocks[1].v, "const a = 1;");

  const open = parseMarkdown("```\n一直在流");
  assert.equal(open[0].t, "code");
  assert.equal(open[0].v, "一直在流");
});

test("标题 / 引用 / 分隔线 / 段内换行", () => {
  const blocks = parseMarkdown("## 小节\n> 引用一句\n---\n第一行\n第二行");
  assert.deepEqual(blocks.map((b) => b.t), ["h", "quote", "hr", "p"]);
  assert.equal(blocks[0].level, 2);
  // 段内单换行保留成 \n，渲染层用 white-space: pre-wrap 呈现
  const para = blocks[3].spans.map((s) => s.v).join("");
  assert.equal(para, "第一行\n第二行");
});
