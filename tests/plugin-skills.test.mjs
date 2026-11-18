/**
 * 插件技能：声明即生效（P12-2）。
 *
 * 修的是 26 章第 2 节记的语义不一致：`contributes.skills` **填不填都不影响加载**——
 * 技能靠扫描整个 `plugins/` 目录里的 `SKILL.md` 被发现。
 *
 * 那带来两个真实问题：
 *  1. 插件作者在 `contributes.skills` 里写错了名字，技能**照样被加载**——
 *     声明与实现不一致，字段等于装饰；
 *  2. 一个插件目录里放两个 `SKILL.md`，用户以为只启用了声明的那一个，实际两个都进了。
 *
 * 现在改成：插件目录**按 manifest 声明**加载。这组测试守四个方向：
 *  - 声明了 → 加载；
 *  - 没声明 → **不加载**（这是本次的核心变化）；
 *  - 声明了但文件不存在 → **报错**（不静默）；
 *  - 用户级 `skills/` 目录行为不变（放进去就生效）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { discoverSkills } = await jiti.import("../src/main/skills.ts", { default: true });

const tmp = (p = "lynn-skill-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 造一个 SKILL.md */
function writeSkill(dir, name, description = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description || `${name} 的说明`}\n---\n\n这是 ${name} 的正文。\n`,
    "utf8",
  );
  return dir;
}

test("插件目录：声明了的技能才加载", () => {
  const root = tmp();
  writeSkill(path.join(root, "wanted"), "wanted");
  writeSkill(path.join(root, "unwanted"), "unwanted");

  const r = discoverSkills([{ dir: root, level: "plugin", declared: ["wanted"] }]);
  assert.equal(r.entries.length, 1, `只该加载声明的那个：${r.entries.map((e) => e.name).join(",")}`);
  assert.equal(r.entries[0].name, "wanted");
});

test("插件目录：没声明就一个都不加载（本次的核心变化）", () => {
  const root = tmp();
  writeSkill(path.join(root, "a"), "a");
  writeSkill(path.join(root, "b"), "b");

  // 不传 declared = 扫全目录（用户级目录的语义）
  const all = discoverSkills([{ dir: root, level: "plugin" }]);
  assert.equal(all.entries.length, 2, "不传 declared 时应扫全目录");

  // 传空数组 = 一个都不要（等价于插件没声明 skills）
  const none = discoverSkills([{ dir: root, level: "plugin", declared: [] }]);
  assert.equal(none.entries.length, 0, "声明为空时不该加载任何技能");
});

test("声明了但目录不存在：报错并点名（不静默少一个）", () => {
  const root = tmp();
  writeSkill(path.join(root, "real"), "real");
  const r = discoverSkills([{ dir: root, level: "plugin", declared: ["real", "typo"] }]);
  assert.equal(r.entries.length, 1);
  assert.ok(
    r.errors.some((e) => /typo/.test(e) && /没有对应/.test(e)),
    `声明了不存在的技能要报出来：${r.errors.join("；")}`,
  );
});

test("声明用技能名（frontmatter 的 name）而不是目录名，也能匹配", () => {
  const root = tmp();
  // 目录名 skill-dir，技能名 weekly-report——两种写法都该能对上
  writeSkill(path.join(root, "skill-dir"), "weekly-report");
  const byName = discoverSkills([{ dir: root, level: "plugin", declared: ["weekly-report"] }]);
  assert.equal(byName.entries.length, 1, `按技能名声明应能匹配：${byName.errors.join("；")}`);

  const byDir = discoverSkills([{ dir: root, level: "plugin", declared: ["skill-dir"] }]);
  assert.equal(byDir.entries.length, 1, "按目录名声明也应能匹配");
});

test("声明指向的目录里没有 SKILL.md：报错", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "empty"), { recursive: true });
  const r = discoverSkills([{ dir: root, level: "plugin", declared: ["empty"] }]);
  assert.equal(r.entries.length, 0);
  assert.ok(r.errors.some((e) => /empty/.test(e) && /没有 SKILL\.md/.test(e)), r.errors.join("；"));
});

test("用户级目录（不传 declared）行为不变：放进去就生效", () => {
  const root = tmp();
  writeSkill(path.join(root, "s1"), "s1");
  writeSkill(path.join(root, "s2"), "s2");
  const r = discoverSkills([{ dir: root, level: "user" }]);
  assert.equal(r.entries.length, 2, "用户级目录不该受声明过滤影响");
  assert.deepEqual(r.errors, []);
});

test("多个 root 各自独立过滤（一个插件不影响另一个）", () => {
  const a = tmp("lynn-a-");
  const b = tmp("lynn-b-");
  writeSkill(path.join(a, "one"), "one");
  writeSkill(path.join(a, "two"), "two");
  writeSkill(path.join(b, "three"), "three");

  const r = discoverSkills([
    { dir: a, level: "plugin", declared: ["one"] },
    { dir: b, level: "plugin", declared: ["three"] },
  ]);
  assert.deepEqual(r.entries.map((e) => e.name).sort(), ["one", "three"]);
});

test("没声明的目录连读都不读（坏 SKILL.md 不该报错）", () => {
  const root = tmp();
  writeSkill(path.join(root, "good"), "good");
  // 没声明的目录里放一个坏文件
  fs.mkdirSync(path.join(root, "bad"), { recursive: true });
  fs.writeFileSync(path.join(root, "bad", "SKILL.md"), "没有 frontmatter 的内容", "utf8");

  const r = discoverSkills([{ dir: root, level: "plugin", declared: ["good"] }]);
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.errors, [], `没声明的目录不该产生错误：${r.errors.join("；")}`);
});