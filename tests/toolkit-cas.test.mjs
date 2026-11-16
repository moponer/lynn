// 读后写保护（CAS 轻量版）：读过之后文件被别人改过，写入要拒绝并要求重读。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolkit-cas-"));

async function expectReject(run, pattern) {
  await assert.rejects(async () => {
    const out = await run();
    // 某些分支把错误写进返回值；统一转成 reject 供断言
    if (typeof out === "string" && pattern.test(out)) return;
    throw new Error(`没有被拒绝，返回：${out}`);
  }, pattern);
}

test("读过之后被外部改过：write_file 拒绝覆盖，磁盘保持外部版本", async () => {
  const root = tmp();
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "第一版\n");
  const toolkit = new Toolkit(root);
  await toolkit.readFile({ path: "note.md" });

  fs.writeFileSync(file, "别人改成了另一版，长度不同\n");
  await expectReject(() => toolkit.writeFile({ path: "note.md", content: "我要覆盖\n" }), /你读过之后这个文件又被改过/);
  assert.match(fs.readFileSync(file, "utf-8"), /别人改成了另一版/);
});

test("重新读一次就恢复可写（CAS 不锁死流程）", async () => {
  const root = tmp();
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "第一版\n");
  const toolkit = new Toolkit(root);
  await toolkit.readFile({ path: "note.md" });

  fs.writeFileSync(file, "别人改过\n");
  await toolkit.readFile({ path: "note.md" });
  await toolkit.writeFile({ path: "note.md", content: "按最新版覆盖\n" });
  assert.equal(fs.readFileSync(file, "utf-8"), "按最新版覆盖\n");
});

test("没读过的新文件/整篇重写照旧允许（不打断正常创作）", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "existing.txt"), "旧内容\n");
  const toolkit = new Toolkit(root);
  await toolkit.writeFile({ path: "existing.txt", content: "整篇重写\n" });
  assert.equal(fs.readFileSync(path.join(root, "existing.txt"), "utf-8"), "整篇重写\n");
  await toolkit.writeFile({ path: "brand-new.txt", content: "新文件\n" });
  assert.equal(fs.readFileSync(path.join(root, "brand-new.txt"), "utf-8"), "新文件\n");
});

test("同一实例连续写两次不被自己的 CAS 挡住（写后要更新状态）", async () => {
  const root = tmp();
  const toolkit = new Toolkit(root);
  await toolkit.writeFile({ path: "a.md", content: "一\n" });
  await toolkit.writeFile({ path: "a.md", content: "二，比第一次长\n" });
  await toolkit.editFile({ path: "a.md", old_string: "二", new_string: "三" });
  assert.equal(fs.readFileSync(path.join(root, "a.md"), "utf-8"), "三，比第一次长\n");
});

test("读过之后文件被删除：当新建处理，允许写", async () => {
  const root = tmp();
  const file = path.join(root, "gone.md");
  fs.writeFileSync(file, "会被删\n");
  const toolkit = new Toolkit(root);
  await toolkit.readFile({ path: "gone.md" });
  fs.unlinkSync(file);
  await toolkit.writeFile({ path: "gone.md", content: "重建\n" });
  assert.equal(fs.readFileSync(file, "utf-8"), "重建\n");
});

test("edit_file 与 patch 模式同样受保护", async () => {
  const root = tmp();
  const file = path.join(root, "src.md");
  fs.writeFileSync(file, "alpha beta\n");
  const toolkit = new Toolkit(root);
  await toolkit.readFile({ path: "src.md" });
  fs.writeFileSync(file, "alpha beta gamma 外部追加\n");

  await expectReject(
    () => toolkit.editFile({ path: "src.md", old_string: "beta", new_string: "BETA" }),
    /你读过之后这个文件又被改过/,
  );
  assert.match(fs.readFileSync(file, "utf-8"), /外部追加/);
});
