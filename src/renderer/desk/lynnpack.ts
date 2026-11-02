import { buildPack, checkPack, describePack, type LynnPack } from "../../shared/lynnpack";

/**
 * `.lynnpack` 渲染层入口：纯逻辑在 src/shared/lynnpack.ts（主进程与渲染层共用、可单测），
 * 这里只保留浏览器侧的下载动作。
 */

export { buildPack, checkPack, describePack };
export type { LynnPack };

/** 导出：Blob 下载，文件名带日期 */
export function downloadPack(pack: LynnPack): string {
  const name = `lynn-${pack.createdAt.slice(0, 10)}.lynnpack`;
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
