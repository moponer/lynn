import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentHost } from "../dist/main/agent-host.js";
import { PiRpcHost } from "../dist/main/pi-rpc-host.js";
import { L1Host } from "../dist/main/plugin-l1.js";
import { drainUtf8Lines, RpcLineBufferOverflowError } from "../dist/main/rpc-lines.js";

const PLUGIN_ID = "lynn.test.lifecycle";

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

/** 捕获真实子进程及其 stdin 命令，既断言错误文案，也断言确实 kill/abort。 */
function captureSpawn() {
  const captured = { child: null, commands: [] };
  const spawnImpl = (command, args, options) => {
    const child = spawn(command, args, options);
    captured.child = child;
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...args) => {
      try {
        captured.commands.push(JSON.parse(String(chunk).trim()));
      } catch {
        // 本测试的宿主只写 JSONL；非 JSON 不属于断言对象。
      }
      return write(chunk, ...args);
    };
    return child;
  };
  return { captured, spawnImpl };
}

async function waitUntil(predicate, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`子进程 ${child.pid} 未在 3s 内退出`));
    }, 3_000);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function forceCleanup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child).catch(() => undefined);
}

function silentWorker() {
  return `process.stdin.resume();\nsetInterval(() => {}, 1000);\n`;
}

function makeAgentHost(entryPath, markerDir, spawnImpl) {
  return new AgentHost({
    entryPath,
    readyTimeoutMs: 120,
    markerDir,
    model: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", model: "test" },
    tools: [],
    onToolCall: async () => "",
    onEvent: () => undefined,
    onError: () => undefined,
    spawnImpl,
  });
}

function makePiHost(root, entryPath, spawnImpl, overrides = {}) {
  const extensionPath = writeFile(root, "extension.mjs", "");
  return new PiRpcHost({
    entryPath,
    extensionPath,
    agentDir: path.join(root, "agent"),
    markerDir: path.join(root, "markers"),
    model: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", model: "test" },
    tools: [],
    onToolCall: async () => "",
    onEvent: () => undefined,
    onError: () => undefined,
    spawnImpl,
    ...overrides,
  });
}

function makeL1Host(root, workerEntry, spawnImpl, activateTimeoutMs = 120) {
  const dir = path.join(root, "plugin");
  const manifest = {
    id: PLUGIN_ID,
    tier: "L1",
    entry: "./index.ts",
    contributes: { tools: [] },
  };
  writeFile(root, "plugin/index.ts", "export default function activate() {}\n");
  return new L1Host({
    listEntries: () => [],
    manifestOf: (id) => (id === PLUGIN_ID ? { dir, manifest } : null),
    kernelVersion: "0.0.1",
    workerEntry,
    workerActivateTimeoutMs: activateTimeoutMs,
    spawnImpl,
  });
}

test("半行超限抛专用错误；大块完整 JSONL 不受 maxBuffer 误伤", () => {
  assert.throws(
    () => drainUtf8Lines(Buffer.alloc(0), Buffer.from(`{"partial":"${"x".repeat(128)}`), 32),
    (error) => {
      assert.ok(error instanceof RpcLineBufferOverflowError);
      assert.equal(error.name, "RpcLineBufferOverflowError");
      assert.equal(error.maxBuffer, 32);
      assert.ok(error.actualBytes > 32);
      assert.match(error.message, /半行缓冲超过上限/);
      return true;
    },
  );

  const lines = Array.from({ length: 8 }, (_, index) =>
    JSON.stringify({ type: "message_update", index, text: "完整中文数据".repeat(16) }),
  );
  const drained = drainUtf8Lines(Buffer.alloc(0), Buffer.from(`${lines.join("\n")}\n`), 32);
  assert.deepEqual(drained.lines, lines);
  assert.equal(drained.rest.length, 0);
});

