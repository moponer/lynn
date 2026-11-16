// 成员路径归一化：明明已授权 F:\repo，却因 `/F:/repo/x` 写法被判越界
// （2026-11-11 长任务实测，诱发 20+ 次无效重派）。
//
// 夹具不能写死真实盘符（2026-11-16 CI 实测）：insideBase 用 realpath 判包含关系，
// CI 的 windows-latest 没有 F: 盘，回退到盘符根就返回 null → 一律判越界，
// 于是"本机有 F: 盘所以绿、CI 必挂"。这里一律用临时目录（与运行时同盘、真实存在）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeTargetPath } from "../dist/main/member-path.js";
import { resolveReadable, resolveWithin } from "../dist/main/toolkit.js";

const isWin = process.platform === "win32";
const skip = isWin ? false : "Windows 盘符路径语义";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mp-"));

/** 真实绝对路径 → 模型爱写的伪 POSIX 形式：`/C:/x/y` */
const asPseudoPosix = (p) => `/${p.replace(/\\/g, "/").replace(/^\/+/, "")}`;

test("伪 POSIX 绝对路径归一后命中已授权只读根", { skip }, () => {
  const base = tmpDir();
  const granted = tmpDir();
  const target = asPseudoPosix(path.join(granted, "package.json"));
  const want = path.join(granted, "package.json").toLowerCase();

  assert.equal(normalizeTargetPath(base, target).toLowerCase(), want);
  const r = resolveReadable(base, [granted], target);
  assert.equal(r.outside, true);
  assert.equal(r.full.toLowerCase(), want);
});

test("写路径仍钉死工作区：归一不会放宽越界", { skip }, () => {
  const base = tmpDir();
  const outside = tmpDir();
  assert.throws(() => resolveWithin(base, asPseudoPosix(path.join(outside, "x.md"))), /路径越界/);
  assert.equal(resolveWithin(base, "notes/a.md"), path.join(path.resolve(base), "notes", "a.md"));
});

test("普通绝对路径与相对路径行为不变", { skip }, () => {
  const base = tmpDir();
  const granted = tmpDir();
  // 正斜杠的普通绝对路径（不带前导斜杠）也要原样归一
  assert.equal(
    normalizeTargetPath(base, granted.replace(/\\/g, "/")).toLowerCase(),
    path.resolve(granted).toLowerCase(),
  );
  assert.equal(normalizeTargetPath(base, "a/b"), path.join(path.resolve(base), "a", "b"));
});
