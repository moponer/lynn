// 工坊启用闸：manifest id 落点、防审查后篡改、promote 当下重跑同一套准入。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDraft, draftsDir, promoteDraft, reviewDraft } from "../dist/main/workshop.js";

const noConflicts = () => ({ pluginIds: [], skillNames: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p0-workshop-"));

function deliver(root, id = "lynn.self.safe") {
  const meta = createDraft(root, { title: "安全技能", kind: "L0", spec: "固定周报格式" });
  const dir = path.join(draftsDir(root), meta.draftId);
  const manifest = {
    id,
    name: "安全技能",
    version: "1.0.0",
    apiVersion: 1,
    tier: "L0",
    engines: { kernel: ">=0.0.1" },
    source: "self-authored",
    generatedBy: "task-p0-workshop",
    contributes: { skills: ["safe-skill"] },
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  fs.mkdirSync(path.join(dir, "safe-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "safe-skill", "SKILL.md"),
    "---\nname: safe-skill\ndescription: 固定周报格式\n---\n\n按四段输出。\n",
    "utf-8",
  );
  return { draftId: meta.draftId, dir, manifest };
}

test("过审写入产物树 SHA-256，未变更的草稿可正常迁入", () => {
  const root = tmp();
  const { draftId } = deliver(root);
  assert.equal(reviewDraft(root, draftId, noConflicts()).ok, true);
  const meta = JSON.parse(fs.readFileSync(path.join(draftsDir(root), draftId, "_meta.json"), "utf-8"));
  assert.match(meta.reviewedHash, /^[0-9a-f]{64}$/);
  const promoted = promoteDraft(root, draftId, false, noConflicts());
  assert.equal(promoted.id, "lynn.self.safe");
  assert.ok(fs.existsSync(path.join(root, "plugins", promoted.id, "safe-skill", "SKILL.md")));
});

test("审查后修改或新增产物：指纹不一致，必须重新审查且不得落库", () => {
  const root = tmp();
  const { draftId, dir } = deliver(root);
  assert.equal(reviewDraft(root, draftId, noConflicts()).ok, true);
  fs.appendFileSync(path.join(dir, "safe-skill", "SKILL.md"), "审查后新增的一行。\n", "utf-8");
  assert.throws(() => promoteDraft(root, draftId, false, noConflicts()), /审查后产物已变更，需重新审查/);
  assert.equal(fs.existsSync(path.join(root, "plugins", "lynn.self.safe")), false);
});

test("manifest.id：路径分隔符、..、点目录与空白字符全部在迁移前拒绝", () => {
  const root = tmp();
  for (const badId of ["../escape", "foo/bar", "foo\\bar", "..", ".", "safe..id", "bad id", "/tmp/escape"]) {
    const { draftId, dir, manifest } = deliver(root);
    assert.equal(reviewDraft(root, draftId, noConflicts()).ok, true);
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ ...manifest, id: badId }), "utf-8");
    assert.throws(
      () => promoteDraft(root, draftId, false, noConflicts()),
      /插件 id 不合法|插件落点越界/,
      `危险 id 应拒绝：${badId}`,
    );
  }
  assert.equal(fs.existsSync(path.join(root, "escape")), false);
});

test("promote 重跑准入：review 后出现的 id 冲突不能靠旧结论绕过", () => {
  const root = tmp();
  const { draftId } = deliver(root);
  assert.equal(reviewDraft(root, draftId, noConflicts()).ok, true);
  assert.throws(
    () => promoteDraft(root, draftId, false, { pluginIds: ["lynn.self.safe"], skillNames: [] }),
    /启用前复审未通过.*插件 id 冲突/,
  );
  assert.equal(fs.existsSync(path.join(root, "plugins", "lynn.self.safe")), false);
});
