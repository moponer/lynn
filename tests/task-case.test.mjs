import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskCase } from "../dist/main/task-case.js";

/** 任务卷宗（§4.8）：timeline 只追加、artifacts 永久、summary 滚动。 */

function newCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-case-"));
  return { root, tc: new TaskCase(root) };
}

test("timeline 只追加：事件按顺序读回，带时间戳", () => {
  const { tc } = newCase();
  tc.append("WO-1", { kind: "created", text: "建单" });
  tc.append("WO-1", { kind: "assign", member: "林工", text: "派单" });
  const t = tc.readTimeline("WO-1");
  assert.equal(t.length, 2);
  assert.equal(t[0].kind, "created");
  assert.equal(t[1].member, "林工");
  assert.ok(Date.parse(t[0].at) > 0);
  // 原始文件是 JSONL，一问一行
  const raw = fs.readFileSync(path.join(tc.dir("WO-1"), "timeline.jsonl"), "utf-8").trim().split("\n");
  assert.equal(raw.length, 2);
});

test("importArtifact：真文件收进 artifacts/，同名不覆盖，ref 可验证", () => {
  const { root, tc } = newCase();
  const src = path.join(root, "report.md");
  fs.writeFileSync(src, "# 周报\n");
  const a = tc.importArtifact("WO-2", src);
  assert.equal(a.ref, "artifacts/report.md");
  assert.equal(a.bytes, fs.statSync(src).size);
  assert.ok(fs.existsSync(a.abs));
  assert.equal(tc.verifyRef("WO-2", a.ref), true);
  assert.equal(tc.verifyRef("WO-2", "https://example.com/snapshot"), false);
  assert.equal(tc.verifyRef("WO-2", "artifacts/nope.md"), false);
});

test("同名工件第二次导入加时间戳后缀，不覆盖既有证据", () => {
  const { root, tc } = newCase();
  const src = path.join(root, "log.txt");
  fs.writeFileSync(src, "v1");
  const first = tc.importArtifact("WO-3", src);
  fs.writeFileSync(src, "v2");
  const second = tc.importArtifact("WO-3", src);
  assert.notEqual(first.abs, second.abs);
  assert.equal(fs.readFileSync(first.abs, "utf-8"), "v1");
  assert.equal(fs.readFileSync(second.abs, "utf-8"), "v2");
});

test("writeArtifact 直接落工件并记事件", () => {
  const { tc } = newCase();
  const a = tc.writeArtifact("WO-4", "diff.patch", "- a\n+ b\n");
  assert.equal(tc.verifyRef("WO-4", a.ref), true);
  assert.ok(tc.readTimeline("WO-4").some((e) => e.kind === "artifact"));
});

test("summary 滚动追加，首次自动建头", () => {
  const { tc } = newCase();
  tc.appendSummary("WO-5", "派给 林工");
  tc.appendSummary("WO-5", "进入待审查");
  const s = tc.readSummary("WO-5");
  assert.match(s, /^# 任务 WO-5/);
  assert.match(s, /派给 林工/);
  assert.match(s, /进入待审查/);
});

test("工件名净化：路径分隔与非法字符被处理，不能逃出 artifacts/", () => {
  const { tc } = newCase();
  const a = tc.writeArtifact("WO-6", "../../evil.txt", "x");
  assert.ok(a.abs.startsWith(tc.artifactsDir("WO-6")));
  assert.equal(path.basename(a.abs), "evil.txt");
});
