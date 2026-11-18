/**
 * 提示词 golden（P2-1c / 05 章 §3）。
 *
 * 这三条锁的是「system prompt 组装」这件事本身，不是某句话好不好：
 *  1. 快照一致：改动提示词必须显式更新 golden，并能在 diff 里看清哪一段变了；
 *  2. 纯函数：同样的输入永远同样的输出与指纹（否则前缀缓存每天都白掉）；
 *  3. 段序固定 + 空段不留空行：没装写作规则插件时，输出与「从来没这个功能」一模一样。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileLynnPrompt, promptDigest, estimateTokens } from "../dist/main/prompt-compiler.js";
import { composeSystemPrompt, DEFAULT_PERSONA } from "../dist/main/persona.js";
import { buildAll, goldenScenarios } from "../scripts/bench/golden.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("golden：当前编译结果与 bench/golden 快照逐字节一致", () => {
  for (const g of buildAll()) {
    const rel = path.relative(path.resolve(here, ".."), g.file);
    assert.ok(fs.existsSync(g.file), `${rel} 不存在——先跑 node scripts/bench/golden.mjs --write`);
    const saved = fs.readFileSync(g.file, "utf8");
    assert.equal(
      g.content,
      saved,
      `${rel} 与代码不一致：提示词变了。确认有意后跑 node scripts/bench/golden.mjs --write，并在 PROGRESS 变更日志里写一行`,
    );
  }
});

test("纯函数：同一输入两次编译，文本与指纹完全相同", () => {
  for (const s of goldenScenarios()) {
    const a = compileLynnPrompt(s.parts);
    const b = compileLynnPrompt({ ...s.parts });
    assert.equal(a.text, b.text);
    assert.equal(a.digest, b.digest);
    assert.equal(a.digest, promptDigest(a.text));
  }
});

test("段序固定：persona → memory → project → environment → rules", () => {
  const p = { persona: "A", memory: "B", project: "C", environment: "D", rules: "E" };
  const c = compileLynnPrompt(p);
  assert.equal(c.text, "ABCDE", "顺序即拼接顺序，调换等于改所有会话的前缀");
  assert.deepEqual(
    c.segments.map((s) => s.name),
    ["persona", "memory", "project", "environment", "rules"],
  );
  assert.equal(c.chars, 5);
});

test("空段不产生多余字符：没装插件与从未有过该功能，输出一致", () => {
  const base = { persona: "A", memory: "B", project: "C", environment: "D" };
  const withoutRules = compileLynnPrompt({ ...base, rules: "" });
  const withEmptyEverything = compileLynnPrompt({ persona: "A", memory: "B", project: "C", environment: "D", rules: "" });
  assert.equal(withoutRules.text, "ABCD");
  assert.equal(withEmptyEverything.text, withoutRules.text);
  // segments 仍列出空段（诊断要看得出「这段现在是 0」），但不产生任何字符
  assert.equal(withoutRules.segments.find((s) => s.name === "rules")?.chars, 0);
});

test("token 估算口径：CJK 一字≈1，其余≈4 字符 1，且随长度单调", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("中文"), 2);
  assert.ok(estimateTokens("中文abc") > estimateTokens("中文"));
});

/**
 * 风铃常驻长度锁（P2-1c-2 / 05 章 §6「风铃常驻 4,266 字 → ≤3,000」）。
 *
 * 这条不是在管文风，是在管**每次调用的固定成本**：常驻段是 1,376 次调用都要付的。
 * 2026-11-17 由 35 条平铺合并到 19 条：4,266 → 2,987 字（-30%），约 3,133 → 2,237 tokens。
 * 要再加内容，先把等量的旧内容合并掉——别让它在没人注意的时候长回去。
 */
test("风铃常驻 system prompt ≤3,000 字（固定成本的乘数）", () => {
  const head = composeSystemPrompt(DEFAULT_PERSONA);
  assert.ok(
    head.length <= 3000,
    `常驻段涨到 ${head.length} 字（上限 3,000，≈${estimateTokens(head)} tokens）。` +
      "固定成本要乘以调用次数：新增规则时请先合并等量的旧规则，并更新 01 章与 PROGRESS 的数字",
  );
  // 指挥者身份是别处（lynn-bridge）依赖的锚点，重写时不许丢
  assert.ok(head.startsWith("你是风铃"), "首句必须仍以「你是风铃」开头");
});
