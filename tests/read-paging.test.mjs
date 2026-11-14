// read_file 分页（2026-11-14）：大文件按行读，头里写清区间与总行数，尾部给下一页 offset。
// 小文件且没点名分页时保持原样返回——不动既有调用方的输出。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-read-"));
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("小文件不传参数：原样返回，不加头不加尾", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.txt"), "hello\nworld\n");
  const tk = new Toolkit(root);
  assert.equal(await tk.execute("read_file", { path: "a.txt" }), "hello\nworld\n");
});

test("offset/limit：返回指定区间，并提示还没读完", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "b.txt"), lines(10));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "b.txt", offset: 3, limit: 2 });
  assert.match(out, /第 3-4 行 \/ 共 10 行/);
  assert.match(out, /line 3\nline 4/);
  assert.match(out, /offset=5/);
});

test("超过 400 行自动分页：头写清区间，尾给下一页", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "big.txt"), lines(450));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "big.txt" });
  assert.match(out, /第 1-400 行 \/ 共 450 行/);
  assert.match(out, /offset=401/);
  assert.ok(out.includes("line 400"), "第 400 行要在");
  assert.ok(!out.includes("line 401"), "不该越过这一页");
});

test("limit 被钳到 2000 行上限", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "huge.txt"), lines(2500));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "huge.txt", limit: 9000 });
  assert.match(out, /第 1-2000 行 \/ 共 2500 行/);
});

test("offset 超范围：如实说共几行，不返回空内容假装读到了", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "c.txt"), lines(3));
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: "c.txt", offset: 99 });
  assert.match(out, /只有 3 行/);
  assert.match(out, /从 1 开始/);
});

test("二进制仍然拒读（分页不影响这条）", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "d.bin"), Buffer.from([1, 0, 2, 3]));
  const tk = new Toolkit(root);
  await assert.rejects(() => Promise.resolve(tk.execute("read_file", { path: "d.bin" })), /二进制/);
});
