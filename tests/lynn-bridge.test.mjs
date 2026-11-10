import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import bridge, { toTypeBox, readToolSpecs, readPersona, parseToolResponse, TOOL_BRIDGE_TITLE } from "../agent/extensions/lynn-bridge.mjs";

test("toTypeBox：required / enum / anyOf / 数组元素都要带到 Pi 的参数约束里", () => {
  const s = toTypeBox({
    type: "object",
    properties: {
      mode: { type: "string", enum: ["a", "b"] },
      count: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      choice: { anyOf: [{ type: "string" }, { type: "boolean" }] },
    },
    required: ["mode"],
  });
  assert.ok(s);
  assert.equal(s.properties.mode.anyOf.length, 2);
  assert.equal(s.properties.tags.items.type, "string");
  assert.ok(s.properties.count);
  assert.ok(s.properties.choice.anyOf);
  assert.ok("mode" in s.properties);
});

test("readToolSpecs 坏 JSON 不炸；readPersona 缺文件返回空串", () => {
  assert.deepEqual(readToolSpecs({ LYNN_TOOL_SPECS: "not json" }), []);
  assert.deepEqual(readToolSpecs({ LYNN_TOOL_SPECS: '[{"name":"a"}]' }), [{ name: "a" }]);
  assert.equal(readPersona({}), "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bridge-"));
  try {
    const f = path.join(dir, "persona.md");
    fs.writeFileSync(f, "人设");
    assert.equal(readPersona({ LYNN_PERSONA_FILE: f }), "人设");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseToolResponse：壳正常返回与异常返回都能结构化", () => {
  assert.deepEqual(parseToolResponse('{"ok":true,"content":"done"}'), { ok: true, content: "done" });
  assert.deepEqual(parseToolResponse("{bad"), { ok: false, error: "壳未返回合法的工具结果" });
  assert.equal(parseToolResponse(undefined).ok, false);
});

test("扩展注册工具并经官方 extension_ui input 回壳；persona 每轮重读追加", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bridge-run-"));
  const personaFile = path.join(dir, "persona.md");
  fs.writeFileSync(personaFile, "你是风铃");
  const prev = { LYNN_TOOL_SPECS: process.env.LYNN_TOOL_SPECS, LYNN_PERSONA_FILE: process.env.LYNN_PERSONA_FILE };
  process.env.LYNN_TOOL_SPECS = JSON.stringify([
    { name: "test_echo", description: "回声", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  ]);
  process.env.LYNN_PERSONA_FILE = personaFile;
  try {
    const tools = [];
    const handlers = {};
    bridge({
      registerTool: (t) => tools.push(t),
      on: (event, handler) => { handlers[event] = handler; },
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "test_echo");

    let requested = null;
    const ctx = {
      ui: {
        input: async (title, placeholder) => {
          requested = { title, placeholder };
          return JSON.stringify({ ok: true, content: "echo: pi-ok" });
        },
      },
    };
    const result = await tools[0].execute("call-1", { message: "pi-ok" }, undefined, undefined, ctx);
    assert.equal(requested.title, TOOL_BRIDGE_TITLE);
    assert.deepEqual(JSON.parse(requested.placeholder), { name: "test_echo", args: { message: "pi-ok" } });
    assert.equal(result.content[0].text, "echo: pi-ok");

    const failed = await tools[0].execute("call-2", {}, undefined, undefined, {
      ui: { input: async () => '{"ok":false,"error":"权限拒绝"}' },
    });
    assert.equal(failed.content[0].text, "工具执行失败：权限拒绝");

    const out = handlers.before_agent_start({ systemPrompt: "Pi 内置 prompt" });
    assert.ok(out.systemPrompt.startsWith("Pi 内置 prompt"));
    assert.ok(out.systemPrompt.includes("你是风铃"));
    fs.writeFileSync(personaFile, "你是新风铃");
    assert.ok(handlers.before_agent_start({ systemPrompt: "base" }).systemPrompt.includes("你是新风铃"));
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
