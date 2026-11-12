// .docx 读取器（2026-11-12）：内置预览与 read_artifact 都靠它把 Word 正文读出来。
// 没有它，预览里 .docx 只能显示「二进制，没有内置预览」，验收也只能看文件名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocx } from "../dist/main/docx.js";
import { readDocx, readDocxText, readZipEntry, parseDocxBlocks } from "../dist/main/docx-read.js";

const doc = () =>
  buildDocx({
    title: "漏洞文档测试",
    blocks: [
      { type: "heading", level: 1, text: "第一章 漏洞发现" },
      { type: "paragraph", text: "第一行\n第二行 & <特殊>" },
      { type: "bullet", text: "越权访问" },
      { type: "table", headers: ["编号", "处置动作"], rows: [["DEMO-1", "查模板参数化"]] },
    ],
  });

test("readDocx：标题/段落/列表/表格都读得出来，特殊字符按原文保留", () => {
  const r = readDocx(doc());
  assert.ok(r.blocks >= 4, `应解析出至少 4 个块，实际 ${r.blocks}`);
  assert.match(r.html, /<h1>第一章 漏洞发现<\/h1>/);
  assert.match(r.html, /<table[\s>]/, "表格要落成 table（允许带 style 属性）");
  assert.match(r.html, /<th>编号<\/th>/, "表头行用 th");
  assert.match(r.html, /<td>DEMO-1<\/td>/);
  assert.match(r.html, /<colgroup><col style="width:/, "列宽按 tblGrid 还原，预览与 Word 排版一致");
  assert.match(r.html, /&amp; &lt;特殊&gt;/, "HTML 里必须转义");
  assert.match(r.text, /第一章 漏洞发现/);
  assert.match(r.text, /- 越权访问/);
  assert.match(r.text, /\| 编号 \| 处置动作 \|/, "纯文本里表格按列读得出");
  assert.match(r.text, /第二行/, "段内换行要保留");
  assert.match(r.text, /& <特殊>/, "纯文本不做 HTML 转义");
});

test("readDocx：空正文如实标注，不假装有内容", () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p></w:body></w:document>`;
  const blocks = parseDocxBlocks(xml);
  assert.equal(blocks.length, 0, "空段落不占位");
});

test("readDocx：不是 docx 就抛错（调用方降级成二进制，不拿乱码冒充正文）", () => {
  assert.throws(() => readDocx(Buffer.from("这不是一个 zip 包", "utf8")), /读不出|没有|zip/i);
  assert.equal(readZipEntry(Buffer.from("x"), "word/document.xml"), null);
  // 有 zip 但缺 word/document.xml
  const fake = buildDocx({ blocks: [{ type: "paragraph", text: "x" }] });
  assert.ok(readZipEntry(fake, "word/document.xml"), "正常包能取到 document.xml");
});

test("readDocxText：只返回正文（read_artifact 直接用）", () => {
  const text = readDocxText(doc());
  assert.match(text, /DEMO-1/);
  assert.ok(!text.includes("<h1>"), "返回的是纯文本，不是 HTML");
});
