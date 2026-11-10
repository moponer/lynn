// 技能管理（M2-10 管理面）：skills.list / skills.toggle 闭环
//  - 停用落 prefs.disabledSkills 并即时重发现（skillEntries 不再含）
//  - 停用的技能不参与 matchSkills 激活、allowed-tools 强制随激活集走
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { matchSkills } from "../dist/main/skills.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sku-"));

const SKILL_MD = `---
name: 周报生成
description: 把订单数据整理成周报，含口径核对与格式要求
allowed-tools:
  - read_file
  - write_file
---

按四段模板产出周报。
`;

function setup() {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
    }),
    "utf-8",
  );
  const skillDir = path.join(root, "skills", "weekly");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf-8");
  return { root, kernel: new Kernel(root) };
}

test("skills.list：发现用户级技能，含描述/白名单/来源", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const r = kernel.handle("skills.list");
    // init 会种入内置 plugin-dev 技能，所以 ≥1 且必有测试写入的这条
    const s = r.skills.find((x) => x.name === "周报生成");
    assert.ok(s, "应发现用户级技能");
    assert.match(s.description, /周报/);
    assert.deepEqual(s.allowedTools, ["read_file", "write_file"]);
    assert.equal(s.level, "user");
    assert.equal(s.disabled, false);
  } finally {
    await kernel.dispose();
  }
});

test("skills.toggle：停用落 prefs 且即时重发现；再启用恢复", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const off = kernel.handle("skills.toggle", { name: "周报生成", enabled: false });
    assert.equal(off.ok, true);
    assert.ok(kernel.settings.getPrefs().disabledSkills.includes("周报生成"));
    assert.equal(kernel.skillEntries.some((s) => s.name === "周报生成"), false, "停用后不参与激活");
    // 列表仍能看到（带停用标记），用户知道它存在
    const listed = kernel.handle("skills.list").skills.find((x) => x.name === "周报生成");
    assert.equal(listed.disabled, true);

    const on = kernel.handle("skills.toggle", { name: "周报生成", enabled: true });
    assert.equal(on.ok, true);
    assert.equal(kernel.settings.getPrefs().disabledSkills.includes("周报生成"), false);
    assert.equal(kernel.skillEntries.some((s) => s.name === "周报生成"), true, "启用后恢复");
  } finally {
    await kernel.dispose();
  }
});

test("停用的技能不参与 matchSkills 激活（重启后同样生效——清单已持久化）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.handle("skills.toggle", { name: "周报生成", enabled: false });
    // 重启同一数据目录：停用清单从 settings.json 读回
    const kernel2 = new Kernel(kernel.dataRoot);
    await kernel2.init();
    const hits = matchSkills("把订单数据整理成周报，注意口径", kernel2.skillEntries);
    assert.equal(hits.some((s) => s.name === "周报生成"), false, "停用技能不该被激活");
    await kernel2.dispose();
  } finally {
    await kernel.dispose();
  }
});
