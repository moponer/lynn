import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
/**
 * 12 款画风各引一次（不要 `import * as`：那样 31 款全会进包）。
 * 一个槽位一款画风 —— 同一个群里的人"不是一个画师画的"，靠画风就能区分谁是谁。
 */
import {
  adventurer,
  avataaars,
  bigEars,
  bigSmile,
  croodles,
  lorelei,
  micah,
  miniavs,
  notionists,
  personas,
  pixelArt,
  toonHead,
} from "@dicebear/collection";
import { avatarById, avatarFor, type AvatarSpec } from "../../shared/avatars";

/**
 * 成员头像（2026-11-13 定稿）：**全部人像，画风混合**。
 *
 * 每个槽位绑一款 DiceBear 画风（含 pixelArt 马赛克），同一群里画风不同 → 更容易分清人。
 * 全部本地画 SVG（data-uri），不联网、不落素材文件。
 * avatarId 仍是 a01–a12，老档案不会错位。
 */

/** 暖纸底：四功能色不上底，不碰蓝紫，纯色不渐变 */
const PAPER = ["f5f4ed", "f0eee6", "eef0e9", "f3ece0"];
const BG_TYPE: ["solid"] = ["solid"];

/**
 * 东亚向约束：黑发 + 暖中性肤色。
 * 免费画风默认是欧美配色；不约束的话一眼看出不是国人。实测这些参数生效。
 * （notionists / croodles 是纯线稿没有这两项，micah 只有发色——所以按画风分别给。）
 */
const HAIR = ["0a0a0a", "1b1b1b", "2c1b18"];
const SKIN = ["f2d6c2", "ecc9ad", "e0ac8c"];

interface BaseOpts {
  seed: string;
  size: number;
  radius: number;
  backgroundColor: string[];
  backgroundType: ["solid"];
}

/** 画风分发表：每款用自己的类型签名调 createAvatar，避免 any 满天飞 */
const RENDER: Record<string, (b: BaseOpts) => string> = {
  notionists: (b) => createAvatar(notionists, b).toDataUri(),
  lorelei: (b) => createAvatar(lorelei, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  adventurer: (b) => createAvatar(adventurer, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  avataaars: (b) => createAvatar(avataaars, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  micah: (b) => createAvatar(micah, { ...b, hairColor: HAIR }).toDataUri(),
  personas: (b) => createAvatar(personas, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  miniavs: (b) => createAvatar(miniavs, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  bigSmile: (b) => createAvatar(bigSmile, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  bigEars: (b) => createAvatar(bigEars, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  croodles: (b) => createAvatar(croodles, b).toDataUri(),
  pixelArt: (b) => createAvatar(pixelArt, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
  toonHead: (b) => createAvatar(toonHead, { ...b, hairColor: HAIR, skinColor: SKIN }).toDataUri(),
};

/** 生成一张脸；size 给 2 倍分辨率，实际显示由外层容器裁 */
export function avatarUri(spec: AvatarSpec, size = 64): string {
  const draw = RENDER[spec.style] ?? RENDER.notionists;
  return draw({
    seed: spec.seed,
    size,
    radius: 10,
    backgroundColor: PAPER,
    backgroundType: BG_TYPE,
  });
}

export function MemberAvatar({
  name,
  avatarId,
  size = 32,
}: {
  name: string;
  /** 岗位档案里选中的头像槽位；没有就按名字稳定兜底 */
  avatarId?: string;
  size?: number;
}) {
  const spec = avatarById(avatarId) ?? avatarFor(name);
  const uri = useMemo(() => avatarUri(spec, Math.max(size * 2, 64)), [spec.id, size]);
  // 状态不压暗头像：线稿变灰会显得脏，在跑的人由进度线与扩散环表达
  return (
    <span className="mcard-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <img src={uri} alt="" draggable={false} />
    </span>
  );
}
