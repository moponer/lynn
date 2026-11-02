// M1-17：persona.md —— 版本化 + 回滚 + 组装纪律（安全尾段强制后置）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonaStore, composeSystemPrompt, DEFAULT_PERSONA } from "../dist/main/persona.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-persona-"));

test("PersonaStore：load 兜底默认模板；save 版本化；rollback 回内容", () => {
  const root = tmp();
  const s = new PersonaStore(root);
  const first = s.load();
  assert.ok(first.includes("语气与人设"), "首次落默认模板");
  assert.ok(fs.existsSync(path.join(root, "persona", "persona.md")), "persona.md 真实存在");

  s.save("版本一");
  const vid2 = s.save("版本二");
  assert.equal(s.load(), "版本二");

  const vs = s.versions();
  assert.ok(vs.length >= 2, "每次保存留版本");
  assert.ok(vs[0].id !== vid2 || vs.length >= 2);

  const rolled = s.rollback(vs.find((v) => v.id !== vid2).id);
  assert.equal(rolled, "版本一");
  assert.equal(s.load(), "版本一");
});

test("PersonaStore：空文本回落默认；版本保留上限 20", () => {
  const root = tmp();
  const s = new PersonaStore(root);
  s.save("   ");
  assert.equal(s.load(), DEFAULT_PERSONA, "空文本不落空 persona");
  for (let i = 0; i < 25; i++) s.save(`v${i}`);
  assert.ok(s.versions().length <= 20, "版本剪枝");
  assert.throws(() => s.rollback("p-nope"), /不存在/);
  assert.throws(() => s.rollback("../escape"), /不存在/);
});

test("composeSystemPrompt：persona 夹中间，安全尾段强制后置", () => {
  const p = composeSystemPrompt("叫我老板，说话带点幽默。");
  assert.ok(p.indexOf("叫我老板") > p.indexOf("指挥者"), "persona 在固定头之后");
  assert.ok(p.indexOf("叫我老板") < p.indexOf("安全边界"), "persona 在安全尾段之前");
  assert.ok(p.trimEnd().endsWith("不要假装执行。"), "安全边界是最后一段（强制后置）");
  // 空 persona 回落默认
  const d = composeSystemPrompt("   ");
  assert.ok(d.includes("语气与人设"));
});

test("Kernel：persona.save 立即生效（systemPrompt 每轮现取）；版本 RPC 可回滚", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("persona.save", { text: "测试人设：说话极简。" });
    // systemPrompt 不直接暴露；直连路径每轮从 persona.load() 现取，这里验证落盘与 get
    assert.equal(kernel.handle("persona.get").text, "测试人设：说话极简。");

    const { versions } = kernel.handle("persona.versions");
    assert.ok(versions.length >= 1);
    const r = kernel.handle("persona.rollback", { id: versions[versions.length - 1].id });
    assert.ok(r.ok);
    assert.ok(typeof r.text === "string" && r.text.length > 0);
    assert.equal(kernel.handle("persona.get").text, r.text);
  } finally {
    await kernel.dispose();
  }
});
