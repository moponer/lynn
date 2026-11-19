/**
 * 拦截记录进对话流（2026-11-19 用户要求，实机整改）。
 *
 * ## 用户原话
 *
 * "语音说有条命令被拦下、详情请看卡片，但界面上我没有卡片。这个不需要卡片，
 * 我只需要她告诉我：谁的命令、啥命令（干什么的）、她自己怎么处理、处理结果。
 * 这些要播报，而不是让我看卡片。这些她介入的事项，应该在对话流中按顺序展示。"
 *
 * ## 旧行为（被否）
 *
 * `auditTool` 落一张 `badge:"已拦截"` 的 tool 卡。问题是：
 *  - 卡落到成员出发会话，用户在自己看的会话里常常看不到；
 *  - 语音兜底只说"详情看卡片"，用户找不着卡，等于没说。
 *
 * ## 新行为
 *
 * 落一条 `kind:"lynn"` 的对话流消息，以她的口吻说清四要素，并带 speak 播报。
 * 同一条命令重复撞墙只记一次（不刷屏）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-block-"));

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

/** 直接调 private 的 auditTool（JS 没有真正的 private 限制） */
function fireBlocked(kernel, { teamId = "t1", taskId = "task-1", member = "林工", command, why }) {
  kernel.auditTool(teamId, taskId, member, { kind: "cmd_blocked", command, why, cwd: "C:\\ws" });
}

test("拦截：落一条 kind=lynn 的对话流消息，说清谁/什么命令/怎么处理（不是独立 tool 卡）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    fireBlocked(kernel, {
      command: `Get-ChildItem 'D:\\qcc\\Hermix Desktop'`,
      why: "越出工作区",
    });
    const feed = kernel.handle("session.snapshot").feed;
    // 不该再有 badge:"已拦截" 的 tool 卡
    assert.ok(!feed.some((c) => c.badge === "已拦截"), "不该再落 badge:已拦截 的 tool 卡");
    // 应有一条 kind:"lynn" 且 body/text 里带拦截信息
    const said = feed.filter((c) => c.kind === "lynn" && (c.text ?? "").includes("我拦了"));
    assert.equal(said.length, 1, `应有一条'我拦了'的对话流消息，实际 ${said.length}`);
    const card = said[0];
    assert.match(card.text, /林工/, "要说清是谁的命令");
    assert.match(card.text, /Get-ChildItem/, "要说清是什么命令");
    assert.match(card.text, /没有放行/, "要说清怎么处理 / 结果");
    assert.ok(card.speak && card.speak.includes("林工"), "要带可播报的一句话");
    assert.ok(card.speak.includes("没放行"), "播报要说清结果");
  } finally {
    await kernel.dispose();
  }
});

test("拦截：同一条命令重复撞墙只往对话流说一次（不刷屏）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const command = `type C:\\Users\\Administrator\\.hermix\\settings.json`;
    fireBlocked(kernel, { command, why: "越出工作区" });
    fireBlocked(kernel, { command, why: "越出工作区" });
    fireBlocked(kernel, { command, why: "越出工作区" });
    const said = kernel
      .handle("session.snapshot")
      .feed.filter((c) => c.kind === "lynn" && (c.text ?? "").includes("我拦了"));
    assert.equal(said.length, 1, `同一条命令只该说 1 次，实际 ${said.length}`);
  } finally {
    await kernel.dispose();
  }
});

test("拦截：不同命令各说一次（正常探索不该被吞）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    fireBlocked(kernel, { command: "Get-ChildItem 'D:\\a'", why: "越出工作区" });
    fireBlocked(kernel, { command: "type C:\\b\\x.txt", why: "越出工作区" });
    const said = kernel
      .handle("session.snapshot")
      .feed.filter((c) => c.kind === "lynn" && (c.text ?? "").includes("我拦了"));
    assert.equal(said.length, 2, `两条不同命令各说一次，实际 ${said.length}`);
  } finally {
    await kernel.dispose();
  }
});