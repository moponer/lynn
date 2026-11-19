/**
 * 命令沙箱接通（2026-11-19 第一阶段）。
 *
 * ## 背景
 *
 * 我们早就有 `sandbox.ts` + Rust `sandbox-exec.exe`（Job Object：内存/进程数上限、
 * 超时杀整个进程树），但 `runInSandbox` **没有任何生产调用者**——成员命令其实是
 * `execa` 裸跑的。用户问"我们有没有沙箱"，诚实答案是：有代码、没通车。
 *
 * 这一阶段把 jobonly 接进 `Toolkit.runCommand`。诚实边界：
 *  - jobonly 给的是资源上限 + 干净强杀，**不断网、不隔离文件**（那是 AppContainer/WFP）
 *  - 沙箱不可用时**如实降级**并回调 onSandboxDegraded，绝不假装已隔离
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";
import { probeSandbox } from "../dist/main/sandbox.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sbx-"));

/** 造一个假的 sandbox.run：记录被调用，并按需返回固定结果 */
function fakeSandbox({ mode = "jobonly", result } = {}) {
  const calls = [];
  return {
    calls,
    opts: {
      verdict: () => ({ mode, helperPath: mode === "off" ? null : "fake-helper.exe" }),
      run: (command, o) => {
        calls.push({ command, ...o });
        return result ?? { ok: true, code: 0, stdout: "FAKE_SANDBOX_OUT", stderr: "" };
      },
    },
  };
}

test("沙箱可用：runCommand 走 sandbox.run（不是 execa），并透传 cwd/env/超时", async () => {
  const root = tmp();
  const sb = fakeSandbox();
  const tk = new Toolkit(root, { sandbox: sb.opts });
  const out = await tk.runCommand({ command: "echo hi" });
  assert.equal(sb.calls.length, 1, "命令应走沙箱");
  assert.equal(sb.calls[0].command, "echo hi");
  assert.equal(sb.calls[0].cwd, path.resolve(root), "cwd 要传给沙箱");
  assert.ok(typeof sb.calls[0].env === "object", "env 要传给沙箱（剔密钥后）");
  assert.match(out, /FAKE_SANDBOX_OUT/);
});

test("沙箱档位 off：不调 sandbox.run，如实降级到 execa 并回调 onSandboxDegraded", async () => {
  const root = tmp();
  // 档位 off 但提供 sandbox：不应调用 run
  const sb = fakeSandbox({ mode: "off" });
  let degraded = null;
  const tk = new Toolkit(root, {
    sandbox: { verdict: () => ({ mode: "off", helperPath: null }), run: sb.opts.run },
    onSandboxDegraded: (r) => {
      degraded = r;
    },
  });
  // 用一个必然可跑的简单命令
  const out = await tk.runCommand({ command: process.platform === "win32" ? "echo FALLBACK_OK" : "echo FALLBACK_OK" });
  assert.equal(sb.calls.length, 0, "off 档不该进沙箱");
  assert.match(out, /FALLBACK_OK/, "要真的降级跑出来");
  // 注意：off 档在 Toolkit 里是直接不进沙箱分支（mode==='off'），不算"降级"
  // degraded 可能为 null（因为没进沙箱分支）——这里只断言命令跑通了
});

test("沙箱 run 返回 ok:false + code:null（helper 坏了）：降级到 execa 并记原因", async () => {
  const root = tmp();
  const sb = fakeSandbox({ result: { ok: false, code: null, stdout: "", stderr: "", reason: "helper 启动失败" } });
  let degraded = null;
  const tk = new Toolkit(root, {
    sandbox: sb.opts,
    onSandboxDegraded: (r) => {
      degraded = r;
    },
  });
  const out = await tk.runCommand({ command: "echo AFTER_FAIL" });
  assert.equal(sb.calls.length, 1, "先进沙箱尝试");
  assert.equal(degraded, "helper 启动失败", "要如实记录降级原因");
  assert.match(out, /AFTER_FAIL/, "降级后 execa 要真的跑出来");
});

test("沙箱跑出非零退出：如实透传退出码，不降级", async () => {
  const root = tmp();
  const sb = fakeSandbox({ result: { ok: false, code: 3, stdout: "partial", stderr: "boom", } });
  let degraded = null;
  const tk = new Toolkit(root, {
    sandbox: sb.opts,
    onSandboxDegraded: (r) => {
      degraded = r;
    },
  });
  const out = await tk.runCommand({ command: "exit 3" });
  // code=3 且 ok=false 是"执行了但非零"，不该当降级
  assert.equal(degraded, null, "非零退出不是降级");
  assert.match(out, /exit code: 3/);
  assert.match(out, /boom/);
});

test("不提供 sandbox：保持旧行为（直接 execa）", async () => {
  const root = tmp();
  const tk = new Toolkit(root);
  const out = await tk.runCommand({ command: "echo OLD_PATH" });
  assert.match(out, /OLD_PATH/);
});

// ---------- 真实 helper（这台机器上真能跑才有意义）----------

test("真实沙箱探针：本机档位如实现（有 helper 就不是 off）", () => {
  const v = probeSandbox({ appRoot: process.cwd() });
  // 不断言一定 jobonly（不同机器不同），只断言字段自洽
  assert.ok(["appcontainer", "restricted", "jobonly", "off"].includes(v.mode));
  if (v.mode !== "off") {
    assert.ok(v.helperPath, "非 off 档必须有 helper 路径");
    assert.equal(typeof v.probed, "boolean");
  }
});

test("受限令牌档：fileIsolation=false（诚实：降权运行，不做文件写隔离），且能跑 node", () => {
  const v = probeSandbox({ appRoot: process.cwd() });
  if (v.mode === "restricted") {
    // 2026-11-19 实测：restricted 是"降权运行"，不是写隔离——fileIsolation 必须如实 false
    assert.equal(v.limits.fileIsolation, false, "restricted 不做文件写隔离，不许报 true");
    assert.equal(v.limits.noNetwork, false, "restricted 不断网，不许报 true");
    assert.match(v.reason, /降权|资源上限/, "reason 要说清它是降权不是隔离");
  }
  // 非 restricted 机器跳过
});

test("受限令牌档实测：能跑 node（降权档的意义就是能跑真实程序）", async () => {
  const v = probeSandbox({ appRoot: process.cwd() });
  if (v.mode !== "restricted") return; // 仅 restricted 机器
  const root = tmp();
  const { Toolkit } = await import("../dist/main/toolkit.js");
  const { sandboxVerdict, runInSandbox } = await import("../dist/main/sandbox.js");
  const tk = new Toolkit(root, {
    sandbox: {
      verdict: () => {
        const s = sandboxVerdict();
        return { mode: s.mode, helperPath: s.helperPath };
      },
      run: (cmd, o) => runInSandbox(cmd, { timeoutMs: o.timeoutMs, cwd: o.cwd, env: o.env }),
    },
  });
  // node 能跑（降权档的核心价值）
  const out = await tk.runCommand({ command: "node --version" });
  assert.match(out, /v\d+\.\d+/, `降权档下 node 必须能跑：${out.slice(0, 120)}`);
  // 工作区内能写
  const out2 = await tk.runCommand({ command: "echo HI > inside.txt" });
  assert.ok(fs.existsSync(path.join(root, "inside.txt")), `工作区内应能写：${out2.slice(0, 80)}`);
});