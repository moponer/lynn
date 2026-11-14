// PDF 读取（2026-11-14）：pdfjs 提文本，扫描件如实说提取不到。
// 测试自己拼一个最小合法 PDF（含正确 xref），不引额外的 PDF 生成库。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pdf-"));

function makePdf(text) {
  const content = `BT /F1 24 Tf 50 700 Td (${text}) Tj ET`;
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("PDF 走文本提取：返回页数头 + 真实文字", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "doc.pdf"), makePdf("Hello Lynn PDF"));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "doc.pdf" });
  assert.match(out, /\[PDF · 1 页\]/);
  assert.match(out, /Hello Lynn PDF/);
  assert.ok(!out.includes("%PDF-1.4"), "不能把二进制原文吐出来");
});

test("非 PDF 的二进制仍然拒读（PDF 分支不能把检查放开）", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.bin"), Buffer.from([1, 0, 2, 3]));
  const tk = new Toolkit(root);
  await assert.rejects(() => tk.execute("read_file", { path: "a.bin" }), /二进制/);
});

test("坏 PDF 如实报解析失败，不当文本读", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "broken.pdf"), Buffer.from("%PDF-1.4\n这不是真的 PDF", "latin1"));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "broken.pdf" });
  assert.match(out, /PDF/);
  assert.match(out, /解析失败|提取不到/);
});
