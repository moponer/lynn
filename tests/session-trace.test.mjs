// M0-13 Pi session 追溯 + M1-10 三来源同管线（MCP 分发）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-trace-"));

const member = () => ({
  name: "林工",
  role: "插件工程师",
  goal: "做一件事",
  boundaries: ["只改数据目录"],
  tools: ["read"],
  model: "deepseek-chat",
  limits: { maxTurns: 4, budgetTokens: 100000, wallClockMin: 5 },
  outputContract: { deliverable: "报告", evidence: ["e"], acceptance: ["done"] },
  escalateWhen: "缺依赖",
  body: "岗位说明",
});

test("M0-13：assign 与 report 记录都落 sessionId，readAssignments 能读回", () => {
  const root = tmp();
  const store = new TeamStore(root);
  const tools = new ManagementTools(store, root);
  store.createTeam("t1", "测评组");
  store.writeMember("t1", member());

  tools.assignTask("t1", {
    taskId: "task-1",
    member: "林工",
    brief: "做点事",
    deadline: "2026-11-03T18:00:00Z",
    tools: ["read"],
    sessionId: "sess-abc-123",
  });
  tools.reviewResult("t1", "task-1", { member: "林工", text: "做完了", evidence: ["tasks/task-1/workspace/out.md"], sessionId: "sess-abc-123" });

  const recs = store.readAssignments("t1", "task-1");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, "assign");
  assert.equal(recs[0].sessionId, "sess-abc-123", "派单记录可回溯到 Pi session");
  assert.equal(recs[1].kind, "report");
  assert.equal(recs[1].sessionId, "sess-abc-123", "回报记录可回溯到 Pi session");
});

test("M0-13：kernel 审查路径从 AgentHost.sessionId 兜底注入（host 缺席时记录照落、不编造 session）", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // 无 host（没起过 worker）：registerReport 兜底 sessionId=undefined，记录照落、不炸不编造
    kernel.registerReport("t-trace", "task-9", "林工", "做完了", ["tasks/task-9/workspace/out.md"]);
    const recs = new TeamStore(root).readAssignments("t-trace", "task-9");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].sessionId, undefined, "没有 Pi session 就如实缺省");
  } finally {
    await kernel.dispose();
  }
});

test("M1-10：MCP 工具经 dispatchShellTool 分发（Pi 路径与直连同源），未知 MCP 名不误吞", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // mock MCP 注册表：kernel.mcp 是私有字段，.mjs 直访替换（JS 无 private）
    const calls = [];
    kernel.mcp = {
      has: (name) => name === "mcp__demo__echo",
      execute: async (name, args) => {
        calls.push({ name, args });
        return `mock-mcp:${JSON.stringify(args)}`;
      },
      stopAll: async () => {},
      fingerprint: () => "mock",
    };
    const out = await kernel.executeToolCall("mcp__demo__echo", { msg: "hi" });
    assert.equal(out, "mock-mcp:{\"msg\":\"hi\"}");
    assert.equal(calls.length, 1);

    // 非 MCP 名落到正常路径（未知管理工具如实报）
    const unknown = await kernel.executeToolCall("bash", { command: "echo hi" });
    assert.match(unknown, /未知工具/);
  } finally {
    await kernel.dispose();
  }
});
