/**
 * C7（2026-11-19）：长命令执行期间进度条也要动。
 *
 * 问题：progress 只在每轮 `turn` 事件里更新（turns/maxTurns）。一条跑 100s 的命令
 * 期间进度完全不动，用户看到"卡住"（实机把在跑看成卡死的经典形态）。
 * 修法：命令执行期间每 2s 推一次时间插值进度，命令结束即停。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMemberTask } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prog-"));

function profile() {
  return {
    name: "林工",
    role: "数据整理员",
    goal: "整理数据",
    boundaries: ["只动工作区"],
    tools: ["run_command", "write_file"],
    model: "m",
    limits: { maxTurns: 8, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: { deliverable: "out.md", evidence: [], acceptance: [] },
    escalateWhen: "",
    body: "",
  };
}

const tc = (name, args) => ({ id: `t-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) });

test("C7：跑一条 2 秒以上的命令时，期间应推进度事件（进度条不卡住）", async () => {
  const wd = tmp();
  const events = [];
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    if (calls === 1) {
      // Windows 上 ping 3 次约 2s，足够让 2s 定时器至少触发一次
      return {
        content: "",
        toolCalls: [tc("run_command", { command: "ping -n 3 127.0.0.1 > nul" })],
        promptTokens: 10,
        completionTokens: 5,
      };
    }
    return {
      content: "【完成】跑完了",
      toolCalls: [],
      promptTokens: 10,
      completionTokens: 5,
    };
  };
  const res = await runMemberTask({
    profile: profile(),
    brief: "【目标】跑命令\n【完成标准】跑完\n【材料与位置】工作区\n【限制】无",
    deadline: "10 分钟",
    tools: ["run_command", "write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(res.status, "reported", "整单应正常收尾");
  // 命令执行期间应有 turn 事件带 progress（说明进度在推）
  const midProgress = events.filter((e) => e.kind === "turn" && typeof e.progress === "number" && e.progress > 0);
  assert.ok(
    midProgress.length >= 2,
    `应在命令执行期间推进度事件（实际 ${midProgress.length} 条）——否则进度条会卡住`,
  );
  // 且这些进度不该越过下一轮的上限
  for (const e of midProgress) assert.ok(e.progress <= 95, `进度不该超过 95（实际 ${e.progress}）`);
});
