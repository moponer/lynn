// 零依赖 docx 生成器（2026-11-11）：zip 结构、OOXML 部件、转义与工具层路径约束。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { buildDocx, planTableColumns } from "../dist/main/docx.js";
import { Toolkit } from "../dist/main/toolkit.js";

/** 极简 zip 读取器：只为验证我们写出的包能被标准方式解出来。 */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "找不到 zip 目录尾部");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, "中央目录签名不对");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, "本地头签名不对");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const SAMPLE = {
  title: "漏洞管理",
  footerText: "内部资料",
  blocks: [
    { type: "heading", level: 1, text: "总览" },
    { type: "paragraph", text: "第一行\n第二行 & <特殊> \"引号\"" },
    { type: "bullet", text: "越权访问" },
    { type: "table", headers: ["编号", "漏洞", "等级"], rows: [["1", "越权访问", "高"]] },
  ],
};

test("buildDocx：产出可解压的完整 OOXML 包，部件齐全", () => {
  const files = unzip(buildDocx(SAMPLE));
  for (const name of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/_rels/document.xml.rels",
    "word/styles.xml",
    "word/settings.xml",
    "word/footer1.xml",
  ]) {
    assert.ok(files.has(name), `缺部件：${name}`);
  }
  const types = files.get("[Content_Types].xml").toString("utf8");
  assert.match(types, /word\/document\.xml/);
  assert.match(types, /word\/footer1\.xml/);
  assert.match(files.get("word/_rels/document.xml.rels").toString("utf8"), /footer1\.xml/);
});

test("buildDocx：标题/段落/表格/转义都正确进入 document.xml", () => {
  const doc = unzip(buildDocx(SAMPLE)).get("word/document.xml").toString("utf8");
  assert.match(doc, /<w:t xml:space="preserve">漏洞管理<\/w:t>/);
  assert.match(doc, /总览/);
  assert.match(doc, /<w:br\/>/, "换行要转成 w:br");
  assert.match(doc, /&amp; &lt;特殊&gt; &quot;引号&quot;/, "XML 特殊字符必须转义");
  assert.match(doc, /<w:tbl>/, "表格要落成 w:tbl");
  assert.match(doc, /越权访问/);
  assert.equal((doc.match(/<w:tr>/g) ?? []).length, 2, "表头 + 一行数据");
  assert.equal((doc.match(/<w:p>/g) ?? []).length, (doc.match(/<\/w:p>/g) ?? []).length, "段落标签平衡");
  assert.match(doc, /<w:pgMar /, "页面边距要写进 sectPr");
});

test("buildDocx：表格带 tblGrid + 100% 宽 + 固定布局（否则 Word 把每列压成一个字）", () => {
  const doc = unzip(buildDocx(SAMPLE)).get("word/document.xml").toString("utf8");
  assert.match(doc, /<w:tblGrid>/, "必须有列网格：没有它 Word 按 1 字宽排，中文表格会竖排");
  assert.equal((doc.match(/<w:gridCol /g) ?? []).length, 3, "三列各一条 gridCol");
  assert.match(doc, /<w:tblW w:w="5000" w:type="pct"\/>/, "表宽撑满正文（100%）");
  assert.match(doc, /<w:tblLayout w:type="fixed"\/>/, "列宽只认 tblGrid，不让 Word 自动猜");
  // 列宽之和 = A4 正文宽度（11906 - 1440*2），避免表格超页或半页
  const widths = [...doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(
    widths.reduce((a, b) => a + b, 0),
    11906 - 1440 * 2,
    `列宽总和应等于正文宽度，实际 ${widths.join("+")}`,
  );
  assert.ok(widths.every((w) => w >= 600), "每列都要有下限，避免标题逐字换行");
  assert.match(doc, /<w:tblHeader\/>/, "表头行跨页重复");
  assert.match(doc, /<w:cantSplit\/>/, "行不跨页断开");
});

test("planTableColumns：按内容分配列宽，长文本列更宽、总和恰为正文宽度", () => {
  const plan = planTableColumns([
    ["编号", "漏洞说明", "等级"],
    ["1", "订单导出接口未校验归属，任意用户可拉取他人订单明细数据", "高"],
  ]);
  assert.equal(plan.length, 3);
  assert.ok(plan[1] > plan[0], "内容最长的那列要更宽");
  assert.equal(plan.reduce((a, b) => a + b, 0), 11906 - 1440 * 2);
});

test("buildDocx：空内容 / 空表格 / 未知类型 / 占位符都如实报错", () => {
  assert.throws(() => buildDocx({ blocks: [] }), /blocks 不能为空/);
  assert.throws(() => buildDocx({ blocks: [{ type: "table", rows: [] }] }), /至少要给 headers 或 rows/);
  assert.throws(() => buildDocx({ blocks: [{ type: "video", text: "x" }] }), /不支持的 block 类型/);
  // 2026-11-12 实机：模板变量没取到值，文档里印出「• undefined」
  assert.throws(
    () => buildDocx({ blocks: [{ type: "bullet", text: "undefined" }] }),
    /通常是模板变量没取到值/,
  );
  assert.throws(() => buildDocx({ blocks: [{ type: "paragraph", text: "   " }] }), /text 是空的/);
  assert.throws(() => buildDocx({ title: "null", blocks: [{ type: "paragraph", text: "x" }] }), /title 是/);
});

test("Toolkit：写入工作区、非 .docx 与越界路径拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-docx-"));
  const tk = new Toolkit(root);
  const ok = await tk.execute("office_write_docx", {
    path: "reports/漏洞管理.docx",
    title: "漏洞管理",
    blocks: [{ type: "paragraph", text: "一句话" }],
  });
  assert.match(ok, /已写入/);
  const full = path.join(root, "reports", "漏洞管理.docx");
  assert.ok(fs.existsSync(full));
  const files = unzip(fs.readFileSync(full));
  assert.match(files.get("word/document.xml").toString("utf8"), /一句话/);

  assert.match(await tk.execute("office_write_docx", { path: "a.txt", blocks: [{ type: "paragraph", text: "x" }] }), /必须以 \.docx 结尾/);
  assert.match(
    await tk.execute("office_write_docx", { path: "../escape.docx", blocks: [{ type: "paragraph", text: "x" }] }),
    /路径越界/,
  );
});
