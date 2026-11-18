import { useMemo } from "react";
import { avatarById, avatarFor, type AvatarSpec } from "../../shared/avatars";
import { AVATAR_DATA_URI } from "./avatars.generated";

/**
 * 成员头像（2026-11-13 定稿）：**全部人像，画风混合**。
 *
 * 每个槽位绑一款 DiceBear 画风（含 pixelArt 马赛克），同一群里画风不同 → 更容易分清人。
 * avatarId 仍是 a01–a12，老档案不会错位。
 *
 * **2026-11-17 改成构建期静态化（P6-3 / 18 章 F3）**：
 * 原来这里在运行时调 DiceBear 现画 SVG，于是 12 款画风的插画路径数据（1.2 MB）作为独立
 * chunk 被 `modulepreload`——首屏就要下载并解析它，而我们要的只是 12 张固定种子的脸。
 * 现在这些脸在构建时生成（`scripts/gen-avatars.mjs` → `avatars.generated.ts`，共 102 KB），
 * 运行时不再依赖 DiceBear，那一整块从包里消失。
 *
 * 取舍：牺牲"运行时任意 seed 现画"的能力。这不是损失——`shared/avatars.ts` 里 12 个槽位的
 * 种子本来就是写死的，从来没有"随机脸"这个需求。
 */

/** 生成一张脸。`size` 参数保留只是为了不改调用方：静态图是矢量，缩放不失真，不需要按尺寸重画 */
export function avatarUri(spec: AvatarSpec, _size = 64): string {
  return AVATAR_DATA_URI[spec.id] ?? AVATAR_DATA_URI.a01;
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
  const uri = useMemo(() => avatarUri(spec), [spec.id]);
  // 状态不压暗头像：线稿变灰会显得脏，在跑的人由进度线与扩散环表达
  return (
    <span className="mcard-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <img src={uri} alt="" draggable={false} />
    </span>
  );
}