// 2026-11-10 收尾：命令 cwd 多根、审查快照、工件去重、卷宗导出。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { Toolkit, findPathEscape } from "../dist/main/toolkit.js";
import { TaskCase } from "../dist/main/task-case.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = (p = "lynn-extra-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("findPathEscape：已授权的可写根不算越界；未授权仍然拦", () => {
  const root = tmp();
  const rw = tmp("lynn-extra-rw-");
  const file = path.join(rw, "a.txt");
  fs.writeFileSync(file, "x", "utf-8");
  assert.ok(findPathEscape(`type "${file}"`, root) !== null, "未授权时应判越界");
  assert.equal(findPathEscape(`type "${file}"`, root, [rw]), null, "授权后可读");
});

test("run_command cwd：可写根可以跑；未授权的 cwd 拒；文件写入仍只限工作区", async () => {
  const root = tmp();
  const rw = tmp("lynn-extra-rw2-");
  fs.writeFileSync(path.join(rw, "marker.txt"), "x", "utf-8");
  const t = new Toolkit(root, { writableRoots: [rw] });

  const out = await t.runCommand({ command: 'node -e "console.log(process.cwd())"', cwd: rw });
  assert.match(out, /exit code: 0/);
  assert.ok(out.includes(path.resolve(rw)), `cwd 应是可写根，实际：${out}`);

  const denied = await t.runCommand({ command: "echo hi", cwd: tmp("lynn-extra-out-") });
  assert.match(denied, /cwd 越界/);

  let wrote = false;
  try {
    await t.execute("write_file", { path: path.join(rw, "new.txt"), content: "x" });
    wrote = true;
  } catch (err) {
    assert.match(String(err), /越界|只能访问工作区/, "可写根不放开文件写入");
  }
  assert.equal(wrote, false);
});

test("审查快照：工作区复制进任务沙箱，原项目不动，记录切 sandbox", async () => {
  const root = tmp("lynn-extra-k-");
  const project = tmp("lynn-extra-proj-");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\n", "utf-8");
  fs.mkdirSync(path.join(project, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(project, "node_modules", "pkg", "index.js"), "x", "utf-8");

  const k = new Kernel(root);
  try {
    await k.init();
    k.taskStore.create({ id: "t1", title: "审查单", teamId: "team", workspaceRoot: project });
    const r = k.handle("task.snapshotProject", { taskId: "t1" });
    assert.equal(r.ok, true);
    const dest = path.join(root, "tasks", "t1", "workspace");
    assert.equal(r.root, dest);
    assert.ok(fs.existsSync(path.join(dest, "src", "a.ts")), "源码复制进沙箱");
    assert.ok(!fs.existsSync(path.join(dest, "node_modules")), "大目录不复制");
    assert.ok(fs.existsSync(path.join(project, "src", "a.ts")), "原项目不动");
    const rec = new TaskStore(root).get("t1");
    assert.equal(rec.workspace.mode, "sandbox");
    assert.equal(rec.workspaceRoot, dest);
  } finally {
    await k.dispose();
  }
});

test("工件去重：同内容只存一份；不同内容同名也各存", () => {
  const root = tmp();
  const src = tmp("lynn-extra-src-");
  const a = path.join(src, "report.txt");
  fs.writeFileSync(a, "same", "utf-8");
  const tc = new TaskCase(root);
  const r1 = tc.importArtifact("t1", a);
  const r2 = tc.importArtifact("t1", a);
  assert.equal(r1.ref, r2.ref, "同内容复用同一份工件");
  const files = fs.readdirSync(tc.artifactsDir("t1")).filter((f) => f !== "_hashes.json");
  assert.equal(files.length, 1);

  fs.writeFileSync(a, "different", "utf-8");
  const r3 = tc.importArtifact("t1", a);
  const files2 = fs.readdirSync(tc.artifactsDir("t1")).filter((f) => f !== "_hashes.json");
  assert.equal(files2.length, 2, "同名不同内容不能互相覆盖");
  assert.notEqual(r3.ref, r1.ref);
});

test("卷宗导出：生成真实 zip（含 task.json / timeline / artifacts）", async () => {
  const root = tmp("lynn-extra-k2-");
  const k = new Kernel(root);
  const proj = tmp("lynn-extra-proj2-");
  try {
    await k.init();
    k.taskStore.create({ id: "t2", title: "导出单", teamId: "team", workspaceRoot: proj });
    k.taskCase.append("t2", { kind: "note", text: "一条记录" });
    const src = path.join(proj, "out.txt");
    fs.writeFileSync(src, "hello", "utf-8");
    k.taskCase.importArtifact("t2", src);

    const r = k.handle("task.export", { taskId: "t2" });
    assert.equal(r.ok, true);
    const buf = fs.readFileSync(r.path);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "zip 本地头");
    const text = buf.toString("utf-8");
    for (const name of ["task.json", "timeline.jsonl", "artifacts/out.txt"]) {
      assert.ok(text.includes(name), `zip 里应有 ${name}`);
    }
  } finally {
    await k.dispose();
  }
});
