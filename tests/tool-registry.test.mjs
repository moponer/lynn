/**
 * 工具注册表（P8-1 / 22 章 4.1、23 章 5.1）。
 *
 * 这个注册表存在的意义是让三件原本**在结构上做不到**的事成立：
 *  1. 插件能**替换**内置工具（不只是新增）；
 *  2. 工具面顺序稳定（不受加载先后影响）；
 *  3. 注册能被自动回收（DSH 的 effect 模式）。
 *
 * 所以测试的重点不是"能注册"，而是这三条边界：
 *  - 默认**不许**覆盖（静默覆盖会让行为不可预测）；
 *  - disposer 只删自己那份（别把后来覆盖者的删掉）；
 *  - 枚举顺序与加载顺序无关。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ToolRegistry } = await jiti.import("../src/main/tool-registry.ts", { default: true });

const schema = (name) => ({
  type: "function",
  function: { name, description: `desc ${name}`, parameters: { type: "object", properties: {} } },
});

const impl = (name, over = {}) => ({
  name,
  schema: schema(name),
  execute: () => `ran ${name}`,
  origin: "builtin",
  ...over,
});

test("注册后能查、能执行、能列", async () => {
  const r = new ToolRegistry();
  r.register(impl("read_file"));
  assert.equal(r.has("read_file"), true);
  assert.equal(await r.execute?.("read_file"), undefined); // 注册表本身不提供 execute（由 Toolkit 提供）
  assert.equal(await r.get("read_file").execute({}), "ran read_file");
  assert.deepEqual(r.names(), ["read_file"]);
});

test("默认不许覆盖同名工具（静默覆盖会让行为不可预测）", () => {
  const r = new ToolRegistry();
  r.register(impl("read_file"));
  assert.throws(
    () => r.register(impl("read_file", { origin: "plugin:x" })),
    /已存在.*override/,
    "覆盖必须显式声明",
  );
});

test("显式 override 可以替换，且 origin 能查出被换掉了", () => {
  const r = new ToolRegistry();
  r.register(impl("read_file"));
  r.register(impl("read_file", { origin: "plugin:fast-reader", execute: () => "faster" }), { override: true });
  assert.equal(r.get("read_file").origin, "plugin:fast-reader");
  const overridden = r.overriddenBuiltins(["read_file"]);
  assert.equal(overridden.length, 1, "被覆盖的内置工具必须能查出来");
  assert.equal(overridden[0].origin, "plugin:fast-reader");
});

test("disposer 只删自己注册的那份（别把后来覆盖者的删掉）", () => {
  const r = new ToolRegistry();
  const disposeFirst = r.register(impl("read_file"));
  r.register(impl("read_file", { origin: "plugin:p" }), { override: true });
  disposeFirst(); // 旧的 disposer 不该把新的删掉
  assert.equal(r.has("read_file"), true, "覆盖者的注册被误删了");
  assert.equal(r.get("read_file").origin, "plugin:p");
});

test("disposer 正常回收（DSH 的 effect 模式）", () => {
  const r = new ToolRegistry();
  const dispose = r.register(impl("kb_add"));
  assert.equal(r.has("kb_add"), true);
  dispose();
  assert.equal(r.has("kb_add"), false);
});

test("枚举顺序与注册先后无关（按名字排序，保前缀稳定）", () => {
  const a = new ToolRegistry();
  a.register(impl("zeta"));
  a.register(impl("alpha"));
  a.register(impl("mid"));

  const b = new ToolRegistry();
  b.register(impl("mid"));
  b.register(impl("alpha"));
  b.register(impl("zeta"));

  assert.deepEqual(a.names(), ["alpha", "mid", "zeta"]);
  assert.deepEqual(a.names(), b.names(), "两个注册顺序不同的实例必须给出同一顺序——否则前缀缓存随加载顺序漂移");
});

test("schemasFor 保持注册顺序（成员工具段不能因为换顺序而废掉缓存）", () => {
  const r = new ToolRegistry();
  // 故意用非字典序注册，验证 schemasFor 不被排序
  r.register(impl("zeta"));
  r.register(impl("alpha"));
  const got = r.schemasFor(["alpha", "zeta"]).map((s) => s.function.name);
  assert.deepEqual(got, ["zeta", "alpha"], "schemasFor 必须按注册顺序，不是名字顺序");
});

test("schemasFor 忽略未知名字（写错名字的闸在别处，这里不炸）", () => {
  const r = new ToolRegistry();
  r.register(impl("read_file"));
  const got = r.schemasFor(["read_file", "不存在"]).map((s) => s.function.name);
  assert.deepEqual(got, ["read_file"]);
});

test("名字与 schema 不一致当场拒（否则查不到、报错难定位）", () => {
  const r = new ToolRegistry();
  assert.throws(
    () => r.register({ ...impl("a"), schema: schema("b") }),
    /工具名与 schema 不一致/,
  );
});

test("缺 schema 当场拒", () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({ name: "x", execute: () => "", origin: "builtin" }), /缺少 schema/);
});

test("registerAll 返回合并 disposer，一次回收全部", () => {
  const r = new ToolRegistry();
  const dispose = r.registerAll([impl("a"), impl("b"), impl("c")]);
  assert.equal(r.names().length, 3);
  dispose();
  assert.equal(r.names().length, 0);
});

test("Toolkit 的内置工具全部经由注册表，且与 TOOLKIT_SCHEMAS 集合一致", async () => {
  const { Toolkit, TOOLKIT_SCHEMAS } = await import("../dist/main/toolkit.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const t = new Toolkit(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-reg-")));

  const regNames = t.tools.names();
  const constNames = TOOLKIT_SCHEMAS.map((s) => s.function.name);
  assert.equal(regNames.length, constNames.length, "注册表与常量的件数必须一致");
  assert.deepEqual([...regNames].sort(), [...constNames].sort(), "集合必须一致");
  // 每个内置工具都必须能从注册表查到（不再有 switch 里的隐藏分支）
  for (const n of constNames) {
    assert.ok(t.tools.has(n), `${n} 没有进注册表——execute 会走到"未知工具"`);
    assert.equal(t.tools.get(n).origin, "builtin");
  }
});

test("Toolkit.execute 的未知工具文案保持不变（测试与模型都依赖它）", async () => {
  const { Toolkit } = await import("../dist/main/toolkit.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const t = new Toolkit(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-reg2-")));
  await assert.rejects(() => t.execute("根本不存在的工具", {}), /工作区里没有这个工具：根本不存在的工具/);
});

test("Toolkit 上可以注册插件工具，并能被 execute 调到（这就是插件化的入口）", async () => {
  const { Toolkit } = await import("../dist/main/toolkit.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const t = new Toolkit(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-reg3-")));
  const dispose = t.tools.register({
    name: "demo_plugin_tool",
    schema: schema("demo_plugin_tool"),
    execute: () => "来自插件的结果",
    origin: "plugin:demo",
  });
  assert.equal(await t.execute("demo_plugin_tool", {}), "来自插件的结果");
  dispose();
  await assert.rejects(() => t.execute("demo_plugin_tool", {}), /工作区里没有这个工具/);
});

test("插件可以覆盖内置工具，且被覆盖后 execute 走新实现", async () => {
  const { Toolkit } = await import("../dist/main/toolkit.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const t = new Toolkit(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-reg4-")));
  t.tools.register(
    { name: "list_dir", schema: schema("list_dir"), execute: () => "插件版 list_dir", origin: "plugin:demo" },
    { override: true },
  );
  assert.equal(await t.execute("list_dir", {}), "插件版 list_dir");
  assert.equal(t.tools.overriddenBuiltins(Toolkit.BUILTIN_TOOL_NAMES).length, 1, "覆盖必须能审计出来");
});