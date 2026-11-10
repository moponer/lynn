/**
 * 成员头像库（唯一真相源）：12 张固定的开源插画头像，各有稳定 id 与稳定 seed。
 *
 * 美术资源来自 DiceBear（@dicebear/core + @dicebear/collection），本地生成 SVG、不联网、
 * 不落素材文件。主进程只认这里的 id/seed/color，渲染层才把 seed 交给 DiceBear 画出来。
 * 画风在 renderer/desk/MemberAvatar.tsx 里选（改一个 import），换画风不动这里，
 * 所以 a01–a12 的 id 与落盘契约始终稳定——老档案不会突然换人。
 *
 * 许可：DiceBear 代码 MIT；notionists 风格由 DiceBear 设计（MIT）。
 * 色板只取四功能色 + 暖中性，禁蓝紫（见界面铁律）。
 */

export interface AvatarSpec {
  id: string;
  /** 选择器里 hover 的名字，界面正文不印（减少文本噪音） */
  label: string;
  /** 岗位识别色：快照/节点仍用它，不随画风变 */
  color: string;
  /** DiceBear 的确定性种子：同一个 seed 永远画出同一张脸 */
  seed: string;
}

export const AVATARS: AvatarSpec[] = [
  { id: "a01", label: "青瓷 01", color: "#6fa892", seed: "顾明-01" },
  { id: "a02", label: "青瓷 02", color: "#6fa892", seed: "林晚-02" },
  { id: "a03", label: "黄铜 03", color: "#c9a227", seed: "阿黎-03" },
  { id: "a04", label: "黄铜 04", color: "#c9a227", seed: "阿计-04" },
  { id: "a05", label: "朱砂 05", color: "#c8443a", seed: "阿元-05" },
  { id: "a06", label: "朱砂 06", color: "#c8443a", seed: "沈青-06" },
  { id: "a07", label: "竹青 07", color: "#5c9b83", seed: "周禾-07" },
  { id: "a08", label: "竹青 08", color: "#5c9b83", seed: "许舟-08" },
  { id: "a09", label: "赭橙 09", color: "#d08a4e", seed: "陈墨-09" },
  { id: "a10", label: "赭橙 10", color: "#d08a4e", seed: "宋栀-10" },
  { id: "a11", label: "暖灰 11", color: "#9a8f7a", seed: "叶淮-11" },
  { id: "a12", label: "暖灰 12", color: "#9a8f7a", seed: "温砚-12" },
];

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
 * 招募时自动挑：按名字定一个起点，然后往后找第一张同队还没用的。
 * 名字没变 → 分配结果稳定；换个名字 → 不会全队撞同一张脸。
 * 老档案没存 avatarId 时前端也用这个函数兜底（同一名字仍是同一张脸）。
 */
export function avatarFor(name: string, usedIds: string[] = []): AvatarSpec {
  const start = hashName(name) % AVATARS.length;
  for (let i = 0; i < AVATARS.length; i += 1) {
    const spec = AVATARS[(start + i) % AVATARS.length];
    if (!usedIds.includes(spec.id)) return spec;
  }
  return AVATARS[start];
}
