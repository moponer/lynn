// 头像库契约（2026-11-13 定稿）：全部人像、12 个槽位各绑一款不同画风。
import { test } from "node:test";
import assert from "node:assert/strict";
import { AVATARS, avatarById, avatarFor, isAvatarId } from "../dist/shared/avatars.js";

test("12 个槽位，画风互不相同——这就是『风格混合』本身", () => {
  assert.equal(AVATARS.length, 12);
  const styles = AVATARS.map((a) => a.style);
  assert.equal(new Set(styles).size, 12, `必须 12 款不同画风：${styles.join(",")}`);
  assert.ok(styles.includes("pixelArt"), "要含马赛克（pixelArt）");
  assert.ok(styles.includes("notionists"), "保留线稿（notionists）");
});

test("契约：id 仍是 a01–a12，查询与兜底都照旧（老档案不会错位）", () => {
  assert.deepEqual(
    AVATARS.map((a) => a.id),
    AVATARS.map((_, i) => `a${String(i + 1).padStart(2, "0")}`),
  );
  assert.ok(isAvatarId("a12"));
  assert.ok(!isAvatarId("p13"));
  assert.equal(avatarById("a11")?.style, "pixelArt", "马赛克槽位在 a11");
  assert.equal(avatarFor("顾明").id, avatarFor("顾明").id, "同一个人永远同一个槽位");
});

test("每条数据齐备：seed / 岗位色 / style 一个不缺", () => {
  for (const a of AVATARS) {
    assert.ok(a.seed, `${a.id} 缺 seed`);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(a.color), `${a.id} 的岗位色不是 hex：${a.color}`);
    assert.ok(a.style.length > 0, `${a.id} 缺 style`);
  }
});
