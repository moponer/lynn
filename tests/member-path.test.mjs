// 成员路径归一化：明明已授权 F:\repo，却因 `/F:/repo/x` 写法被判越界
// （2026-11-11 长任务实测，诱发 20+ 次无效重派）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { normalizeTargetPath } from "../dist/main/member-path.js";
import { resolveReadable, resolveWithin } from "../dist/main/toolkit.js";

const isWin = process.platform === "win32";
const skip = isWin ? false : "Windows 盘符路径语义";

test("伪 POSIX 绝对路径归一后命中已授权只读根", { skip }, () => {
  const base = "C:\\Users\\Administrator\\LynnWorkspace";
  const granted = path.resolve("F:\\spiker\\hermix-desktop");
  const want = path.join(granted, "package.json").toLowerCase();
  assert.equal(normalizeTargetPath(base, "/F:/spiker/hermix-desktop/package.json").toLowerCase(), want);
  const r = resolveReadable(base, [granted], "/F:/spiker/hermix-desktop/package.json");
  assert.equal(r.outside, true);
  assert.equal(r.full.toLowerCase(), want);
});

test("写路径仍钉死工作区：归一不会放宽越界", { skip }, () => {
  const base = "C:\\Users\\Administrator\\LynnWorkspace";
  assert.throws(() => resolveWithin(base, "/F:/spiker/hermix-desktop/x.md"), /路径越界/);
  assert.equal(resolveWithin(base, "notes/a.md"), path.join(path.resolve(base), "notes", "a.md"));
});

test("普通绝对路径与相对路径行为不变", { skip }, () => {
  const base = "C:\\ws";
  assert.equal(normalizeTargetPath(base, "F:/repo/x"), path.resolve("F:/repo/x"));
  assert.equal(normalizeTargetPath(base, "a/b"), path.join(path.resolve(base), "a", "b"));
});
