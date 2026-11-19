/**
 * 沙箱接入层（P5-1b / 13 章 M4–M5）。
 *
 * 这组断言的重心**不是**"沙箱能跑"，而是"沙箱缺席时会不会撒谎"：
 *  1. helper 缺失 / 探针失败 → mode=off 或 jobonly，**绝不允许**出现 appcontainer；
 *  2. 只有 launchVerified=true 才认 appcontainer；探针自己说 mode=appcontainer 也不算
 *     （"能建 profile"和"能隔离进程"是两件事）；
 *  3. jobonly 下必须如实说 noNetwork=false / fileIsolation=false——它确实挡不住这两项。
 *
 * 本机实测（2026-11-17）：内置管理员账户，AppContainer 的 profile 能建（provisioned=true），
 * 但容器内启动路径未实现未验证 → launchVerified=false → 实际 jobonly。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeSandbox, sandboxVerdict, resetSandboxProbe, runInSandbox } from "../dist/main/sandbox.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sandbox-"));
}

test("helper 不存在 → mode=off，且 probed=false（「不知道」不等于「不支持」）", () => {
  const empty = tmp();
  const v = probeSandbox({ appRoot: empty });
  // appRoot 只影响第一个候选；dist/ 与 target/ 里可能真的有 helper，所以这里只断言：
  // 如果最终没找到或没探成功，档位必须是 off，绝不能是 appcontainer
  if (!v.helperPath) {
    assert.equal(v.mode, "off");
    assert.equal(v.probed, false);
    assert.match(v.reason, /工具层边界|没有原生沙箱/);
  }
  assert.notEqual(v.mode, "appcontainer", "没有验证过的路径，永远不许报 appcontainer");
});

test("档位判定只认 launchVerified，不认探针自报的 mode", () => {
  const v = sandboxVerdict();
  if (v.mode === "appcontainer") {
    assert.equal(v.launchVerified, true, "报了 appcontainer 就必须是验证过的");
    assert.equal(v.limits.noNetwork, true);
    assert.equal(v.limits.fileIsolation, true);
  } else if (v.mode === "restricted") {
    // 标准用户级降权：系统盘写被拒=有写隔离；但非仅工作区、不断网
    assert.equal(v.launchVerified, true, "报 restricted 必须实测起得来");
    assert.equal(v.limits.fileIsolation, true, "标准用户级有写隔离");
    assert.equal(v.limits.noNetwork, false, "restricted 不断网，不许写 true");
  } else {
    assert.equal(v.launchVerified, false);
    // jobonly / off 必须如实承认挡不住断网与文件隔离
    assert.equal(v.limits.noNetwork, false, "jobonly 挡不住断网，不许写 true");
    assert.equal(v.limits.fileIsolation, false, "jobonly 挡不住文件 ACL，不许写 true");
  }
});

test("探针结论要能解释原因（不是只给个布尔或错误码）", () => {
  const v = sandboxVerdict();
  if (v.probed) {
    assert.ok(v.reason.length > 10, `原因太短：${v.reason}`);
    assert.ok(!/^ok$/i.test(v.reason) || v.mode === "appcontainer", "没到 appcontainer 却只说 ok 等于没解释");
  }
});

test("mode=off 时 runInSandbox 明确拒绝，不悄悄照跑", () => {
  // 构造一个必然 off 的判定：非 win32 平台天然 off；win32 上找不到 helper 时也 off
  const v = sandboxVerdict();
  if (v.mode !== "off") return; // 本机有 helper 时这条不适用
  const r = runInSandbox("echo hi");
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(r.reason ?? "", /工具层边界|没有原生沙箱|探针/);
});

test("沙箱里跑命令：输出与退出码都要透传（本机有 helper 时）", () => {
  const v = sandboxVerdict();
  if (v.mode === "off") return;
  const ok = runInSandbox('node -e "console.log(12345)"');
  assert.equal(ok.ok, true, `命令应当成功：${ok.stderr || ok.reason || ""}`);
  assert.match(ok.stdout, /12345/, "子进程的 stdout 必须传回来——不透传的话成员看不到任何结果");

  const bad = runInSandbox('node -e "process.exit(7)"');
  assert.equal(bad.code, 7, "退出码必须透传，否则失败会被当成成功");
});

test("沙箱里内存上限真的生效（限制 128MB 时分配 1GB 应失败）", () => {
  const v = sandboxVerdict();
  if (v.mode === "off") return;
  const limited = runInSandbox('node -e "Buffer.alloc(1024*1024*1024);console.log(777)"', { memoryMb: 128 });
  assert.notEqual(limited.code, 0, "限制 128MB 时 1GB 分配不该成功");
  assert.ok(!limited.stdout.includes("777"), "分配没成功就不该打印成功标记");

  const free = runInSandbox('node -e "Buffer.alloc(1024*1024*1024);console.log(777)"', { memoryMb: 2048 });
  assert.equal(free.code, 0, "同样的分配在 2GB 限制下应当成功（说明挡的是限额不是代码）");
});

test("探针缓存：同一进程内只探一次（避免每次派单都起个子进程）", () => {
  resetSandboxProbe();
  const a = sandboxVerdict();
  const b = sandboxVerdict();
  assert.equal(a, b, "缓存的必须是同一个对象，不是每次重新算");
});