import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyPiEnvironment } from "../dist/main/pi-home.js";
import { Kernel } from "../dist/main/kernel.js";

/**
 * Pi 配置根重定向（计划书 §1.6）与无遥测（§4.7）。
 * 变量名来自 Pi 官方 docs/environment-variables.md：
 *   PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR / PI_TELEMETRY / PI_SKIP_VERSION_CHECK
 */

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-"));
}

test("Pi 配置根落到 <dataRoot>/kernel/agent 与 sessions", () => {
  const root = tmpRoot();
  const { agentDir, sessionDir } = applyPiEnvironment(root);

  assert.equal(agentDir, path.join(root, "kernel", "agent"));
  assert.equal(sessionDir, path.join(root, "kernel", "sessions"));
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, sessionDir);
  assert.ok(fs.existsSync(agentDir), "agent 目录应被创建");
  assert.ok(fs.existsSync(sessionDir), "sessions 目录应被创建");
});

test("无遥测：PI_TELEMETRY=0，且启动不请求 pi.dev 版本", () => {
  applyPiEnvironment(tmpRoot());
  assert.equal(process.env.PI_TELEMETRY, "0");
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
});

test("Kernel 构造即完成重定向（早于 init() 的 Pi 动态 import）", () => {
  const rootA = tmpRoot();
  applyPiEnvironment(rootA); // 先指向 A，模拟上一个实例
  const rootB = tmpRoot();
  new Kernel(rootB); // 构造后必须改指 B
  assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(rootB, "kernel", "agent"));
});
