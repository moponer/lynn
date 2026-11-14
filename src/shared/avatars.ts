/**
 * 成员头像库（唯一真相源）。
 *
 * 2026-11-13 定稿（用户拍板）：**全部人像，但每张来自不同画风**——
 * 同一个群里 12 个人长得"不是一个画师画的"，靠画风本身就能区分谁是谁，
 * 比 12 张同一款插画更容易认；其中含 pixelArt（马赛克）这种强风格款。
 *
 * 为什么不再用"姓氏首字"：试过，用户要的是有人味的头像；字头像方案留在 git 历史里。
 *
 * 数据契约：a01–a12 一个槽位绑一款画风（style）+ 一个稳定 seed（seed）。
 * 老档案里存的 aXX 仍然有效 —— 只是"哪张脸"按新画风重画，人不会错位。
 * 画风由 DiceBear 在本地画 SVG，不联网、不落素材文件。
 *
 * 色板只取四功能色 + 暖中性，禁蓝紫（见界面铁律）。
 */

export interface AvatarSpec {
  id: string;
  /** 选择器里 hover 的名字，界面正文不印（减少文本噪音） */
  label: string;
  /** 岗位识别色：快照/节点用它，不画在脸上 */
  color: string;
  /** DiceBear 的确定性种子：同一个 seed 永远画出同一张脸 */
  seed: string;
  /** 画风 key（对应 @dicebear/collection 里的导出名，也是渲染层的分发表键） */
  style: string;
}

/** 12 个槽位：一款画风一个槽，相邻成员的画风尽量不同 */
export const AVATARS: AvatarSpec[] = [
  { id: "a01", label: "线条 01", color: "#6fa892", seed: "顾明-01", style: "notionists" },
  { id: "a02", label: "细线 02", color: "#6fa892", seed: "林晚-02", style: "lorelei" },
  { id: "a03", label: "冒险 03", color: "#c9a227", seed: "阿黎-03", style: "adventurer" },
  { id: "a04", label: "卡通 04", color: "#c9a227", seed: "阿计-04", style: "avataaars" },
  { id: "a05", label: "扁平 05", color: "#c8443a", seed: "阿元-05", style: "micah" },
  { id: "a06", label: "简约 06", color: "#c8443a", seed: "沈青-06", style: "personas" },
  { id: "a07", label: "小像 07", color: "#5c9b83", seed: "周禾-07", style: "miniavs" },
  { id: "a08", label: "笑脸 08", color: "#5c9b83", seed: "许舟-08", style: "bigSmile" },
  { id: "a09", label: "大耳 09", color: "#d08a4e", seed: "陈墨-09", style: "bigEars" },
  { id: "a10", label: "涂鸦 10", color: "#d08a4e", seed: "宋栀-10", style: "croodles" },
  { id: "a11", label: "马赛克 11", color: "#9a8f7a", seed: "叶淮-11", style: "pixelArt" },
  { id: "a12", label: "卡通头 12", color: "#9a8f7a", seed: "温砚-12", style: "toonHead" },
];

/** 兼容旧引用名 */
export const CHAR_AVATARS = AVATARS;
export const ALL_AVATARS = AVATARS;

export function isAvatarId(id: unknown): id is string {
  return typeof id === "string" && AVATARS.some((a) => a.id === id);
}

export function avatarById(id?: string | null): AvatarSpec | undefined {
  return id ? AVATARS.find((a) => a.id === id) : undefined;
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 招募时自动挑：按名字定一个起点，然后往后找第一个同队还没用的槽位。
 * 名字没变 → 分配结果稳定；换个名字 → 不会全队撞同一张脸（也就不会撞同一款画风）。
 * 老档案没存 avatarId 时前端也用这个函数兜底。
 */
export function avatarFor(name: string, usedIds: string[] = []): AvatarSpec {
  const start = hashName(name) % AVATARS.length;
  for (let i = 0; i < AVATARS.length; i += 1) {
    const spec = AVATARS[(start + i) % AVATARS.length];
    if (!usedIds.includes(spec.id)) return spec;
  }
  return AVATARS[start];
}
