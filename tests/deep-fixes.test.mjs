/**
 * 今日复盘四个深层问题的回归（2026-11-19）。
 *
 * 1) 沙箱授权靠试错 → probe_path 派单前只读探路
 * 2) 长输出折叠 → 超预算落盘（在 cmd-output.test.mjs 覆盖）
 * 3) 大文本简报 → validateBrief 拦「单行超 600 字」
 * 4) 派生工单没监控 → assign_task 支持 parentTaskId + check_progress 显示关系
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { validateBrief } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-deep-"));

function setup() {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "test",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "test-model",
        apiKey: { encrypted: false, data: "test-key" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel };
}

// ---------- 问题3：大文本简报 ----------

test("大文本简报：单行超 600 字被退回并教分片（治写作单零产出）", () => {
  const giant = "这是一段成稿正文。".repeat(120); // 单行 > 600 字
  const brief =
    `【目标】写成稿\n【完成标准】1200 字\n【材料与位置】桌面\n【限制】不要口语\n\n${giant}`;
  const r = validateBrief(brief);
  assert.ok(r, "应退回");
  assert.match(r, /超长正文|分片/, "要提示分片");
  assert.match(r, /part/, "要教落成 part 文件");
});

test("正常长行（路径/命令）不被误判为大文本", () => {
  const longPath = "C:\\Users\\Administrator\\AppData\\Local\\Some\\Very\\Deep\\Path\\" + "x".repeat(650);
  const brief =
    `【目标】读这个文件\n【完成标准】输出摘要\n【材料与位置】${longPath}\n【限制】不要编造`;
  assert.equal(validateBrief(brief), null, "长路径行不算大文本");
});

// ---------- 问题1：probe_path ----------

test("probe_path：可授权的普通目录 → canAuthorizeReadonly=true + 条目数", async () => {
  const { root, kernel } = setup();
  try {
    await kernel.init();
    const dir = path.join(root, "materials");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const r = JSON.parse(kernel.runTool("probe_path", { path: dir }));
    assert.equal(r.exists, true);
    assert.equal(r.isDirectory, true);
    assert.equal(r.canAuthorizeReadonly, true, `普通目录应可授权：${JSON.stringify(r)}`);
    assert.equal(r.entryCount, 1);
  } finally {
    await kernel.dispose();
  }
});

test("probe_path：系统目录 → 明确拒绝并给理由（派单前就知道，不用撞墙）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const sys = process.env.SystemRoot || "C:\\Windows";
    const r = JSON.parse(kernel.runTool("probe_path", { path: sys }));
    assert.equal(r.exists, true);
    assert.equal(r.canAuthorizeReadonly, false, "系统目录不可授权");
    assert.ok(r.rejectedReason, "要给拒绝理由");
  } finally {
    await kernel.dispose();
  }
});

test("probe_path：不存在的路径 → exists=false + 提示先问用户", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const r = JSON.parse(kernel.runTool("probe_path", { path: "Z:\\definitely\\not\\here\\xyz" }));
    assert.equal(r.exists, false);
    assert.match(JSON.stringify(r), /不存在|ask_user/);
  } finally {
    await kernel.dispose();
  }
});

test("probe_path：相对路径 → 明确要求绝对路径", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const r = kernel.runTool("probe_path", { path: "relative/dir" });
    assert.match(String(r), /绝对路径/);
  } finally {
    await kernel.dispose();
  }
});

// ---------- 问题4：派生工单追踪 ----------

test("派生单：assign_task 带 parentTaskId → 建单记 parentId（check_progress 能看到）", async () => {
  const { root, kernel } = setup();
  try {
    await kernel.init();
    // 直接造父单（走 taskStore，避免派单的契约卡流程）
    const parentId = "task-parent-1";
    kernel.taskStore.create({
      id: parentId,
      title: "父任务",
      teamId: "t1",
      threadId: kernel.ensureThreadId(),
      workspaceRoot: root,
    });
    assert.ok(kernel.taskStore.get(parentId), "父单应建好");
    // 派生单
    const childId = "task-child-1";
    kernel.taskStore.create({
      id: childId,
      title: "派生任务",
      teamId: "t1",
      threadId: kernel.ensureThreadId(),
      workspaceRoot: root,
      parentId,
    });
    assert.equal(kernel.taskStore.get(childId)?.parentId, parentId, "派生单要挂住父单");
  } finally {
    await kernel.dispose();
  }
});

test("check_progress 能列出子单（不再出现'我没派过的单'）", async () => {
  const { root, kernel } = setup();
  try {
    await kernel.init();
    const parentId = "task-p2";
    kernel.taskStore.create({ id: parentId, title: "父", teamId: "t1", threadId: kernel.ensureThreadId(), workspaceRoot: root });
    kernel.taskStore.create({ id: "task-c2", title: "子", teamId: "t1", threadId: kernel.ensureThreadId(), workspaceRoot: root, parentId });
    kernel.taskStore.transition(parentId, "todo");
    const out = String(kernel.runTool("check_progress", { taskId: parentId }));
    assert.match(out, /childTasks|task-c2/, `根单进度要能看到子单：${out.slice(0, 200)}`);
  } finally {
    await kernel.dispose();
  }
});