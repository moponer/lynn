#!/usr/bin/env node
/**
 * 构建期生成头像（P6-3 / 18 章 F3「avatars 构建期静态化」）。
 *
 * 为什么要这么做：12 款 DiceBear 画风的**插画路径数据**加起来 1.2 MB，会作为独立 chunk
 * 被 `modulepreload` —— 首屏就得下载并解析它，而我们真正要的只是 12 张固定种子的脸。
 * 把生成挪到构建期之后，运行时包里就只剩这 12 个 data-URI，DiceBear 整条依赖不进前端。
 *
 * 确定性：种子与画风都来自 `shared/avatars.ts`（唯一真相源），同一份输入永远同样的 SVG，
 * 所以生成物可以入库、可以 diff，也不需要每次构建都重新算（`--check` 只校验一致）。
 *
 * 用法：
 *   node scripts/gen-avatars.mjs           生成/更新 src/renderer/desk/avatars.generated.ts
 *   node scripts/gen-avatars.mjs --check   只校验是否与当前源码一致（CI 用）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createAvatar } from "@dicebear/core";
import * as collection from "@dicebear/collection";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "src/renderer/desk/avatars.generated.ts");

/*
 * 以下是**运行时原来的那套参数**，必须逐字复刻 —— 否则生成出来的脸会悄悄变样：
 * 同一个 seed、同一款画风，换个发色数组就是另一个人。改这里之前先问一句"是产品要改脸吗"。
 */
const PAPER = ["f5f4ed", "f0eee6", "eef0e9", "f3ece0"];
const BG_TYPE = ["solid"];
const HAIR = ["0a0a0a", "1b1b1b", "2c1b18"];
const SKIN = ["f2d6c2", "ecc9ad", "e0ac8c"];
/**
 * 矢量图不需要按显示尺寸生成：128 只是 SVG 的 width/height 属性，缩放不失真。
 * 原来按 `size*2` 现画，是因为位图思维；现在一份固定尺寸就够所有场合。
 */
const RENDER_SIZE = 128;

/** 画风分发表：每款用自己的类型签名调，避免 any 满天飞 */
const STYLE = {
  notionists: (b) => createAvatar(collection.notionists, b),
  lorelei: (b) => createAvatar(collection.lorelei, { ...b, hairColor: HAIR, skinColor: SKIN }),
  adventurer: (b) => createAvatar(collection.adventurer, { ...b, hairColor: HAIR, skinColor: SKIN }),
  avataaars: (b) => createAvatar(collection.avataaars, { ...b, hairColor: HAIR, skinColor: SKIN }),
  micah: (b) => createAvatar(collection.micah, { ...b, hairColor: HAIR }),
  personas: (b) => createAvatar(collection.personas, { ...b, hairColor: HAIR, skinColor: SKIN }),
  miniavs: (b) => createAvatar(collection.miniavs, { ...b, hairColor: HAIR, skinColor: SKIN }),
  bigSmile: (b) => createAvatar(collection.bigSmile, { ...b, hairColor: HAIR, skinColor: SKIN }),
  bigEars: (b) => createAvatar(collection.bigEars, { ...b, hairColor: HAIR, skinColor: SKIN }),
  croodles: (b) => createAvatar(collection.croodles, b),
  pixelArt: (b) => createAvatar(collection.pixelArt, { ...b, hairColor: HAIR, skinColor: SKIN }),
  toonHead: (b) => createAvatar(collection.toonHead, { ...b, hairColor: HAIR, skinColor: SKIN }),
};

const jiti = createJiti(import.meta.url);
const { AVATARS } = await jiti.import("../src/shared/avatars.ts", { default: true });

/**
 * 压一下体积：DiceBear 的 SVG 里有大量可省的空白与空属性组。
 * 只做**无损**压缩（不碰路径数据本身），否则画出来的脸就变了。
 */
export function minifySvg(svg) {
  return svg
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\/>/g, "/>")
    .replace(/\s*=\s*/g, "=")
    .trim();
}

/**
 * 按 `shared/avatars.ts` 的描述生成全部头像的 data-URI。
 * 导出给测试用：**生成物必须与"运行时现画"逐字节一致**，否则就是悄悄换了张脸。
 */
export function buildAvatarUris(avatars) {
  const rows = [];
  for (const a of avatars) {
    const build = STYLE[a.style];
    if (!build) throw new Error(`未知画风：${a.style}（${a.id}）`);
    const svg = build({ seed: a.seed, size: RENDER_SIZE, radius: 10, backgroundColor: PAPER, backgroundType: BG_TYPE }).toString();
    const min = minifySvg(svg);
    // toDataUri 用 encodeURIComponent，比 base64 小一截（SVG 里可编码字符多）
    const uri = `data:image/svg+xml,${encodeURIComponent(min)}`;
    rows.push({ id: a.id, style: a.style, uri, bytes: uri.length, raw: svg.length, min: min.length });
  }
  return rows;
}

const rows = buildAvatarUris(AVATARS);
const rawTotal = rows.reduce((s, r) => s + r.raw, 0);
const minTotal = rows.reduce((s, r) => s + r.min, 0);

const total = rows.reduce((s, r) => s + r.bytes, 0);
if (!process.argv.includes("--quiet")) {
  console.log("头像体积（每张 data-URI）：");
  for (const r of rows) console.log(`  ${r.id} ${r.style.padEnd(12)} ${(r.bytes / 1024).toFixed(1)} KB`);
  console.log(`原始 SVG 合计 ${(rawTotal / 1024).toFixed(1)} KB → 无损压缩后 ${(minTotal / 1024).toFixed(1)} KB`);
  console.log(`data-URI 合计 ${(total / 1024).toFixed(1)} KB`);
}

const header = [
  "// 本文件由 scripts/gen-avatars.mjs 生成，**不要手改**。",
  "//",
  "// 为什么入库：12 张脸是固定种子 + 固定画风的确定性产物，生成一次就不该再变。",
  "// 入库之后，运行时不再需要 DiceBear —— 那 1.2 MB 的插画路径数据不进前端包。",
  "// 改画风/改种子：改 src/shared/avatars.ts，然后 `node scripts/gen-avatars.mjs`。",
  "// CI 校验：`node scripts/gen-avatars.mjs --check`（不一致就失败，防止有人手改生成物）。",
  "",
  "/** avatarId → data:image/svg+xml 的静态头像（与 shared/avatars.ts 一一对应） */",
  "export const AVATAR_DATA_URI: Record<string, string> = {",
  ...rows.map((r) => `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.uri)},`),
  "};",
  "",
  "/** 生成物里有哪些 id（诊断/测试用；不要拿它替代 AVATARS） */",
  "export const GENERATED_AVATAR_IDS = " + JSON.stringify(rows.map((r) => r.id)) + " as const;",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  if (!fs.existsSync(OUT)) {
    console.error(`✖ 生成物不存在：${path.relative(repo, OUT)}——先跑 node scripts/gen-avatars.mjs`);
    process.exitCode = 1;
  } else {
    const cur = fs.readFileSync(OUT, "utf8");
    if (cur !== header) {
      console.error(`✖ ${path.relative(repo, OUT)} 与生成结果不一致：改过 shared/avatars.ts 却没重新生成？`);
      process.exitCode = 1;
    } else {
      console.log(`✓ 头像生成物一致（${(total / 1024).toFixed(1)} KB）`);
    }
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header, "utf8");
  console.log(`已写入 ${path.relative(repo, OUT)}`);
}