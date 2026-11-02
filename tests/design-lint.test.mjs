import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/** 设计约束检查（M1-25）：零描边、四功能色齐全、无装饰色。可被 CI 拦截。 */

test("设计约束检查通过", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const r = spawnSync(process.execPath, ["scripts/check-design.mjs"], {
    cwd: root,
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `设计约束检查失败：\n${r.stderr || r.stdout}`);
  assert.match(r.stdout, /设计约束检查通过/);
});
