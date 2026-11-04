// 工作区可读写（2026-11-04 用户："开发某个项目不能写代码有个屁用？"）：
// 成员在会话的项目目录里真改代码；删除类命令必须用户点头；.git/.lynn 不许写。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit, destructiveReason } from "../dist/main/toolkit.js";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ws-"));
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function scripted(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 1, completionTokens: 1 };
  };
}

async function until(fn, ms = 6000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

test("删除类命令识别：del/rm/rmdir/move/git clean 命中；普通命令不误伤", () => {
  for (const cmd of ["del a.txt", "rm -rf build", "rmdir /s old", "Remove-Item x -Recurse", "move a b", "git clean -fdx", "git reset --hard HEAD"]) {
    assert.ok(destructiveReason(cmd), `应识别为删除类：${cmd}`);
  }
  for (const cmd of ["npm test", "node scripts/delete-report.mjs", "git status", "npm run build"]) {
    assert.equal(destructiveReason(cmd), null, `不该误判：${cmd}`);
  }
});

test("Toolkit：删除命令走审批；没有审批通道一律拒绝；.git/.lynn 不许写", async () => {
  const root = tmp();
  const ws = path.join(root, "proj");
  fs.mkdirSync(ws, { recursive: true });

  const noHook = new Toolkit(ws);
  assert.match(await noHook.runCommand({ command: "del a.txt" }), /需要用户点头|已拒绝/);

  const asked = [];
  const gated = new Toolkit(ws, {
    onBeforeCommand: async (cmd) => {
      asked.push(cmd);
      return { ok: false, reason: "测试拒绝" };
    },
  });
  assert.match(await gated.runCommand({ command: "rm -rf build" }), /用户拒绝/);
  assert.deepEqual(asked, ["rm -rf build"]);

  assert.throws(() => gated.writeFile({ path: ".git/config", content: "x" }), /拒绝写入/);
  assert.throws(() => gated.writeFile({ path: ".lynn/mcp.json", content: "{}" }), /拒绝写入/);
  await gated.writeFile({ path: "src/a.ts", content: "export const a = 1;\n" });
  assert.ok(fs.existsSync(path.join(ws, "src", "a.ts")), "项目文件可以正常写");
});

test("派单：成员工作区 = 会话项目目录（可写），简报不污染项目", async () => {
  const root = tmp();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-proj-"));
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
    }),
    "utf-8",
  );
  const teams = new TeamStore(root);
  teams.createTeam("t1", "开发组");
  teams.writeMember("t1", {
    name: "阿黎",
    role: "工程师",
    goal: "改代码",
    boundaries: ["不改 .git"],
    tools: ["read_file", "write_file"],
    model: "m",
    limits: { maxTurns: 4, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "改动", evidence: ["文件"], acceptance: ["能跑"] },
    escalateWhen: "卡住",
    body: "",
  });

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("project.setRoot", { root: proj });
    kernel.memberChatFn = scripted([
      { toolCalls: [tc("1", "write_file", { path: "src/new.ts", content: "export const x = 2;\n" })] },
      { toolCalls: [tc("2", "submit_report", { text: "改好了", evidence: ["src/new.ts"] })] },
    ]);

    kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "阿黎", brief: "在 src 下加一个文件", deadline: "10 分钟" });
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-1");
    kernel.handle("decision.resolve", { id: plan.id, action: "start" });

    await until(() => fs.existsSync(path.join(proj, "src", "new.ts")), 6000, "文件写进项目目录");
    assert.equal(new TaskStore(root).get("task-1").workspaceRoot, proj, "工单记住读写工作区");
    assert.ok(!fs.existsSync(path.join(proj, "_brief.md")), "简报不该塞进用户项目");
    assert.ok(fs.existsSync(path.join(root, "tasks", "task-1", "_brief.md")), "简报在任务目录里");
  } finally {
    await kernel.dispose();
  }
});
