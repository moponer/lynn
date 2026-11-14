// edit_file 的 patch 模式（2026-11-14）：unified diff 交给 jsdiff 应用。
// 锁四件事：带上下文能改对、上下文对不上整条拒、多段一次改完、路径钉扎不因新参数松动。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-patch-"));
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("patch 模式：带上下文行的 unified diff 能改对地方", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const tk = new Toolkit(root);
  const patch = [
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 20;",
    " const c = 3;",
  ].join("\n");
  const out = await tk.editFile({ path: "a.ts", patch });
  assert.match(out, /已打补丁/);
  assert.equal(read(root, "a.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
});

test("上下文对不上：整条拒，文件一个字节都不动", async () => {
  const root = tmp();
  const original = "x = 1\ny = 2\nz = 3\n";
  fs.writeFileSync(path.join(root, "b.txt"), original);
  const tk = new Toolkit(root);
  const patch = [
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1,3 +1,3 @@",
    " totally",
    "-different",
    "+content",
    " here",
  ].join("\n");
  await assert.rejects(() => tk.editFile({ path: "b.txt", patch }), /上下文对不上/);
  assert.equal(read(root, "b.txt"), original, "拒绝时不能留半截写入");
});

test("多段补丁一次改完（两处相隔很远）", async () => {
  const root = tmp();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(root, "c.txt"), `${lines.join("\n")}\n`);
  const tk = new Toolkit(root);
  const patch = [
    "--- a/c.txt",
    "+++ b/c.txt",
    "@@ -1,3 +1,3 @@",
    " line 1",
    "-line 2",
    "+line 2 changed",
    " line 3",
    "@@ -18,3 +18,3 @@",
    " line 18",
    "-line 19",
    "+line 19 changed",
    " line 20",
  ].join("\n");
  await tk.editFile({ path: "c.txt", patch });
  const after = read(root, "c.txt").split("\n");
  assert.equal(after[1], "line 2 changed");
  assert.equal(after[18], "line 19 changed");
  assert.equal(after.length, 21, "行数不变");
});

test("旧写法不受影响（old_string / new_string 仍然可用）", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "d.txt"), "hello world\n");
  const tk = new Toolkit(root);
  const out = await tk.editFile({ path: "d.txt", old_string: "world", new_string: "lynn" });
  assert.match(out, /已改/);
  assert.equal(read(root, "d.txt"), "hello lynn\n");
});

test("patch 也走 resolveWithin：越界路径照样拒", async () => {
  const root = tmp();
  const tk = new Toolkit(root);
  const patch = ["--- a/evil.txt", "+++ b/evil.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
  await assert.rejects(() => tk.editFile({ path: "../evil.txt", patch }), /工作区|越界|逃逸/);
});

test("补丁没有实际改动时如实说，不谎报已改", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "e.txt"), "same\n");
  const tk = new Toolkit(root);
  const patch = ["--- a/e.txt", "+++ b/e.txt", "@@ -1,1 +1,1 @@", "-same", "+same"].join("\n");
  const out = await tk.editFile({ path: "e.txt", patch });
  assert.match(out, /没有产生任何改动/);
});
