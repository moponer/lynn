import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
// 全站画风：换风格只改这一行的 import（可选：notionists / lorelei / avataaars /
// adventurer / openPeeps / micah，六款实拍对比见 shots/avatar-styles.png）。
// 只引一款，Vite 才能把其余 30+ 款 tree-shake 掉，bundle 不背整个美术馆。
import { notionists as avatarStyle } from "@dicebear/collection";
import { avatarById, avatarFor, type AvatarSpec } from "../../shared/avatars";

/**
 * 成员头像：用 DiceBear 开源插画库在本地把 seed 画成 SVG（data-uri），
 * 不联网、不落素材文件、不依赖 CDN。avatarId 来自岗位档案（设置→团队可换），
 * 老档案没存就按成员名字从库里稳定兜底，同一个人永远同一张脸。
 * 换画风不影响 a01–a12 的 id 与落盘数据，老档案不会突然换人。
 */

/** 暖纸底：四功能色不上底，不碰蓝紫，纯色不渐变；浅深主题共用同一张工牌照 */
const PAPER = ["f5f4ed", "f0eee6", "eef0e9", "f3ece0"];

/** 生成一张脸；size 给 2 倍分辨率，实际显示由外层容器裁到 30/44/72px */
export function avatarUri(spec: AvatarSpec, size = 64): string {
  return createAvatar(avatarStyle, {
    seed: spec.seed,
    size,
    radius: 10,
    backgroundColor: PAPER,
    backgroundType: ["solid"],
  }).toDataUri();
}

export function MemberAvatar({
  name,
  avatarId,
  size = 32,
}: {
  name: string;
  /** 岗位档案里选中的头像 id；没有就按名字从库里稳定取一张 */
  avatarId?: string;
  size?: number;
}) {
  const spec = avatarById(avatarId) ?? avatarFor(name);
  const uri = useMemo(() => avatarUri(spec, Math.max(size * 2, 64)), [spec.seed, size]);
  // 状态不压暗头像：线稿变灰会显得脏，在跑的人由队内排序和顶部计数表达
  return (
    <span className="mcard-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <img src={uri} alt="" draggable={false} />
    </span>
  );
}
