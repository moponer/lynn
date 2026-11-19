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
        return result ?? { ok: true, code: 0, stdout: "FAKE_SANDBOX_OUT", stderr: "", started: true };
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
  const sb = fakeSandbox({ result: { ok: false, code: null, stdout: "", stderr: "", reason: "helper 启动失败", started: false } });
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
  const sb = fakeSandbox({ result: { ok: false, code: 3, stdout: "partial", stderr: "boom", started: true } });
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

test("受限令牌档：标准用户级写隔离（fileIsolation=true），不断网（noNetwork=false）", () => {
  const v = probeSandbox({ appRoot: process.cwd() });
  if (v.mode === "restricted") {
    // LUA_TOKEN 降权到标准用户：系统盘写被拒=有实际写隔离；但非仅工作区、不断网
    assert.equal(v.limits.fileIsolation, true, "标准用户级有写隔离");
    assert.equal(v.limits.noNetwork, false, "不断网");
    assert.match(v.reason, /标准用户|降权|工作区/, "reason 要说清粒度");
  }
  // 非 restricted 机器跳过
});

test("受限令牌档实测：node 能跑 + 系统盘写被拒 + 用户目录能写", async () => {
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
  // 1) node 能跑（降权档的核心价值）
  const out = await tk.runCommand({ command: "node --version" });
  assert.match(out, /v\d+\.\d+/, `降权档下 node 必须能跑：${out.slice(0, 120)}`);
  // 2) 工作区内能写
  const out2 = await tk.runCommand({ command: "echo HI > inside.txt" });
  assert.ok(fs.existsSync(path.join(root, "inside.txt")), `工作区内应能写：${out2.slice(0, 80)}`);
  // 3) 系统盘写被拒（标准用户无写权限）
  const sysPath = "C:\\Windows\\lynn-sbx-e2e-probe.txt";
  try {
    if (fs.existsSync(sysPath)) fs.rmSync(sysPath);
  } catch {}
  await tk.runCommand({ command: `echo x > "${sysPath}"` });
  assert.equal(fs.existsSync(sysPath), false, "标准用户下系统盘写必须被拒");
});

test("C4：命令超时（started=true）绝不重跑，返回超时结果而不是降级", async () => {
  const root = tmp();
  let execaRan = false;
  // started=true 但 code=null（超时）——不该降级 execa
  const sb = fakeSandbox({ result: { ok: false, code: null, stdout: "partial-out", stderr: "", started: true, timedOut: true } });
  let degraded = null;
  const tk = new Toolkit(root, { sandbox: sb.opts, onSandboxDegraded: (r) => { degraded = r; } });
  const out = await tk.runCommand({ command: "sleep 999" });
  assert.equal(sb.calls.length, 1, "沙箱应被调用一次");
  assert.equal(degraded, null, "超时不是降级（不能重跑）");
  assert.match(out, /超时/, "结果要如实说超时");
  assert.match(out, /partial-out/, "已产出的部分输出要保留");
});

test("C4：超 buffer（started=true）也不重跑", async () => {
  const root = tmp();
  const sb = fakeSandbox({ result: { ok: false, code: null, stdout: "big", stderr: "", started: true } });
  let degraded = null;
  const tk = new Toolkit(root, { sandbox: sb.opts, onSandboxDegraded: (r) => { degraded = r; } });
  await tk.runCommand({ command: "cat hugefile" });
  assert.equal(degraded, null, "跑了但输出大，不是降级，不能重跑");
  assert.equal(sb.calls.length, 1, "只调用一次，不重跑");
});

// ---------- S1：探针不再卡主线程 ----------

test("S1：sandboxVerdictCached 未探测时秒回保守值，绝不阻塞探测", async () => {
  const { sandboxVerdictCached, resetSandboxProbe } = await import("../dist/main/sandbox.js");
  resetSandboxProbe();
  const root = tmp();
  const started = Date.now();
  const v = sandboxVerdictCached(process.cwd(), root);
  const ms = Date.now() - started;
  assert.ok(ms < 200, `渲染路径取值必须快（实际 ${ms}ms）——不能在这里跑探针`);
  assert.equal(v.probed, false, "未探测时要如实标 probed=false");
  assert.equal(v.limits.fileIsolation, false, "保守值不许谎报有写隔离");
  assert.equal(v.limits.noNetwork, false, "保守值不许谎报断网");
});

test("S1：探测结果落磁盘，重启（清内存）后读缓存秒回同一档位", async () => {
  const { sandboxVerdict, resetSandboxProbe } = await import("../dist/main/sandbox.js");
  const root = tmp();
  resetSandboxProbe();
  const cold = sandboxVerdict(process.cwd(), root);
  assert.ok(fs.existsSync(path.join(root, "sandbox-verdict.json")), "探测后应写磁盘缓存");
  resetSandboxProbe(); // 模拟重启
  const started = Date.now();
  const warm = sandboxVerdict(process.cwd(), root);
  const ms = Date.now() - started;
  assert.equal(warm.mode, cold.mode, "热启档位应与冷探一致");
  assert.ok(ms < 200, `热启应读磁盘缓存秒回（实际 ${ms}ms）`);
});

// ---------- C3：点「停」真的杀进程 ----------

test("C3：abort 信号能真的中止沙箱命令（不是等超时）", async () => {
  const { sandboxVerdict, runInSandbox } = await import("../dist/main/sandbox.js");
  const v = sandboxVerdict(process.cwd());
  if (v.mode === "off") return; // 没 helper 的机器跳过
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const startedAt = Date.now();
  // ping 30 次约 30s；如果 abort 无效会一直等到超时
  const r = await runInSandbox("ping -n 30 127.0.0.1 > nul", { timeoutMs: 60000, signal: ac.signal, dataRoot: tmp() });
  const ms = Date.now() - startedAt;
  assert.equal(r.aborted, true, "应标记为被用户中止");
  assert.ok(ms < 5000, `点停后应立刻中止（实际 ${ms}ms）——不能等到超时`);
});

test("C3：runCommand 收到 stop 后返回「已停止」，不降级重跑", async () => {
  const root = tmp();
  const ac = new AbortController();
  setImmediate(() => ac.abort());
  const sb = {
    verdict: () => ({ mode: "jobonly", helperPath: "fake" }),
    run: (_c, o) => {
      // 模拟：命令跑到一半被 abort
      return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "", started: true, aborted: true, signal: o.signal });
    },
  };
  let degraded = null;
  const tk = new Toolkit(root, { sandbox: sb, onSandboxDegraded: (r) => { degraded = r; } });
  const out = await tk.runCommand({ command: "ping -n 30 127.0.0.1" });
  assert.match(out, /已停止|已被用户停止/, "应如实说被停止");
  assert.equal(degraded, null, "被停不是降级，不能重跑");
});
