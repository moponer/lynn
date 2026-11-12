import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit, findPathEscape } from "../dist/main/toolkit.js";
import { runMemberTask } from "../dist/main/member-runner.js";

/**
 * 真实事故：成员（探针）在任务工作区里跑 powershell，
 * 去 `Get-ChildItem 'D:\qcc\Hermix Desktop'`、`C:\Users\...\.hermix` 翻用户别的项目。
 * 文件工具被钉在工作区，命令却能读全盘——这是那个洞的封堵。
 *
 * 边界诚实声明：这里只拦**字面量**绝对路径；拼出来的路径拦不住，OS 级隔离是 M1-11。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));

test("findPathEscape：用户别的仓库/家目录/上跳一律拦下", () => {
  const root = path.join(tmp(), "workspace");
  fs.mkdirSync(root, { recursive: true });

  const bad = [
    `powershell -Command "Get-ChildItem 'D:\\qcc\\Hermix Desktop' -Force"`,
    `Get-ChildItem 'C:\\Users\\Administrator\\.hermix' -Force`,
    `cat /etc/passwd`,
    `cd ..\\..\\然后乱翻`,
    `type %USERPROFILE%\\.hermix\\settings.json`,
  ];
  for (const cmd of bad) {
    assert.ok(findPathEscape(cmd, root), `应当拦下：${cmd}`);
  }
});

test("findPathEscape：工作区内的绝对路径、相对路径、URL 都放行", () => {
  const root = path.join(tmp(), "workspace");
  fs.mkdirSync(root, { recursive: true });

  const inside = [
    `New-Item -ItemType Directory -Force -Path "${root}\\_raw"`,
    `type _raw\\README.md`,
    `curl -s https://api.github.com/repos/citrolabs/ego-lite`,
    `echo hello`,
  ];
  for (const cmd of inside) {
    assert.equal(findPathEscape(cmd, root), null, `不该拦：${cmd}`);
  }
});

test("runCommand：越界命令真的不执行，并记一条 cmd_blocked 审计", async () => {
  const root = tmp();
  const audits = [];
  const t = new Toolkit(root, { onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: `Get-ChildItem 'D:\\qcc\\Hermix Desktop'` });
  assert.match(out, /已拒绝执行/);
  assert.match(out, /越出工作区/);
  assert.equal(audits.filter((a) => a.kind === "cmd_blocked").length, 1);
});

test("成员被中止：不再发模型请求，直接如实报 aborted", async () => {
  const root = tmp();
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const result = await runMemberTask({
    profile: {
      name: "探针",
      role: "只读探针",
      goal: "看看",
      boundaries: [],
      tools: ["read_file"],
      model: "x",
      limits: { maxTurns: 5, budgetTokens: 1000, wallClockMin: 5 },
      outputContract: { deliverable: "d", evidence: ["e"], acceptance: ["a"] },
      escalateWhen: "x",
      body: "",
    },
    brief: "随便",
    deadline: "now",
    tools: ["read_file"],
    workdir: root,
    model: { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" },
    signal: controller.signal,
    chatFn: async () => {
      called += 1;
      throw new Error("不该被调用");
    },
  });
  assert.equal(called, 0, "已中止就不该再打模型");
  assert.equal(result.status, "aborted");
  assert.match(result.report, /停止/);
});

/**
 * 实机误报（2026-11-11）：成员为了统计 .tsx 数跑
 *   Get-ChildItem ... | Where-Object { $_.FullName -notmatch 'node_modules|\.git|target|\\.cargo' }
 * 被拦成「越出工作区：\\.cargo」；`dir /s /b`、`cmd /c` 被拦成「/s」「/c」。
 * 三条都是把命令开关 / 正则字面量当成了路径，成员只能改写重试（白烧轮次）。
 */
test("findPathEscape：命令开关与正则字面量不再被当成路径", () => {
  const root = path.join(tmp(), "workspace");
  fs.mkdirSync(root, { recursive: true });
  const ok = [
    `dir /s /b "${root}"`,
    `cmd /c "echo TEMP=%TEMP%"`,
    `Get-ChildItem -Path '${root}' -Directory -Recurse -Filter 'components' | Where-Object { $_.FullName -notmatch 'node_modules|\\.git|target|\\.cargo' }`,
    `Select-String -Path "${root}\\a.txt" -Pattern 'a\\.b|c\\.d'`,
  ];
  for (const cmd of ok) {
    assert.equal(findPathEscape(cmd, root), null, `不该拦：${cmd}`);
  }
});

test("删除分级：本单刚造的文件自动放行，不弹审批卡", async () => {
  const root = tmp();
  const audits = [];
  let asked = 0;
  const t = new Toolkit(root, {
    onAudit: (ev) => audits.push(ev),
    runStartedAt: Date.now() - 1_000,
    onBeforeCommand: async () => {
      asked += 1;
      return { ok: true };
    },
  });
  // 成员自己先落一个探针文件（实机命令：echo probe> probe-fallback.txt & del probe-fallback.txt）
  fs.writeFileSync(path.join(root, "probe-fallback.txt"), "probe", "utf-8");
  const out = await t.runCommand({ command: "del probe-fallback.txt" });
  assert.equal(asked, 0, "自己刚造的文件不该再打扰用户");
  assert.ok(audits.some((a) => a.kind === "cmd_auto"), "要留一条自动放行审计");
  assert.doesNotMatch(out, /用户拒绝/);
});

test("删除分级：工作区里的既有文件仍要用户点头；越界删除先拒、不弹卡", async () => {
  const root = tmp();
  let asked = 0;
  let verdict = false;
  const t = new Toolkit(root, {
    onBeforeCommand: async () => {
      asked += 1;
      return { ok: verdict };
    },
  });
  const keep = path.join(root, "keep.txt");
  fs.writeFileSync(keep, "x", "utf-8");
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(keep, past, past); // 开工前就存在 → 不是本单产物

  const denied = await t.runCommand({ command: "del keep.txt" });
  assert.equal(asked, 1, "既有文件必须问人");
  assert.match(denied, /用户拒绝/);
  assert.ok(fs.existsSync(keep), "被拒就不该真删");

  // 越界：直接拒，连审批都不该弹（以前先弹卡、点了头再拒，白打扰一次）
  asked = 0;
  const escaped = await t.runCommand({ command: "del D:\\qcc\\不存在的文件.txt" });
  assert.equal(asked, 0, "越界命令不该弹审批卡");
  assert.match(escaped, /越出工作区/);
});
