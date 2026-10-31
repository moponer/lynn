import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TeamStore,
  serializeMemberProfile,
  parseMemberProfile,
  memberFileName,
} from "../dist/main/team-store.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-team-"));
}

const profile = {
  name: "林工",
  role: "后端工程师",
  goal: "把 /api/report 导出改成流式，且不破坏现有测试",
  boundaries: ["只改 apps/api/** 与 tests/api/**", "不动数据库迁移", "不引入新依赖（需要时上报，不自行决定）"],
  tools: ["read", "write", "edit", "bash", "glob", "grep"],
  model: "deepseek-chat",
  limits: { maxTurns: 40, budgetTokens: 300000, wallClockMin: 30 },
  outputContract: {
    deliverable: "可直接提交的 diff + 变更说明",
    evidence: ["改动文件清单", "测试命令与完整输出", "未覆盖风险"],
    acceptance: ["pnpm test 全绿", "50MB 文件导出时内存峰值 < 300MB"],
  },
  escalateWhen: "需要改数据库 / 需要新依赖 / 测试失败且原因不明",
  body: "这个岗位怎么做事的说明——由风铃写，可迭代。",
};

let root;
let store;

beforeEach(() => {
  root = tmpRoot();
  store = new TeamStore(root);
});

test("成员档案：序列化 → 解析 往返一致", () => {
  const md = serializeMemberProfile(profile);
  const back = parseMemberProfile(md);
  assert.deepEqual(back, profile);
});

test("成员档案落盘后从磁盘读回一致", () => {
  store.createTeam("t1", "月报突击队");
  store.writeMember("t1", profile);
  const back = store.readMember("t1", "林工");
  assert.equal(back.role, "后端工程师");
  assert.equal(back.tools.length, 6);
  assert.equal(back.limits.budgetTokens, 300000);
  assert.equal(store.listMembers("t1").length, 1);
});

test("成员名生成安全文件名（Windows 非法字符净化）", () => {
  assert.equal(memberFileName("林工"), "林工.md");
  assert.equal(memberFileName('a/b<c>*d?"e'), "a-b-c-d-e.md");
  assert.throws(() => memberFileName("///"));
});

test("派单记录：追加写、不可改写、按任务读取", () => {
  store.createTeam("t1", "月报突击队");
  store.appendAssignment("t1", {
    taskId: "0912",
    at: "14:05",
    kind: "assign",
    member: "林工",
    text: "导出并清洗 9 月订单明细",
  });
  store.appendAssignment("t1", {
    taskId: "0912",
    at: "15:40",
    kind: "reject",
    member: "小眉",
    text: "图表口径不可比",
    rejectReason: { what: "图表3用了含退款口径", expect: "改用净订单口径", deadline: "16:30" },
  });
  const recs = store.readAssignments("t1", "0912");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, "assign");
  // 追加语义：再读仍为同一条数，历史不被改写
  store.appendAssignment("t1", {
    taskId: "0912",
    at: "16:31",
    kind: "report",
    member: "小眉",
    text: "重交第 2 稿",
  });
  assert.equal(store.readAssignments("t1", "0912").length, 3);
});

test("打回计数与上限判定", () => {
  store.createTeam("t1", "月报突击队");
  for (let i = 0; i < 3; i++) {
    store.appendAssignment("t1", {
      taskId: "x",
      at: `t${i}`,
      kind: "reject",
      member: "小眉",
      text: `第${i + 1}轮打回`,
      rejectReason: { what: "w", expect: "e", deadline: "d" },
    });
  }
  assert.equal(store.rejectCount("t1", "x"), 3);
  // 上限 3 轮：第 4 次打回应被上层拒绝（工具层校验，这里只提供计数依据）
});

test("解散团队：状态落盘，档案保留（保留编制复用的反面：解散只改状态）", () => {
  store.createTeam("t1", "月报突击队");
  store.writeMember("t1", profile);
  store.dissolveTeam("t1");
  const rec = JSON.parse(fs.readFileSync(path.join(root, "team", "t1", "team.json"), "utf-8"));
  assert.equal(rec.status, "dissolved");
  assert.equal(store.listMembers("t1").length, 1, "解散不清档案，供复盘与复用");
});
