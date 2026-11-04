import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "./dist/main/kernel.js";
import { TeamStore } from "./dist/main/team-store.js";
import { TaskStore } from "./dist/main/task-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-dbg-"));
fs.writeFileSync(
  path.join(root, "settings.json"),
  JSON.stringify({ model: { provider: "test", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() } }),
);
const teams = new TeamStore(root);
teams.createTeam("t1", "组");
teams.writeMember("t1", {
  name: "林工", role: "数据整理员", goal: "出月报", boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"], model: "m",
  limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["可对账"] },
  escalateWhen: "卡住", body: "",
});
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const script = [
  { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报" })] },
  { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["report.md"] })] },
];

const kernel = new Kernel(root);
await kernel.init();
kernel.memberChatFn = async (input) => {
  const step = script.shift() ?? { content: "done" };
  input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
  return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 1, completionTokens: 1 };
};
kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "林工", brief: "出月报", deadline: "30 分钟" });
const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan");
console.log("resolve:", JSON.stringify(kernel.handle("decision.resolve", { id: plan.id, action: "start" })));
await new Promise((r) => setTimeout(r, 2500));
const tasks = new TaskStore(root);
console.log("status:", tasks.get("task-1").status);
console.log("workspace:", fs.readdirSync(path.join(root, "tasks", "task-1", "workspace")));
for (const c of kernel.handle("session.snapshot").feed.slice(-8)) {
  console.log("CARD", c.badge, "|", c.title, "|", (c.text ?? c.body ?? "").slice(0, 160).replace(/\n/g, " / "));
}
await kernel.dispose();
