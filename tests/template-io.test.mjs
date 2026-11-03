// M2-15：模板导出/导入 —— 第三方岗位说明不得扩权；白名单只收窄；diff 展示
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TeamStore } from "../dist/main/team-store.js";
import { MEMBER_EXEC_TOOLS } from "../dist/main/member-runner.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-tio-"));

const profile = (name, tools) => ({
  name,
  role: "岗位",
  goal: "目标",
  boundaries: ["只动工作区"],
  tools,
  model: "deepseek-chat",
  limits: { maxTurns: 8, budgetTokens: 200000, wallClockMin: 20 },
  outputContract: { deliverable: "报告", evidence: ["r.md"], acceptance: ["对得上"] },
  escalateWhen: "卡住",
  body: "说明",
});

test("export：导出的 JSON 可再导入；import：越权工具剥掉+告警，白名单只收窄", () => {
  const root = tmp();
  const store = new TeamStore(root);
  store.createTeam("t1", "月报队");
  store.writeMember("t1", profile("顾明", ["read_file", "write_file", "ask_user", "rm_rf_all"]));
  store.saveTemplate("t1", "月报队编制");

  const out = path.join(root, "share", "月报队.json");
  const exp = store.exportTemplate("月报队编制", out);
  assert.equal(exp.ok, true);
  const json = fs.readFileSync(out, "utf-8");
  assert.ok(json.includes("lynn-team-template"), "导出带类型标记");

  const { proposal, commit } = store.importTemplate(json, MEMBER_EXEC_TOOLS);
  assert.ok(proposal.warnings.some((w) => w.includes("ask_user")), "管理型工具剥掉并告警");
  assert.ok(proposal.warnings.some((w) => w.includes("rm_rf_all")), "未知工具剥掉并告警");
  const gu = proposal.members.find((m) => m.name === "顾明");
  assert.deepEqual(gu.tools, ["read_file", "write_file"], "只留合法执行工具");

  const committed = commit();
  assert.equal(committed.members, 1);
  const t = store.findTemplate("月报队编制");
  assert.deepEqual(t.members[0].tools, ["read_file", "write_file"], "落库的是收窄后的白名单");
});

test("import 拒绝：坏 JSON / 非风铃模板 / 空成员 / 超 6 人", () => {
  const store = new TeamStore(tmp());
  assert.throws(() => store.importTemplate("{broken", MEMBER_EXEC_TOOLS), /JSON/);
  assert.throws(() => store.importTemplate(JSON.stringify({ kind: "other" }), MEMBER_EXEC_TOOLS), /不是风铃团队模板/);
  assert.throws(() => store.importTemplate(JSON.stringify({ kind: "lynn-team-template", members: [] }), MEMBER_EXEC_TOOLS), /members 为空/);
  const seven = { kind: "lynn-team-template", name: "x", members: Array.from({ length: 7 }, (_, i) => profile(`m${i}`, ["read_file"])) };
  assert.throws(() => store.importTemplate(JSON.stringify(seven), MEMBER_EXEC_TOOLS), /6 人上限/);
});

test("Kernel：team.exportTemplate / team.importTemplate RPC 闭环", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const store = kernel.teamStore;
    store.createTeam("t1", "月报队");
    store.writeMember("t1", profile("顾明", ["read_file", "write_file", "ask_user"]));
    store.saveTemplate("t1", "月报队编制");

    const out = path.join(root, "share", "t.json");
    const exp = kernel.handle("team.exportTemplate", { name: "月报队编制", outFile: out });
    assert.equal(exp.ok, true);

    const imp = kernel.handle("team.importTemplate", { json: fs.readFileSync(out, "utf-8") });
    assert.equal(imp.ok, true);
    assert.ok(imp.proposal.warnings.length >= 1, "越权告警回显");
    assert.ok(fs.existsSync(path.join(root, "team", "_templates", "月报队编制.json")));
  } finally {
    await kernel.dispose();
  }
});
