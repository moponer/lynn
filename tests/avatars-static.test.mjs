/**
 * 头像构建期静态化（P6-3 / 18 章 F3）。
 *
 * 这组断言的重心不是"文件生成了"，而是**生成物与原来的运行时现画完全一致**——
 * 换一张脸是最容易被忽视的回归：没人会去 diff 一个 data-URI，但用户一眼能看出"这个人变了"。
 * 所以这里用**同一份 recipe**（生成脚本导出的）重新画一遍，逐字节比对。
 *
 * 另外钉住两条：
 *  - 12 个槽位一个不少（缺了会静默回落到 a01，等于全群撞脸）；
 *  - 总体积 ≤200 KB（18 章 §7 的验收线），否则首屏白省。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const { AVATARS } = await jiti.import("../src/shared/avatars.ts", { default: true });
const generated = await jiti.import("../src/renderer/desk/avatars.generated.ts", { default: true });
const { buildAvatarUris } = await jiti.import("../scripts/gen-avatars.mjs", { default: true });

const { AVATAR_DATA_URI, GENERATED_AVATAR_IDS } = generated;
const AVATAR_BUDGET = 200 * 1024;

test("12 个槽位一个不少（缺一个就会静默回落到 a01，全群撞脸）", () => {
  assert.equal(AVATARS.length, 12);
  for (const a of AVATARS) {
    assert.ok(AVATAR_DATA_URI[a.id], `缺少 ${a.id}（${a.style}）的静态头像`);
    assert.match(AVATAR_DATA_URI[a.id], /^data:image\/svg\+xml,/, `${a.id} 不是 SVG data-URI`);
  }
  assert.deepEqual([...GENERATED_AVATAR_IDS].sort(), AVATARS.map((a) => a.id).sort());
});

test("逐字节一致：静态生成物 == 用同一份 recipe 现画出来的结果", () => {
  const fresh = buildAvatarUris(AVATARS);
  for (const r of fresh) {
    assert.equal(
      AVATAR_DATA_URI[r.id],
      r.uri,
      `${r.id}（${r.style}）与现画结果不一致——要么改过 shared/avatars.ts 没重新生成，要么生成 recipe 漂了`,
    );
  }
});

test("体积在预算内（≤200 KB），否则首屏那点省下来的又还回去", () => {
  const total = Object.values(AVATAR_DATA_URI).reduce((s, u) => s + u.length, 0);
  console.log(`  12 张头像合计 ${(total / 1024).toFixed(1)} KB（预算 ${AVATAR_BUDGET / 1024} KB）`);
  assert.ok(total <= AVATAR_BUDGET, `头像合计 ${(total / 1024).toFixed(1)} KB 超预算`);
});

test("运行时不再依赖 DiceBear（否则 1.2 MB 的插画数据又回到包里）", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(here, "..", "src/renderer/desk/MemberAvatar.tsx"), "utf8");
  assert.ok(!src.includes("@dicebear"), "MemberAvatar 又 import 了 DiceBear：构建期静态化会失效");
  assert.match(src, /avatars\.generated/, "应当从生成物读静态头像");
});