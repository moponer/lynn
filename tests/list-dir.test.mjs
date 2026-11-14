// list_dir（2026-11-14）：带大小与修改时间，成员据此判断哪个文件是刚改的/空壳
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ls-"));

test("目录带 [目录] 标记，文件带大小与时间", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "small.txt"), "hi");
  fs.writeFileSync(path.join(root, "big.bin"), "x".repeat(2048));
  const tk = new Toolkit(root);
  const out = tk.listDir({});
  assert.match(out, /\[目录\] sub/);
  assert.match(out, /2B\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+small\.txt/);
  assert.match(out, /2\.0KB\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+big\.bin/);
});

test("空目录如实说", () => {
  const tk = new Toolkit(tmp());
  assert.equal(tk.listDir({}), "（空目录）");
});

test("排序稳定（按名字）", () => {
  const root = tmp();
  for (const n of ["b.txt", "a.txt", "c.txt"]) fs.writeFileSync(path.join(root, n), "x");
  const lines = new Toolkit(root).listDir({}).split("\n");
  assert.deepEqual(
    lines.map((l) => l.trim().split(/\s{2,}/).pop()),
    ["a.txt", "b.txt", "c.txt"],
  );
});