test("Agent ready 超时：杀进程并清 ready 与 marker", async () => {
  const root = tempRoot("lynn-agent-ready-timeout-");
  const entryPath = writeFile(root, "worker.mjs", silentWorker());
  const markerDir = path.join(root, "markers");
  const { captured, spawnImpl } = captureSpawn();
  const host = makeAgentHost(entryPath, markerDir, spawnImpl);
  try {
    const starting = host.start();
    await waitUntil(
      () => captured.child && fs.existsSync(path.join(markerDir, `${captured.child.pid}.json`)),
      "Agent marker 已写入",
    );
    const child = captured.child;
    await assert.rejects(starting, /RPC worker 启动超时/);
    await waitForExit(child);
    assert.equal(host.isRunning(), false);
    assert.equal(fs.existsSync(path.join(markerDir, `${child.pid}.json`)), false);
  } finally {
    await host.stop();
    await forceCleanup(captured.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi get_state 握手失败：杀进程、拒绝 pending 并清 marker", async () => {
  const root = tempRoot("lynn-pi-handshake-failure-");
  const entryPath = writeFile(
    root,
    "worker.mjs",
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") {
    process.stdout.write(JSON.stringify({ type: "response", id: msg.id, success: false, error: "握手故意失败" }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );
  const { captured, spawnImpl } = captureSpawn();
  const host = makePiHost(root, entryPath, spawnImpl);
  const markerDir = path.join(root, "markers");
  try {
    const starting = host.start();
    await waitUntil(
      () => captured.child && fs.existsSync(path.join(markerDir, `${captured.child.pid}.json`)),
      "Pi marker 已写入",
    );
    const child = captured.child;
    await assert.rejects(starting, /握手故意失败/);
    await waitForExit(child);
    assert.equal(host.isRunning(), false);
    assert.equal(fs.existsSync(path.join(markerDir, `${child.pid}.json`)), false);
  } finally {
    await host.stop();
    await forceCleanup(captured.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("L1 激活超时：强杀 worker，异常文案如实且不登记 loaded", async () => {
  const root = tempRoot("lynn-l1-activate-timeout-");
  const workerEntry = writeFile(root, "l1-worker.mjs", silentWorker());
  const { captured, spawnImpl } = captureSpawn();
  const host = makeL1Host(root, workerEntry, spawnImpl);
  try {
    await assert.rejects(host.activate(PLUGIN_ID), /插件调用超时.*隔离进程已被强制终止/);
    assert.deepEqual(host.activeIds(), []);
    await waitForExit(captured.child);
  } finally {
    host.deactivate(PLUGIN_ID);
    await forceCleanup(captured.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("持续无换行 stdout：L1 半行上限杀进程并落审计", async () => {
  const root = tempRoot("lynn-l1-stdout-overflow-");
  const workerEntry = writeFile(
    root,
    "l1-worker.mjs",
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let flooding = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "activate" || flooding) return;
  flooding = true;
  const chunk = "x".repeat(64 * 1024);
  process.stdout.write(chunk);
  setInterval(() => process.stdout.write(chunk), 5);
});
setInterval(() => {}, 1000);
`,
  );
  const { captured, spawnImpl } = captureSpawn();
  /**
   * 激活窗口给 8s（原 2s）。
   *
   * 这条测试要验的是「**半行缓冲超限**杀进程」，不是「激活超时」。
   * 假 worker 只写 stdout 不回复，激活必然失败；两个分支谁先到取决于调度。
   * 缓冲上限 1MB、每 5ms 写 64KB，空载约 80ms 触发；但全量跑时（6 核跑 200+ 文件）
   * 子进程调度会被拖慢，2s 窗口下常常先撞上超时——那样测到的是超时分支，覆盖不到缓冲上限。
   *
   * 放宽是为了让**被测分支**有机会先触发，不是掩盖变慢。
   */
  const host = makeL1Host(root, workerEntry, spawnImpl, 8_000);
  const audits = [];
  const originalError = console.error;
  console.error = (...args) => audits.push(args.map(String).join(" "));
  try {
    await assert.rejects(host.activate(PLUGIN_ID), /stdout 半行缓冲超限/);
    await waitForExit(captured.child);
    assert.deepEqual(host.activeIds(), []);
    assert.ok(
      audits.some((line) => line.includes("[l1-worker]") && line.includes("半行缓冲超限") && line.includes("已强制终止")),
      `应留下超限与强杀审计：${audits.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
    host.deactivate(PLUGIN_ID);
    await forceCleanup(captured.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi 等 settled 有独立总 deadline：超时删 waiter 并发送 abort", async () => {
  const root = tempRoot("lynn-pi-prompt-deadline-");
  const entryPath = writeFile(
    root,
    "worker.mjs",
    `import readline from "node:readline";
const respond = (id, data) => process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\\n");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") respond(msg.id, { sessionId: "deadline-test", isStreaming: true });
  if (msg.type === "prompt") respond(msg.id, { disposition: "started" });
  if (msg.type === "abort") respond(msg.id, { ok: true });
});
setInterval(() => {}, 1000);
`,
  );
  const { captured, spawnImpl } = captureSpawn();
  const host = makePiHost(root, entryPath, spawnImpl, { promptAndWaitTimeoutMs: 120 });
  try {
    await host.start();
    await assert.rejects(host.prompt("永远不发 agent_settled"), /prompt-and-wait 总超时（120ms）.*abort/);
    await waitUntil(() => captured.commands.some((msg) => msg.type === "abort"), "abort 已写入 worker stdin");
    assert.deepEqual(captured.commands.map((msg) => msg.type), ["get_state", "prompt", "abort"]);
  } finally {
    await host.stop();
    await forceCleanup(captured.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
