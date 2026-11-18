// 魔法词（2026-11-14）：用户原话里的一个词，只影响当轮。
// 重点是防误触——写代码时提到这个词不能改变行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectMagicWords, magicWordsNotice, MAGIC_WORDS } from "../dist/shared/magic-words.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-magic-"));

test("命中：独立小写散文词，紧贴标点也算", () => {
  assert.deepEqual(detectMagicWords("帮我 ultrathink 一下这个方案"), ["ultrathink"]);
  assert.deepEqual(detectMagicWords("orchestrate, 这几块可以一起做"), ["orchestrate"]);
  assert.deepEqual(detectMagicWords("先 chillax。"), ["chillax"]);
  assert.deepEqual(detectMagicWords("ultrathink + orchestrate"), ["ultrathink", "orchestrate"]);
});

test("不命中：大小写、标识符、路径、调用语法", () => {
  for (const s of [
    "Ultrathink 这个方案",
    "ULTRATHINK",
    "orchestrated 一下",
    "orchestrate.ts 这个文件",
    "foo::orchestrate",
    "orchestrate()",
    "path/to/ultrathink",
    "ULTRA_thinking",
  ]) {
    assert.deepEqual(detectMagicWords(s), [], `不该命中：${s}`);
  }
});

test("不命中：代码块、行内代码、HTML 注释里的词", () => {
  assert.deepEqual(detectMagicWords("```\nultrathink\n```"), []);
  assert.deepEqual(detectMagicWords("~~~ts\nchillax\n~~~"), []);
  assert.deepEqual(detectMagicWords("`ultrathink` 是个词"), []);
  assert.deepEqual(detectMagicWords("<!-- ultrathink --> 正文"), []);
  // 代码块外的仍然命中
  assert.deepEqual(detectMagicWords("```\nfoo\n```\n然后 ultrathink"), ["ultrathink"]);
});

test("notice 只拼命中项，且写明只这一轮有效", () => {
  const one = magicWordsNotice("chillax");
  assert.match(one, /只这一轮有效/);
  assert.match(one, /简短/);
  assert.ok(!one.includes("想清楚"), "没命中的词不能混进来");
  assert.equal(magicWordsNotice("普通消息"), "");
  assert.equal(MAGIC_WORDS.length >= 3, true);
});

test("内核接线：命中写进当轮注入，且拼进历史后立刻清空", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.submitTurn("ultrathink 这个重构怎么做");
    // 2026-11-17 缓存修复 B1：技能/魔法词现在**拼进 history 再发送**（发送=存储），
    // 不再挂在 pendingSkillText 上留给 runChat 二次拼接。
    const lastUser = [...kernel.history].reverse().find((m) => m.role === "user");
    assert.match(lastUser.content, /本轮要求·想清楚/);
    assert.equal(kernel.pendingSkillText, "", "拼进历史后必须清空，防止二次拼接破坏前缀");
  } finally {
    await kernel.dispose();
  }
});
