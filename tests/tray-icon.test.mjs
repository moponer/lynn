// 托盘图标回归（2026-11-11）：文件存在 + 构建产物复制 + 内嵌兜底是真 PNG。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { trayFallbackBuffer, trayIconPaths } from "../dist/main/tray-icon.js";

const repo = path.resolve(import.meta.dirname, "..");
const isPng = (b) => b.slice(0, 8).toString("hex") === "89504e470d0a1a0a";

test("assets/tray.png 是有效的 16×16 PNG", () => {
  const p = path.join(repo, "assets", "tray.png");
  assert.ok(fs.existsSync(p), "assets/tray.png 缺失");
  const b = fs.readFileSync(p);
  assert.ok(isPng(b));
  assert.equal(b.readUInt32BE(16), 16);
  assert.equal(b.readUInt32BE(20), 16);
});

test("构建后 dist/assets/tray.png 必须存在（否则主进程读到空图标）", () => {
  const p = path.join(repo, "dist", "assets", "tray.png");
  assert.ok(fs.existsSync(p), "dist/assets/tray.png 缺失：build:main 没跑 copy-assets");
  assert.ok(isPng(fs.readFileSync(p)));
});

test("内嵌兜底是真 PNG，候选路径包含 appPath/assets", () => {
  const b = trayFallbackBuffer();
  assert.ok(isPng(b));
  assert.equal(b.readUInt32BE(16), 16);
  const paths = trayIconPaths("/some/app", "/some/app/dist/main");
  assert.ok(paths.includes(path.join("/some/app", "assets", "tray.png")));
});
