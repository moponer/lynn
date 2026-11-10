import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { PiRpcHost, modelsJsonFor, writeModelsJson, PI_PROVIDER_ID } from "../dist/main/pi-rpc-host.js";

const FAKE = path.resolve(import.meta.dirname, "fixtures/pi-rpc-fake-worker.mjs");
const EXTENSION = path.resolve(import.meta.dirname, "../agent/extensions/lynn-bridge.mjs");

function makeHost(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-host-"));
  const events = [];
  const errors = [];
  const toolCalls = [];
  let spawnArgs = null;
  const spawnImpl = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    return spawn(cmd, args, opts);
  };
  const host = new PiRpcHost({
    entryPath: FAKE,
    extensionPath: EXTENSION,
    agentDir: path.join(dir, "agent"),
    sessionDir: path.join(dir, "sessions"),
    projectRoot: dir,
    personaFile: path.join(dir, "persona.md"),
    model: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "secret-key-123", model: "mock-chat", provider: "测试端点" },
    tools: [{ name: "test_echo", description: "回声", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
    onToolCall: async (name, args) => {
      toolCalls.push({ name, args });
      return `echo: ${args.message}`;
    },
    onEvent: (ev) => events.push(ev),
    onError: (m) => errors.push(m),
    spawnImpl,
    ...overrides,
  });
  return { host, dir, events, errors, toolCalls, spawnArgs: () => spawnArgs };
}

test("models.json 用 Pi 原生 $ENV 插值，绝不落明文 Key", () => {
  const text = modelsJsonFor({ baseUrl: "https://example.com/v1/", apiKey: "sk-SECRET", model: "m-1", provider: "自定义" });
  const j = JSON.parse(text);
  assert.equal(j.providers[PI_PROVIDER_ID].apiKey, "$LYNN_MODEL_API_KEY");
  assert.equal(j.providers[PI_PROVIDER_ID].baseUrl, "https://example.com/v1");
  assert.equal(j.providers[PI_PROVIDER_ID].models[0].id, "m-1");
  assert.ok(!text.includes("sk-SECRET"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-models-json-"));
  try {
    writeModelsJson(dir, { baseUrl: "https://example.com/v1", apiKey: "sk-SECRET", model: "m-1" });
    assert.ok(!fs.readFileSync(path.join(dir, "models.json"), "utf-8").includes("sk-SECRET"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("启动用官方 CLI 参数与官方扩展，Key 只经 env 下发", async () => {
  const { host, dir, spawnArgs } = makeHost();
  try {
    await host.start();
    const s = spawnArgs();
    assert.ok(s.args.includes("--provider") && s.args.includes(PI_PROVIDER_ID));
    assert.ok(s.args.includes("--model") && s.args.includes("mock-chat"));
    assert.ok(s.args.includes("--extension") && s.args.includes(EXTENSION));
    assert.ok(s.args.includes("--no-builtin-tools"), "不能把 Pi 内置执行工具暴露给风铃");
    assert.ok(s.args.includes("--no-mcp"));
    assert.ok(s.args.includes("--tools") && s.args.includes("test_echo"));
    assert.equal(s.opts.env.LYNN_MODEL_API_KEY, "secret-key-123");
    assert.equal(s.opts.env.PI_CODING_AGENT_DIR, path.join(dir, "agent"));
    assert.ok(JSON.parse(s.opts.env.LYNN_TOOL_SPECS)[0].name === "test_echo");
    assert.ok(!s.args.includes("secret-key-123"), "Key 不能出现在 argv 里");
    assert.ok(fs.existsSync(path.join(dir, "agent/models.json")));
  } finally {
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt 等官方 agent_settled；Pi 原生事件全量透传，不做白名单裁剪", async () => {
  const { host, dir, events } = makeHost();
  try {
    await host.start();
    const r = await host.prompt("你好");
    assert.equal(r.disposition, "started");
    const types = events.map((e) => e.type);
    for (const t of ["agent_start", "turn_start", "auto_retry_start", "message_update", "message_end", "agent_end", "agent_settled"]) {
      assert.ok(types.includes(t), `事件 ${t} 必须透传`);
    }
    const delta = events.find((e) => e.type === "message_update");
    assert.equal(delta.assistantMessageEvent.delta, "你好");
    assert.equal(host.isBusy(), false);
  } finally {
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("工具回壳：官方 extension_ui 子协议承载请求/响应，权限与执行仍在主进程", async () => {
  const { host, dir, events, toolCalls } = makeHost();
  try {
    await host.start();
    await host.prompt("请调用 tool");
    assert.deepEqual(toolCalls, [{ name: "test_echo", args: { message: "pi-ok" } }]);
    const text = events
      .filter((e) => e.type === "message_update")
      .map((e) => e.assistantMessageEvent?.delta ?? "")
      .join("");
    assert.ok(text.includes('"content":"echo: pi-ok"'), text);
    assert.ok(events.some((e) => e.type === "extension_ui_request"), "官方 UI 请求也要透传");
  } finally {
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stats 走官方 get_session_stats；persona 热更新只写文件", async () => {
  const { host, dir } = makeHost({ systemPrompt: "你是风铃" });
  try {
    await host.start();
    const stats = await host.stats();
    assert.equal(stats.tokens.input, 12);
    assert.equal(stats.contextWindow, 128000);
    host.updateSystemPrompt("你是新的风铃");
    assert.equal(fs.readFileSync(path.join(dir, "persona.md"), "utf-8"), "你是新的风铃");
  } finally {
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
