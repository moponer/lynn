// Toolkit realpath containment：已存在目标双侧 realpath，新文件看最近已存在祖先，异常链接不放行。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { insideBase } from "../dist/main/path-guard.js";
import { resolveReadable, resolveWithin, Toolkit } from "../dist/main/toolkit.js";

const tmp = (prefix = "lynn-p1-toolkit-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function expectErrorText(run, pattern) {
  let text;
  try {
    // 某些 Toolkit 分支返回错误字符串，另一些 reject Error；两种都统一成文本断言。
    text = String(await run());
  } catch (err) {
    text = String(err);
  }
  assert.match(text, pattern);
}

function linkOrSkip(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    t.skip(`当前环境无权创建符号链接：${String(err)}`);
    return false;
  }
}

test("新文件沿最近已存在祖先判定；普通越界仍拒绝", async () => {
  const root = tmp();
  const nested = path.join(root, "not-created", "deep", "file.md");
  assert.equal(resolveWithin(root, path.relative(root, nested)), nested);
  await expectErrorText(async () => resolveWithin(root, "../outside.md"), /路径越界/);
  const toolkit = new Toolkit(root);
  await toolkit.writeFile({ path: "new-dir/ok.md", content: "ok" });
  assert.equal(fs.readFileSync(path.join(root, "new-dir", "ok.md"), "utf-8"), "ok");
});

test("已存在文件链接与目录链接指向根外时，读、写及新文件都不能逃逸", async (t) => {
  const root = tmp();
  const outside = tmp("lynn-p1-toolkit-outside-");
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  const fileLink = path.join(root, "file-link.md");
  const dirLink = path.join(root, "dir-link");
  if (!linkOrSkip(t, path.join(outside, "secret.md"), fileLink)) return;
  if (!linkOrSkip(t, outside, dirLink, "junction")) return;

  await expectErrorText(async () => resolveWithin(root, "file-link.md"), /路径越界/);
  await expectErrorText(async () => resolveWithin(root, "dir-link/new.md"), /路径越界/);
  await expectErrorText(async () => resolveReadable(root, [], "dir-link/secret.md"), /路径越界/);
  const toolkit = new Toolkit(root);
  await expectErrorText(() => toolkit.writeFile({ path: "dir-link/new.md", content: "no" }), /路径越界/);
  assert.equal(fs.existsSync(path.join(outside, "new.md")), false);
});

test("指向根内的目录链接仍可使用，realpath 两侧一致不误伤", async (t) => {
  const root = tmp();
  const actual = path.join(root, "actual");
  fs.mkdirSync(actual);
  const link = path.join(root, "inside-link");
  if (!linkOrSkip(t, actual, link, "junction")) return;
  assert.equal(insideBase(root, path.join(link, "new.md")), true);
  const toolkit = new Toolkit(root);
  await toolkit.writeFile({ path: "inside-link/new.md", content: "inside" });
  assert.equal(fs.readFileSync(path.join(actual, "new.md"), "utf-8"), "inside");
});

test("悬空链接不能伪装成根内待创建路径", async (t) => {
  const root = tmp();
  const outside = tmp("lynn-p1-toolkit-dangling-outside-");
  const link = path.join(root, "dangling");
  if (!linkOrSkip(t, path.join(outside, "missing-target"), link, "junction")) return;
  assert.equal(insideBase(root, path.join(link, "new.md")), false);
  await expectErrorText(async () => resolveWithin(root, "dangling/new.md"), /路径越界/);
});

test("循环链接不放行，不在 realpath 回退中死循环", async (t) => {
  const root = tmp();
  const a = path.join(root, "cycle-a");
  const b = path.join(root, "cycle-b");
  try {
    fs.symlinkSync("cycle-b", a);
    fs.symlinkSync("cycle-a", b);
  } catch (err) {
    t.skip(`当前环境无权创建循环符号链接：${String(err)}`);
    return;
  }
  assert.equal(insideBase(root, path.join(a, "new.md")), false);
  await expectErrorText(async () => resolveWithin(root, "cycle-a/new.md"), /路径越界/);
});
