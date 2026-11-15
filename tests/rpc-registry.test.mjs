// RPC 注册表（kernel 拆域第一批）的运行时契约（2026-11-15）。
//
// 为什么单独一个测试：tests/rpc-contract-parity.test.mjs 是纯文本扫描，
// 只能证明"源码里出现过 registry.register(...)"，证明不了 handler 真能被调起来、
// 参数真能透传。这里直接拿 dist 产物构建注册表，把 has / methods / handle /
// 重复注册 / 未知方法几条线都钉住，防止注册表变成"只存在于源码里的死表"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcRegistry, buildKernelRegistry } from "../dist/main/rpc-registry.js";

const MODEL_METHODS = [
  "model.list",
  "model.save",
  "model.remove",
  "model.setDefault",
  "model.setThread",
  "model.test",
];

/** 假域能力：记录调用参数，返回带域标记的哨兵值 */
function fakeDeps() {
  const calls = [];
  const hit = (name, params) => {
    calls.push({ name, params });
    return { domain: `models.${name}` };
  };
  const deps = {
    models: {
      list: () => hit("list", undefined),
      save: (p) => hit("save", p),
      remove: (p) => hit("remove", p),
      setDefault: (p) => hit("setDefault", p),
      setThread: (p) => hit("setThread", p),
      test: (p) => hit("test", p),
    },
  };
  return { calls, deps };
}

test("第一批 6 个 model.* 都注册了，未迁移的方法不在注册表里", () => {
  const { deps } = fakeDeps();
  const registry = buildKernelRegistry(deps);
  for (const m of MODEL_METHODS) assert.equal(registry.has(m), true, `${m} 应已注册`);
  assert.equal(registry.has("config.prefs"), false, "未迁移的方法不该出现在注册表里");
  assert.deepEqual([...registry.methods()].sort(), [...MODEL_METHODS].sort());
});

test("每个注册的方法都真能调起来，参数原样透传给对应域能力", () => {
  const { deps, calls } = fakeDeps();
  const registry = buildKernelRegistry(deps);
  const params = { id: "m-1", label: "A", provider: "p", baseUrl: "https://a/v1", model: "x" };

  for (const m of MODEL_METHODS) {
    const value = registry.handle(m, m === "model.list" ? undefined : params);
    assert.equal(value.domain, `models.${m.slice("model.".length)}`, `${m} 没有调到对应 handler`);
  }
  // 除 model.list 外都应收到原对象，不允许中途被包装/改写
  assert.equal(calls.length, MODEL_METHODS.length);
  for (const c of calls) {
    if (c.name === "list") assert.equal(c.params, undefined, "model.list 不该收到参数");
    else assert.equal(c.params, params, `${c.name} 的参数被替换了`);
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
