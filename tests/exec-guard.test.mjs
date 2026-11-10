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
