// 只读目录授权（2026-11-04 用户选择方案 2）：
// 成员能读用户授权的目录，但**写永远只能在任务工作区**；授权只由用户发起，且能随时撤销/对在跑的成员立即生效。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";
import { Kernel } from "../dist/main/kernel.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-grant-"));

test("Toolkit：只读授权目录可读、写入仍被拒、未授权照旧越界；动态授权立刻生效", async () => {
  const root = tmp();
  const ws = path.join(root, "ws");
  const proj = path.join(root, "proj");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "a.md"), "hello-project\n");

  let roots = [];
  const tk = new Toolkit(ws, { readRoots: () => roots });
  const target = path.join(proj, "src", "a.md");

  assert.throws(() => tk.readFile({ path: target }), /路径越界/, "没授权时不能读外部目录");

  roots = [proj]; // 用户刚授权（成员还在跑）
  assert.match(tk.readFile({ path: target }), /hello-project/, "授权后立刻可读");
  assert.match(tk.listDir({ path: proj }), /src/, "授权目录可列目录");

  await assert.rejects(
    async () => tk.writeFile({ path: path.join(proj, "b.md"), content: "x" }),
    /路径越界/,
    "写永远只能在任务工作区",
  );
  assert.throws(() => tk.writeFile({ path: path.join(root, "outside.md"), content: "x" }), /路径越界/);
});

test("Kernel：grantRead 校验（盘符根/自家数据目录拒），写入工单并可撤销", async () => {
  const root = tmp();
  // 项目目录必须在数据根之外（脚本里的 root 就是 dataRoot，"授权自家数据目录"本来就该被拒）
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-proj-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const tasks = new TaskStore(root);
    tasks.create({ id: "WO-1", title: "审查项目", teamId: "t1", member: "探针", threadId: kernel.handle("session.snapshot").thread.id });

    const ok = kernel.handle("task.grantRead", { taskId: "WO-1", dir: proj });
    assert.equal(ok.ok, true);
    assert.deepEqual(tasks.get("WO-1").readRoots, [proj], "授权落进工单（重启后还在）");

    const rootDrive = path.parse(path.resolve(proj)).root;
    assert.equal(kernel.handle("task.grantRead", { taskId: "WO-1", dir: rootDrive }).ok, false, "不许授权整个盘符");
    assert.equal(kernel.handle("task.grantRead", { taskId: "WO-1", dir: kernel.dataRoot }).ok, false, "不许授权自家数据根");
    assert.equal(kernel.handle("task.grantRead", { taskId: "WO-1", dir: path.join(root, "nope") }).ok, false);

    const snap = kernel.handle("session.snapshot");
    const row = snap.board.track.find((t) => t.id === "WO-1");
    assert.deepEqual(row.readRoots, [proj], "台账要能看出这张单能读哪儿");

    const rev = kernel.handle("task.revokeRead", { taskId: "WO-1" });
    assert.equal(rev.ok, true);
    assert.equal(tasks.get("WO-1").readRoots, undefined, "撤销后不再保留");
  } finally {
    await kernel.dispose();
  }
});
