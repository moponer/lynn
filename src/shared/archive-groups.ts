// 历史冗余记录的**展示层**折叠（2026-11-11）。
// 硬约束：只分组、不合并、不删除、不改任何数据；归档里的每张单都仍然可单独打开与删除。
// 分组键 = 会话 + 归一化标题，所以跨会话的同名任务不会误并到一起。

export interface ArchiveItem {
  id: string;
  title: string;
  status?: string;
  threadId?: string;
  at?: string;
}

export interface ArchiveGroup {
  key: string;
  /** 展示用标题：取组内第一条的原文，不改写 */
  title: string;
  threadId?: string;
  /** 组内全部原始记录，顺序与输入一致 */
  items: ArchiveItem[];
  count: number;
}

// 「（第2轮）」「（workspace模式重派）」「A2 承接」这类轮次噪声不算任务差异。
const NOISE = /[（(][^）)]*[）)]|第\s*\d+\s*[轮版]|(?:workspace\s*模式)?重派|替补|承接|备份|最终版|[\s·、，,。:：\-_/\\]/gi;

export function normalizeArchiveTitle(s: string): string {
  return String(s ?? "").toLowerCase().replace(NOISE, "").trim();
}

/** 稳定分组：首次出现的组排在前，组内保持原顺序（ newest-first 由调用方决定）。 */
export function groupArchived(items: readonly ArchiveItem[]): ArchiveGroup[] {
  const out: ArchiveGroup[] = [];
  const byKey = new Map<string, ArchiveGroup>();
  for (const it of items) {
    const norm = normalizeArchiveTitle(it.title) || it.id;
    const key = `${it.threadId ?? ""}::${norm}`;
    const found = byKey.get(key);
    if (found) {
      found.items.push(it);
      found.count = found.items.length;
    } else {
      const group: ArchiveGroup = {
        key,
        title: it.title || it.id,
        threadId: it.threadId,
        items: [it],
        count: 1,
      };
      byKey.set(key, group);
      out.push(group);
    }
  }
  return out;
}
