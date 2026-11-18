/**
 * 角色注册表 + G1 准入闸（P3-1 / 07 章）。
 *
 * 这组断言要证明的是「混合角色进不来、正常岗位能对上号」，而不是「关键词表好不好看」：
 *  1. 注册表 11 个角色齐全、id 唯一、模板文件真实存在（否则 G2 编译必然回落）；
 *  2. 混合岗位检测：明确的兼职信号要抓，连接词（与/和）和「兼容」不许误杀；
 *  3. 解析优先级：声明 roleId > 自由文本推断 > fallback，且 fallback 必须被标出来；
 *  4. 命中率 ≥90%（07 章 §9 的验收线）；
 *  5. G1 真的接在写盘口上：混合岗位会被拒，正常岗位落盘时带上 roleId。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROLE_REGISTRY,
  MEMBER_ROLE_IDS,
  FALLBACK_ROLE,
  isKnownRoleId,
  isMixedRoleText,
  resolveRole,
  suggestRole,
  roleGateNote,
  mixedRoleRejection,
} from "../dist/main/role-registry.js";
import { TeamStore } from "../dist/main/team-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-roles-"));
}

const member = (over = {}) => ({
  name: "林工",
  role: "后端工程师",
  roleId: "implementer",
  goal: "清洗对账",
  boundaries: ["只改数据目录"],
  tools: ["read_file"],
  model: "deepseek-chat",
  limits: { maxTurns: 40, budgetTokens: 300000, wallClockMin: 30 },
  outputContract: { deliverable: "diff", evidence: ["测试输出"], acceptance: ["test 全绿"] },
  escalateWhen: "需要新依赖",
  body: "岗位说明",
  ...over,
});

test("注册表：11 个成员角色，id 唯一，不含 orchestrator", () => {
  assert.equal(ROLE_REGISTRY.length, 11, "07 章 §3 的枚举是 11 项");
  assert.equal(new Set(MEMBER_ROLE_IDS).size, 11, "roleId 不得重复");
  assert.ok(!MEMBER_ROLE_IDS.includes("orchestrator"), "orchestrator 是风铃自己，成员不该占这个岗位");
  assert.ok(MEMBER_ROLE_IDS.includes(FALLBACK_ROLE), "兜底角色必须在注册表里");
  for (const r of ROLE_REGISTRY) {
    assert.ok(r.domains.length > 0, `${r.roleId} 没写能力域`);
    assert.ok(r.desc.length > 10, `${r.roleId} 缺选择指引（模型要靠它选对角色）`);
    assert.ok(r.strong.length > 0, `${r.roleId} 没有任何强特征词，永远推断不出来`);
  }
});

test("注册表：声明了模板的角色，模板文件必须真实存在（否则 G2 必然回落）", () => {
  for (const r of ROLE_REGISTRY) {
    if (!r.template) continue; // 自研角色（writer/analyst/presenter）走档案正文，没有模板文件
    const full = path.join(ROOT, "prompts", r.template);
    assert.ok(fs.existsSync(full), `${r.roleId} 的模板 ${r.template} 不存在`);
  }
});

test("混合检测：明确的兼职信号要抓到", () => {
  for (const text of ["资深全栈兼文档专家", "兼任开发与测试", "多面手", "既做前端又做运维", "一边写代码一边做运维"]) {
    assert.equal(isMixedRoleText(text), true, `应判为混合岗位：${text}`);
  }
});

test("混合检测：连接词与「兼容」不许误杀（误杀比漏判更贵）", () => {
  for (const text of [
    "文件清点与内容提取专员",
    "结构化文档撰写与润色专员",
    "兼容老旧浏览器",
    "源码审查工程师（架构/正确性/性能/安全，只读）",
    "全栈工程师",
    "测试与部署工程师",
  ]) {
    assert.equal(isMixedRoleText(text), false, `不该判为混合岗位：${text}`);
  }
});

test("解析优先级：声明 > 推断 > 兜底，且兜底必须可辨认", () => {
  const declared = resolveRole({ roleId: "analyst", role: "后端工程师" });
  assert.equal(declared.source, "declared");
  assert.equal(declared.roleId, "analyst", "声明了就以声明为准（哪怕文本更像别的角色）");
  assert.equal(declared.confidence, 1);

  const inferred = resolveRole({ role: "代码审查员" });
  assert.equal(inferred.source, "inferred");
  assert.equal(inferred.roleId, "reviewer-quality");
  assert.ok(inferred.confidence > 0 && inferred.confidence <= 1);

  const fallback = resolveRole({ role: "zzz" });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.roleId, FALLBACK_ROLE);
  assert.equal(fallback.confidence, 0);
  // 兜底必须在给模型的回执里说出来，不能悄悄发生
  assert.match(roleGateNote(fallback), /promptFallback=true/);
});

test("命中率：生产出现的岗位名 ≥90% 能对上注册表（07 章 §9）", () => {
  const corpus = [
    // 实机与测试里真实出现过的岗位名
    "后端工程师",
    "代码审查员",
    "测试工程师",
    "运维排查",
    "文档工程师",
    "技术写作",
    "报告编辑",
    "数据整理员",
    "源码审查工程师（架构/正确性/性能/安全，只读）",
    "文件清点与内容提取专员",
    "结构化文档撰写与润色专员",
    "材料盘点员",
    "插件工程师",
    "代码审计",
    "代码阅读分析员",
    "数据分析师",
    "数据工程师",
    "数据整理",
    "图表校对",
    "文档校对",
    "文件清点与内容提取",
    "写报告",
    "写稿",
    "验收",
    "验收把关",
    "整理",
    "整理员",
    "只读探针",
    "浏览器操作",
    "浏览器操作手",
    "勘察",
    "勘察员",
    "学习通执行",
    "研发工程师",
    "前端开发",
    "数据库运维",
    "视觉验收员",
    "演示制作",
    "幻灯片设计",
    "调研分析师",
    "需求评审",
    "全栈工程师",
    "Golang 后端",
    "爬虫脚本",
    "网页抓取",
    "单元测试补全",
    "性能优化",
    "索引调优",
    "上线部署",
    "巡检机器人",
    "竞品对比报告",
    "用户手册编写",
  ];
  const misses = corpus.filter((t) => resolveRole({ role: t }).source === "fallback");
  const rate = ((corpus.length - misses.length) / corpus.length) * 100;
  assert.ok(
    rate >= 90,
    `命中率 ${rate.toFixed(1)}%（${corpus.length - misses.length}/${corpus.length}），低于 90%。` +
      `回落的岗位名：${misses.join("、") || "无"}——给 role-registry 的 strong/weak 补词，别放宽阈值`,
  );
});

test("建议角色：混合岗位能拿到一个可照抄的 roleId", () => {
  const s = suggestRole("资深全栈兼文档专家");
  assert.ok(s && isKnownRoleId(s.roleId), "要么给建议角色，要么这份退回说明没法照抄");
  const msg = mixedRoleRejection("资深全栈兼文档专家", s.roleId);
  assert.match(msg, /混合角色/, "退回说明要点名问题");
  assert.match(msg, new RegExp(`\\b${s.roleId}\\b`), "退回说明要给出具体 roleId");
  assert.match(msg, /拆成两名成员/, "给可执行的改法，不是只说不许");
});

test("G1 接线：create_member 拒绝混合岗位，正常岗位落盘时带上 roleId", () => {
  const root = tmpRoot();
  const store = new TeamStore(root);
  const tools = new ManagementTools(store, root);
  store.createTeam("t1", "测评组");

  assert.throws(
    () => tools.createMember("t1", member({ name: "混岗", role: "资深全栈兼文档专家", roleId: undefined })),
    /混合角色/,
    "混合岗位必须被写盘口拦下（不止风铃那条路径）",
  );

  const file = tools.createMember("t1", member({ name: "正牌", role: "代码审查员", roleId: undefined }));
  assert.ok(fs.existsSync(file));
  const saved = store.readMember("t1", "正牌");
  assert.equal(saved.roleId, "reviewer-quality", "没传 roleId 时按岗位名推断并落盘");
  assert.equal(saved.role, "代码审查员", "role 仍是人类可读的岗位名（界面要显示它）");
  assert.match(fs.readFileSync(file, "utf8"), /role_id: "reviewer-quality"/, "roleId 要进档案，G4 才有数据源");
});