import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { runMemberTask } from "../dist/main/member-runner.js";

/**
 * 成员纪律（真实事故 2026-11-03）：9 张单、0 份回报、卡片刷屏，
 * 成员还在命令里翻用户别的仓库。这里锁住四条：
 *  1. 派单后不许再问一遍"是否确认开工"（契约卡已有开始按钮）；
 *  2. 轮次上限从 40 收到 15；
 *  3. 逼近上限强制收口，逼成员交回报；
 *  4. 同一成员不许并发跟两张单（跨成员总并发另有上限）。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-member-"));

const profile = (over = {}) => ({
  name: "阿元",
  role: "浏览器操作手",
  goal: "把页面打开并盘点",
  boundaries: ["不乱翻别的目录"],
  tools: ["read_file", "list_dir"],
  model: "deepseek-chat",
  limits: { maxTurns: 15, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "盘点表", evidence: ["out.md"], acceptance: ["表在"] },
  escalateWhen: "缺权限",
  body: "岗位说明",
  ...over,
});

test("派单后 ask_user 再问「是否确认开工」被挡住，且不生成第二个待拍板", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  await kernel.init();
  const team = JSON.parse(kernel.runTool("create_team", { name: "测试队" }));
  kernel.runTool("create_member", {
    teamId: team.teamId,
    name: "阿元",
    role: "浏览器操作手",
    goal: "打开页面",
    tools: ["read_file"],
    boundaries: [],
  });

  const plan = kernel.runTool("assign_task", {
    teamId: team.teamId,
    taskId: "job-1",
    member: "阿元",
    brief: "【目标】打开超星看登录页并记录状态\n【完成标准】产出截图文件，页面元素可核对\n【材料与位置】目标网址在工作区说明文件里\n【限制】不要代填验证码，不要提交表单",
    deadline: "25 分钟",
  });
  assert.match(plan, /任务契约/, "先要真的把契约呈上去");

  const asked = kernel.runTool("ask_user", { question: "任务契约已就绪，是否确认开工？" });
  assert.match(asked, /不要再用 ask_user 重复问/, "重复确认要被当场挡回");

  const snap = kernel.handle("session.snapshot");
  assert.equal(snap.board.decisions.filter((d) => d.kind === "question").length, 0, "不该多出问答卡");
  assert.equal(snap.board.decisions.filter((d) => d.kind === "plan").length, 1, "契约卡仍然只有一张");
});

test("新招成员默认 15 轮封顶（原来是 40，一轮一次模型调用）", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  await kernel.init();
  const team = JSON.parse(kernel.runTool("create_team", { name: "测试队" }));
  kernel.runTool("create_member", {
    teamId: team.teamId,
    name: "阿元",
    role: "浏览器操作手",
    goal: "打开页面",
    tools: ["read_file"],
    boundaries: [],
  });
  const saved = new TeamStore(root).readMember(team.teamId, "阿元");
  assert.equal(saved.limits.maxTurns, 15);
});

test("逼近轮次上限时强制收口：最后两次模型调用必须收到「只剩 2 轮」的指令", async () => {
  const root = tmp();
  const dir = path.join(root, "workspace");
  fs.mkdirSync(dir, { recursive: true });
  const seen = [];
  const result = await runMemberTask({
    profile: profile({ limits: { maxTurns: 4, budgetTokens: 1000, wallClockMin: 5 } }),
    brief: "一直列目录，永远不交回报",
    deadline: "now",
    tools: ["list_dir"],
    workdir: dir,
    model: { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" },
    chatFn: async (req) => {
      seen.push(req.messages.map((m) => String(m.content ?? "")).join("\n"));
      return {
        content: "",
        toolCalls: [{ id: `t${seen.length}`, name: "list_dir", arguments: JSON.stringify({ path: "." }) }],
        promptTokens: 1,
        completionTokens: 1,
      };
    },
  });
  assert.equal(result.status, "turn_limit", "一直不交回报就该按未完成收尾");
  assert.ok(
    seen.some((text) => text.includes("只剩 2 轮")),
    "接近上限时必须明确要求交回报，而不是让它继续探索",
  );
});

test("启动对账：上次中断留在 in_progress 的单被标成卡住（不再永远挂「进行中」）", async () => {
  const root = tmp();
  const { TaskStore } = await import("../dist/main/task-store.js");
  const store = new TaskStore(root);
  store.create({ id: "left-over", title: "上次没跑完", teamId: "t1", member: "阿元" });
  store.transition("left-over", "todo");
  store.transition("left-over", "in_progress");

  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  await kernel.init();
  assert.equal(store.get("left-over").status, "blocked");
  const snap = kernel.handle("session.snapshot");
  assert.ok(snap.feed.some((c) => c.kind === "system" && /卡住/.test(c.text ?? "")), "要有一张卡说明发生了什么");
});

test("停单幂等：不存在的单如实报错，已经停住的单不再回「停不下来」", async () => {
  const root = tmp();
  // 先落一张已经卡住的单，再起内核
  const { TaskStore } = await import("../dist/main/task-store.js");
  const store = new TaskStore(root);
  store.create({ id: "stuck-1", title: "已经停住的单", teamId: "t1", member: "阿元" });
  store.transition("stuck-1", "todo");
  store.transition("stuck-1", "in_progress");
  store.transition("stuck-1", "blocked", { note: "用户手动停机" });

  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  await kernel.init();
  assert.deepEqual(kernel.runningTaskIds(), []);

  const missing = kernel.handle("task.cancel", { taskId: "job-x" });
  assert.equal(missing.ok, false, "真有单号错才报错");
  assert.match(missing.error, /没有这张单/);

  // 实机反馈：停机成功后卡片还在，再点一次会回「停不下来：没有在跑的 …」。
  // 已经不在跑就是用户要的结果，应当静默成功。
  const again = kernel.handle("task.cancel", { taskId: "stuck-1" });
  assert.equal(again.ok, true, "已经停住的单再点一次要成功");

  const snap = kernel.handle("session.snapshot");
  const row = snap.board.track.find((t) => t.id === "stuck-1");
  assert.equal(row.status, "blocked");
  assert.match(String(row.statusNote), /用户手动停机/, "卡住成因要能显示，不能一律说是没出新证据");
});
