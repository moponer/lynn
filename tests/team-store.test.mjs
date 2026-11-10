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

test("用户改岗位：只动角色/目标/提示词，工具白名单不在这里扩缩", () => {
  store.createTeam("t1", "月报突击队");
  store.writeMember("t1", profile);
  const next = store.updateMember("t1", "林工", {
    role: "数据工程师",
    goal: "把周报第 3 节做成可核对的口径",
    body: "先对账，再出稿；口径不一致就上报。",
  });
  assert.equal(next.role, "数据工程师");
  assert.equal(next.tools.length, profile.tools.length, "工具白名单必须保持原样");
  assert.equal(store.readMember("t1", "林工").body, "先对账，再出稿；口径不一致就上报。");
  // 空角色/空目标拒：这两列是成员收敛行为的依据，不能存成空串
  assert.throws(() => store.updateMember("t1", "林工", { role: "  " }), /角色不能为空/);
  assert.throws(() => store.updateMember("t1", "林工", { goal: "" }), /单一目标不能为空/);
  // 部分更新：没传的字段保持原值
  const after = store.updateMember("t1", "林工", { goal: "只改目标" });
  assert.equal(after.role, "数据工程师");
  assert.equal(store.readMember("t1", "林工").goal, "只改目标");
});

test("删成员：只删岗位档案，派单记录保留（审计资产）；最后一名不许删", () => {
  store.createTeam("t1", "月报突击队");
  store.writeMember("t1", profile);
  store.writeMember("t1", { ...profile, name: "小眉", role: "图表校对" });
  store.appendAssignment("t1", { taskId: "0912", at: "14:05", kind: "assign", member: "林工", text: "跑一单" });
  store.removeMember("t1", "林工");
  assert.equal(store.listMembers("t1").length, 1);
  assert.equal(store.listMembers("t1")[0].name, "小眉");
  assert.equal(store.readAssignments("t1", "0912").length, 1, "派单记录不随成员删除");
  assert.throws(() => store.removeMember("t1", "林工"), /没有成员/);
  // 空编制既派不了活又占着"在职团队"：要清空请直接解散
  assert.throws(() => store.removeMember("t1", "小眉"), /最后一名成员/);
});

test("头像库：12 款 id 唯一、无蓝紫；按名字分配稳定且会避开已用脸", async () => {
  const { AVATARS, avatarFor, avatarById, isAvatarId } = await import("../dist/shared/avatars.js");
  assert.equal(AVATARS.length, 12);
  assert.equal(new Set(AVATARS.map((a) => a.id)).size, 12);
  for (const a of AVATARS) {
    assert.ok(isAvatarId(a.id));
    const n = Number.parseInt(a.color.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    assert.ok(b <= Math.max(r, g), `${a.id} 不能是蓝/紫偏色：${a.color}`);
    assert.equal(avatarById(a.id), a);
  }
  assert.equal(isAvatarId("a13"), false);
  assert.equal(avatarFor("林工").id, avatarFor("林工").id, "同名必须稳定");
  assert.notEqual(avatarFor("林工", [avatarFor("林工").id]).id, avatarFor("林工").id, "被占用就换一张");
});

test("岗位档案：avatar_id 写入 frontmatter 并能读回", () => {
  const withAvatar = { ...profile, avatarId: "a09" };
  const md = serializeMemberProfile(withAvatar);
  assert.match(md, /avatar_id: "a09"/);
  assert.equal(parseMemberProfile(md).avatarId, "a09");
  assert.equal(parseMemberProfile(serializeMemberProfile(profile)).avatarId, undefined, "老档案没这字段也能读");
});

test("开源头像库：12 张脸 seed 唯一，换画风不动 id/色板契约", async () => {
  const { AVATARS, avatarFor, avatarById } = await import("../dist/shared/avatars.js");
  assert.equal(AVATARS.length, 12);
  assert.equal(
    new Set(AVATARS.map((a) => a.seed)).size,
    12,
    "两张脸共用一个 seed 会导致同队撞脸",
  );
  assert.ok(AVATARS.every((a) => typeof a.seed === "string" && a.seed.length > 0));
  assert.equal(avatarById("a11")?.color, "#9a8f7a", "id → 岗位色契约不能随画风变");
  assert.deepEqual(avatarFor("顾明"), avatarFor("顾明"), "同名成员跨会话必须同一张脸");
});
