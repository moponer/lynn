// RPC 注册表（kernel 拆域三批）的运行时契约（2026-11-15 第一批 / 11-16 二、三批）。
//
// 为什么单独一个测试：tests/rpc-contract-parity.test.mjs 是纯文本扫描，
// 只能证明"源码里出现过 registry.register(...)"，证明不了 handler 真能被调起来、
// 参数真能透传。这里直接拿 dist 产物构建注册表，把 has / methods / handle /
// 重复注册 / 未知方法几条线都钉住，防止注册表变成"只存在于源码里的死表"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcRegistry, buildKernelRegistry } from "../dist/main/rpc-registry.js";

/** 方法名 → [域对象, 域上的能力名]（thread.new → create 这类不一一对应） */
const HANDLER_OF = {
  "model.list": ["models", "list"],
  "model.save": ["models", "save"],
  "model.remove": ["models", "remove"],
  "model.setDefault": ["models", "setDefault"],
  "model.setThread": ["models", "setThread"],
  "model.test": ["models", "test"],
  "thread.list": ["threads", "list"],
  "thread.new": ["threads", "create"],
  "thread.switch": ["threads", "switchTo"],
  "thread.rename": ["threads", "rename"],
  "thread.pin": ["threads", "pin"],
  "thread.announcement": ["threads", "announce"],
  "thread.remove": ["threads", "remove"],
  "thread.search": ["threads", "search"],
  "calendar.add": ["calendar", "add"],
  "calendar.list": ["calendar", "list"],
  "calendar.finish": ["calendar", "finish"],
  "calendar.todo.add": ["calendar", "todoAdd"],
  "calendar.todo.list": ["calendar", "todoList"],
  "calendar.todo.finish": ["calendar", "todoFinish"],
  "calendar.scan": ["calendar", "scan"],
  "schedule.tick": ["schedules", "tick"],
  "schedule.add": ["schedules", "add"],
  "schedule.list": ["schedules", "list"],
  "schedule.remove": ["schedules", "remove"],
  "schedule.toggle": ["schedules", "toggle"],
  "kb.search": ["kb", "search"],
  "kb.list": ["kb", "list"],
  "kb.read": ["kb", "read"],
  "kb.reindex": ["kb", "reindex"],
  "data.usage": ["data", "usage"],
  "data.cleanup": ["data", "cleanup"],
  "config.clearKey": ["config", "clearKey"],
  "config.vision.get": ["config", "visionGet"],
  "config.vision.save": ["config", "visionSave"],
  "config.vision.clear": ["config", "visionClear"],
  "ui.plugins": ["ui", "plugins"],
  "humanizer.status": ["humanizer", "status"],
};
const ALL = Object.keys(HANDLER_OF);

/** 注册表里按"无参"注册的方法：它们不该收到调用方传进来的 params */
const NO_PARAM = new Set([
  "model.list",
  "thread.list",
  "calendar.todo.list",
  "calendar.scan",
  "schedule.tick",
  "schedule.list",
  "kb.list",
  "kb.reindex",
  "data.usage",
  "config.clearKey",
  "config.vision.get",
  "config.vision.clear",
  "ui.plugins",
  "humanizer.status",
]);

/** 假域能力：记录调用参数，返回带域标记的哨兵值 */
function fakeDeps() {
  const calls = [];
  const hit = (domain, name, params) => {
    calls.push({ domain, name, params });
    return { domain: `${domain}.${name}` };
  };
  const make = (domain, names) =>
    Object.fromEntries(names.map((name) => [name, (p) => hit(domain, name, p)]));
  return {
    calls,
    deps: {
      models: make("models", ["list", "save", "remove", "setDefault", "setThread", "test"]),
      threads: make("threads", [
        "list",
        "create",
        "switchTo",
        "rename",
        "pin",
        "announce",
        "remove",
        "search",
      ]),
      calendar: make("calendar", ["add", "list", "finish", "todoAdd", "todoList", "todoFinish", "scan"]),
      schedules: make("schedules", ["tick", "add", "list", "remove", "toggle"]),
      kb: make("kb", ["search", "list", "read", "reindex"]),
      data: make("data", ["usage", "cleanup"]),
      config: make("config", ["clearKey", "visionGet", "visionSave", "visionClear"]),
      ui: make("ui", ["plugins"]),
      humanizer: make("humanizer", ["status"]),
    },
  };
}

// 2026-11-16：thread.draftNotice 随「让风铃起草」按钮一起删除（38 个方法）
test("五批共 38 个方法都注册了，未迁移的方法不在注册表里", () => {
  const { deps } = fakeDeps();
  const registry = buildKernelRegistry(deps);
  assert.deepEqual([...registry.methods()].sort(), [...ALL].sort());
  for (const m of ALL) assert.equal(registry.has(m), true, `${m} 应已注册`);
  assert.equal(registry.has("config.prefs"), false, "未迁移的方法不该出现在注册表里");
  assert.equal(registry.has("thread.halt"), false, "跨域编排留在 kernel，不进注册表");
});

test("每个注册的方法都真能调起来，参数原样透传给对应域能力", () => {
  const { deps, calls } = fakeDeps();
  const registry = buildKernelRegistry(deps);
  const params = { id: "x-1", title: "群", pinned: true };

  for (const m of ALL) {
    const [domain, name] = HANDLER_OF[m];
    const value = registry.handle(m, params);
    assert.equal(value.domain, `${domain}.${name}`, `${m} 没有调到对应 handler`);
  }

  assert.equal(calls.length, ALL.length);
  for (const c of calls) {
    const method = Object.keys(HANDLER_OF).find((k) => HANDLER_OF[k][1] === c.name && HANDLER_OF[k][0] === c.domain);
    if (NO_PARAM.has(method)) assert.equal(c.params, undefined, `${method} 是无参注册，不该收到参数`);
    else assert.equal(c.params, params, `${c.domain}.${c.name} 的参数被替换了`);
  }
});

test("未知方法抛可辨识错误，与 kernel switch 的 default 文案区分开", () => {
  const { deps } = fakeDeps();
  const registry = buildKernelRegistry(deps);
  assert.throws(
    () => registry.handle("model.nope", {}),
    (err) => /rpc registry/.test(err.message) && /model\.nope/.test(err.message),
    "错误信息要能区分是注册表缺项还是 switch 缺 case",
  );
});

test("同一方法重复注册直接报错，不静默覆盖", () => {
  const registry = new RpcRegistry();
  registry.register("model.list", () => ({ ok: true }));
  assert.throws(() => registry.register("model.list", () => ({ ok: true })), /重复注册/);
});
