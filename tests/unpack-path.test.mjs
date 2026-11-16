// asar 路径改写（2026-11-16 开启 asar 打包）：交给子进程的脚本路径必须指向 app.asar.unpacked，
// 否则 ELECTRON_RUN_AS_NODE 的子进程（没有 asar 补丁）会 Cannot find module。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { unpackedPath } from "../dist/main/unpack-path.js";

const sep = path.sep;

test("打包态：app.asar 段改写成 app.asar.unpacked，其余部分一字不动", () => {
  const packed = `${sep}app${sep}resources${sep}app.asar${sep}agent${sep}l1-worker.mjs`;
  const want = `${sep}app${sep}resources${sep}app.asar.unpacked${sep}agent${sep}l1-worker.mjs`;
  assert.equal(unpackedPath(packed), want);
});

test("开发态：路径里没有 app.asar 段时原样返回（不误伤名字里带 asar 的目录）", () => {
  const dev = path.join("F:", "spiker", "lynn", "agent", "l1-worker.mjs");
  assert.equal(unpackedPath(dev), dev);
  // 只是文件名里含 asar 不算 asar 段
  const tricky = path.join("F:", "spiker", "app.asar-backup", "x.mjs");
  assert.equal(unpackedPath(tricky), tricky);
});

test("空值安全：undefined / 空串原样返回（getter 允许可选路径）", () => {
  assert.equal(unpackedPath(undefined), undefined);
  assert.equal(unpackedPath(""), "");
});
