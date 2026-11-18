/**
 * 工具面体量锁（P2-1b）。
 *
 * 为什么要有这条锁：工具面是**每一次模型调用都要付**的固定成本（01 章实测占比 33%）。
 * 它属于"悄悄长胖"的类型——加一个工具、把描述写细一点，单看代码没什么，
 * 但乘以 1,376 次调用就是百万级 token。所以这里把体量与结构都钉死：
 *
 *  1. 主会话工具面 ≤ 锁定的字符/估算 token 上限（超了必须显式改这里并说明理由）；
 *  2. 巡检工具面是主会话的**真子集**，且严格更小（巡检只做看单/看人/催停）；
 *  3. 巡检绝不带组织类工具（建队/招人/解散/写草稿/发插件/写记忆）；
 *  4. 两次调用的工具名与顺序完全一致（顺序变了 = 前缀缓存作废，这是缓存友好的一部分）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { estimateTokens } from "../dist/main/prompt-compiler.js";

/**
 * 2026-11-18 实测：26 件 8,399 字符 ≈ 2,754 tokens。
 * 基线（01 章）是 6,821 ≈ 2,228。涨的部分逐笔可查：
 *  - **+170** P3-1 `roleId` 枚举（G1 必须让模型看见合法值）
 *  - **+274** P5-1 `network` / `networkReason`（联网按单授权，默认不给）
 *  - **+669** P8-2 自举三件套 `list_plugins` / `set_plugin_enabled` / `uninstall_plugin`
 *  - **+296** P9-2 `install_plugin`（从 zip/目录装包；她自开发的产物也走这条）
 *  - **+465** P12-1 `list_plugin_versions` / `rollback_plugin`（改插件不用卸载重装）
 *    （她得能看见装了什么、关掉装错的、删掉装错的——否则"对话式管插件"只能靠用户点面板）
 * 三笔都是「不给模型看见就没法正确执行」的信息，不是文案冗余。
 */
const MAX_ALL_CHARS = 8700;
/** 2026-11-17 实测：13 件 4,440 字符 ≈ 1,357 tokens（巡检带着 assign_task，所以也吃到了 network 参数那 217 字符） */
const MAX_PATROL_CHARS = 4600;

/** 巡检绝不带的组织类工具：这些只在用户主动发起时才需要，巡检回合不干这些事 */
const ORG_TOOLS = [
  "create_team",
  "create_member",
  "dissolve_team",
  "create_plugin_draft",
  "ship_plugin",
  "save_memory",
  "forget_memory",
];

function freshKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolsize-"));
  return new Kernel(root);
}

test("主会话工具面体量在预算内（防止悄悄长胖）", async () => {
  const k = freshKernel();
  await k.init();
  try {
    const json = JSON.stringify(k.allTools());
    assert.ok(
      json.length <= MAX_ALL_CHARS,
      `工具面涨到 ${json.length} 字符（上限 ${MAX_ALL_CHARS}，≈${estimateTokens(json)} tokens）。` +
        "固定成本是每次调用的乘数：确需扩容就同时改这里与 PROGRESS 的基线数字",
    );
  } finally {
    k.dispose?.();
  }
});

test("巡检工具面是真子集且明显更小；绝不含组织类工具", async () => {
  const k = freshKernel();
  await k.init();
  try {
    const all = k.allTools();
    const patrol = k.patrolTools();
    const allNames = all.map((t) => t.function.name);
    const patrolNames = patrol.map((t) => t.function.name);

    const patrolJson = JSON.stringify(patrol);
    assert.ok(
      patrolJson.length <= MAX_PATROL_CHARS,
      `巡检工具面涨到 ${patrolJson.length} 字符（上限 ${MAX_PATROL_CHARS}）`,
    );
    assert.ok(patrolJson.length < JSON.stringify(all).length, "巡检必须比主会话轻");

    for (const n of patrolNames) {
      assert.ok(allNames.includes(n), `巡检工具 ${n} 不在主会话工具面里——两套面已漂移`);
    }
    for (const n of ORG_TOOLS) {
      assert.ok(!patrolNames.includes(n), `巡检不该带组织类工具 ${n}`);
    }
    // 白名单语义：巡检件数应当显著少于主会话（否则"精简"名不副实）
    assert.ok(patrolNames.length <= allNames.length - 5, "巡检至少要比主会话少 5 件，否则精简没有意义");
  } finally {
    k.dispose?.();
  }
});

test("工具面顺序稳定（顺序变了就是前缀缓存作废）", async () => {
  const k1 = freshKernel();
  const k2 = freshKernel();
  await k1.init();
  await k2.init();
  try {
    const a = k1.allTools().map((t) => t.function.name);
    const b = k2.allTools().map((t) => t.function.name);
    assert.deepEqual(a, b, "两次启动拿到不同的工具顺序");

    const p1 = k1.patrolTools().map((t) => t.function.name);
    const p2 = k2.patrolTools().map((t) => t.function.name);
    assert.deepEqual(p1, p2, "巡检工具顺序在两次启动间不一致");
  } finally {
    k1.dispose?.();
    k2.dispose?.();
  }
});