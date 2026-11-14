// grep 工具（2026-11-14）：include 过滤、大小写选项、命中上限如实说明
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit, globToRegExp } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-grep-"));

test("globToRegExp：**/ 可选前缀，? 单字符", () => {
  const re = globToRegExp("**/*.ts");
  assert.ok(re.test("a.ts"));
  assert.ok(re.test("src/deep/b.ts"));
  assert.ok(!re.test("a.md"));
  assert.ok(globToRegExp("src/?.js").test("src/a.js"));
});

test("基本搜索：返回 文件:行号: 内容，默认忽略大小写", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const Foo = 1;\nconst bar = 2;\n");
  const tk = new Toolkit(root);
  const out = await tk.execute("grep", { pattern: "foo" });
  assert.match(out, /src\/a\.ts:1: const Foo = 1;/);
});

test("include 只搜匹配的文件", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "needle\n");
  fs.writeFileSync(path.join(root, "src", "b.md"), "needle\n");
  const tk = new Toolkit(root);
  const out = await tk.execute("grep", { pattern: "needle", include: "**/*.ts" });
  assert.match(out, /a\.ts/);
  assert.ok(!out.includes("b.md"), "不该搜到 md");
});

test("caseSensitive：打开后 Foo 与 foo 分开", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "c.txt"), "Foo\nfoo\n");
  const tk = new Toolkit(root);
  const insensitive = await tk.execute("grep", { pattern: "Foo" });
  assert.equal(insensitive.split("\n").filter((l) => l.includes("c.txt")).length, 2);
  const strict = await tk.execute("grep", { pattern: "Foo", caseSensitive: true });
  assert.equal(strict.split("\n").filter((l) => l.includes("c.txt")).length, 1);
});

test("命中到上限要如实说可能还有更多", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 130 }, (_, i) => `hit ${i}`).join("\n"));
  const tk = new Toolkit(root);
  const out = await tk.execute("grep", { pattern: "hit" });
  assert.match(out, /已到 120 行上限/);
  assert.equal(out.split("\n").filter((l) => l.startsWith("big.txt:")).length, 120);
});

test("没有匹配就如实说，不返回空字符串", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "d.txt"), "nothing here\n");
  const tk = new Toolkit(root);
  assert.equal(await tk.execute("grep", { pattern: "不存在的东西" }), "没有匹配行。");
});
