// M1-12：逐轮文件检查点 + 撤销
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointStore } from "../dist/main/checkpoints.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cp-"));

test("改过的文件：撤销后恢复原文", () => {
  const root = tmp();
  const file = path.join(root, "work", "a.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "原文\n第二行");

  const cp = new CheckpointStore(path.join(root, "checkpoints"));
  cp.begin("turn-1");
  cp.beforeWrite("a.md", file, true);
  fs.writeFileSync(file, "改过的\n第二行");

  assert.deepEqual(cp.status()?.files, ["a.md"]);
  const r = cp.undo();
  assert.deepEqual(r.restored, ["a.md"]);
  assert.equal(fs.readFileSync(file, "utf-8"), "原文\n第二行");
  assert.equal(cp.status(), null, "撤销后不该再有可撤销状态");
});

test("本轮新建的文件：撤销时删掉", () => {
  const root = tmp();
  const file = path.join(root, "work", "new.txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const cp = new CheckpointStore(path.join(root, "checkpoints"));
  cp.begin("turn-2");
  cp.beforeWrite("new.txt", file, false);
  fs.writeFileSync(file, "临时产物");

  const r = cp.undo();
  assert.deepEqual(r.removed, ["new.txt"]);
  assert.equal(fs.existsSync(file), false);
});

test("同一文件多次改：按倒序还原到本轮开始前", () => {
  const root = tmp();
  const file = path.join(root, "x.txt");
  fs.writeFileSync(file, "v0");

  const cp = new CheckpointStore(path.join(root, "checkpoints"));
  cp.begin("turn-3");
  cp.beforeWrite("x.txt", file, true);
  fs.writeFileSync(file, "v1");
  cp.beforeWrite("x.txt", file, true);
  fs.writeFileSync(file, "v2");

  cp.undo();
  assert.equal(fs.readFileSync(file, "utf-8"), "v0");
});

test("没有 begin 时 undo 是空操作；discard 清目录", () => {
  const root = tmp();
  const cp = new CheckpointStore(path.join(root, "checkpoints"));
  assert.deepEqual(cp.undo(), { restored: [], removed: [] });

  const file = path.join(root, "y.txt");
  fs.writeFileSync(file, "y");
  cp.begin("turn-4");
  cp.beforeWrite("y.txt", file, true);
  cp.discard();
  assert.equal(cp.status(), null);
  assert.equal(fs.existsSync(file), true, "discard 不动工作区文件");
});
