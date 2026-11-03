// 词表收敛（shared/lexicon）：阶段流与状态一一对应、成员态与台账同词、i18n 不缺词。
// 回归点：旧七步阶段里有"汇报"，没有任何 TaskStatus 会落到它，进度条永远空着一格。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBER_STATE_KEY,
  MEMBER_STATE_LABEL,
  PHASE_STAGE,
  STAGE_KEYS,
  STAGE_OF,
  STAGES,
  STATUS_KEY,
  STATUS_LABEL,
} from "../dist/shared/lexicon.js";
import { ZH_STRINGS, EN_STRINGS } from "../dist/shared/i18n-strings.js";

test("阶段流六步：没有永远点不亮的\"汇报\"，索引不越界", () => {
  assert.equal(STAGES.length, 6);
  assert.equal(STAGE_KEYS.length, STAGES.length);
  assert.ok(!STAGES.includes("汇报"), "汇报并进审查，不该再占一格");
  for (const [status, idx] of Object.entries(STAGE_OF)) {
    assert.ok(idx >= 0 && idx < STAGES.length, `${status} 映射到越界阶段 ${idx}`);
  }
  assert.equal(STAGE_OF.done, STAGES.length - 1, "已归档必须落在最后一格");
});

test("状态推进时阶段不倒退", () => {
  const order = ["backlog", "todo", "in_progress", "in_review", "done"];
  const idx = order.map((s) => STAGE_OF[s]);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, `阶段索引不是单调的：${idx.join(",")}`);
});

test("回合相位映射到同一套阶段", () => {
  for (const [phase, idx] of Object.entries(PHASE_STAGE)) {
    assert.ok(idx >= 0 && idx < STAGES.length, `${phase} 越界 ${idx}`);
  }
  assert.equal(PHASE_STAGE.done, STAGES.length - 1);
});

test("词表覆盖全部取值，且中英都有文案", () => {
  for (const s of ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]) {
    assert.ok(STATUS_LABEL[s], `缺状态文案 ${s}`);
    const key = STATUS_KEY[s];
    assert.ok(key, `缺状态 key ${s}`);
    assert.ok(ZH_STRINGS[key], `zh 缺 ${key}`);
    assert.ok(EN_STRINGS[key], `en 缺 ${key}`);
  }
  for (const m of ["running", "delivered", "stuck", "idle"]) {
    const key = MEMBER_STATE_KEY[m];
    assert.ok(MEMBER_STATE_LABEL[m], `缺成员态文案 ${m}`);
    assert.ok(ZH_STRINGS[key] && EN_STRINGS[key], `成员态缺文案 ${key}`);
  }
  for (const k of STAGE_KEYS) {
    assert.ok(ZH_STRINGS[k] && EN_STRINGS[k], `阶段缺文案 ${k}`);
  }
  // 已删除的旧 key 不该留残
  assert.equal(ZH_STRINGS["stage.report"], undefined);
  assert.equal(EN_STRINGS["stage.report"], undefined);
});

test("同一个信号只有一种说法：成员态与台账分组同词", () => {
  assert.equal(MEMBER_STATE_LABEL.delivered, "等你拍板");
  assert.equal(MEMBER_STATE_LABEL.running, "进行中");
  assert.equal(MEMBER_STATE_LABEL.stuck, "卡住");
  assert.equal(MEMBER_STATE_LABEL.idle, "空闲");
});
