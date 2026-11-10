// 前缀缓存友好性回归（2026-11-10）：
//  - 记忆注入剥掉行首时间戳：同一事实重存不会让 system prompt 中段变动
//  - 技能注入不进 system prompt：改在当轮消息尾部（技能命中集抖动不再打穿全部历史前缀）
//  - 工具面按名排序（L1/MCP 来自 Map 遍历，顺序随加载先后变化）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel, AGENT_TOOL_NAMES } from "../dist/main/kernel.js";
import { MemoryStore } from "../dist/main/memory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cache-"));

const SKILL_MD = `---
name: 周报生成
description: 把订单数据整理成周报，含口径核对与格式要求
allowed-tools:
  - read_file
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

test("记忆时间戳：磁盘保留，注入 system prompt 时剥掉（同一条重存不破缓存）", () => {
  const root = tmp();
  const mem = new MemoryStore(root);
  mem.save("memory", "# 助理记忆\n\n- 2026-11-09 13:22 周报材料固定在工作区 orders.csv\n- 2026-11-10 09:01 用户偏好简洁汇报\n");
  const section = mem.systemPromptSection();
  assert.ok(section.includes("周报材料固定在工作区"), "事实本体保留");
  assert.ok(!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(section), "prompt 里不出现行首时间戳");
  // 磁盘原文不变（可追溯）
  assert.match(mem.load("memory"), /2026-11-09 13:22/);
});

test("技能注入不进 system prompt：被存到当轮消息（pendingSkillText）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const before = kernel.systemPrompt();
    kernel.activateSkillsFor("把订单数据整理成周报，注意口径核对");
    assert.ok(kernel.activeSkills.some((s) => s.name === "周报生成"), "技能已激活");
    assert.ok(kernel.pendingSkillText.includes("周报生成"), "注入文本挂在当轮");
    assert.equal(kernel.systemPrompt(), before, "system prompt 保持不变（前缀缓存稳定）");
    assert.ok(!kernel.systemPrompt().includes("本轮技能"), "技能段不再出现在 system prompt");
  } finally {
    await kernel.dispose();
  }
});

test("工具面顺序稳定：管理型在前的固定顺序 + 额外工具按名排序", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const names = kernel.toolNames();
    assert.deepEqual(names.slice(0, AGENT_TOOL_NAMES.length), [...AGENT_TOOL_NAMES], "管理型工具顺序与定义一致");
    // 无 L1/MCP 时没有额外工具；排序逻辑在 allTools 里，这里验证两次调用结果完全一致
    assert.deepEqual(kernel.allTools().map((t) => t.function.name), names, "两次取工具面结果一致");
  } finally {
    await kernel.dispose();
  }
});
