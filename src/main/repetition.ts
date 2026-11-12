// 模型退化复读的流式熔断判定（2026-11-11 长任务实测：thinking 里同一句连打 237 次、
// 17542 字符、86 秒无正文无工具调用，最后靠用户点停止才断）。
// 只做纯字符串判定，不碰 IO、不碰模型，方便单测。

export interface RepetitionHit {
  /** 被重复的片段 */
  unit: string;
  /** 末尾连续重复次数 */
  repeats: number;
  /** 重复段在全文中的起点 */
  start: number;
  /** 重复段总字符数 */
  chars: number;
}

export interface RepetitionOptions {
  minUnit: number;
  maxUnit: number;
  minRepeats: number;
  minChars: number;
  window: number;
}

const DEFAULTS: RepetitionOptions = {
  minUnit: 12,
  maxUnit: 240,
  minRepeats: 4,
  minChars: 240,
  window: 1200,
};

/**
 * 检查文本尾部是否由同一片段连续重复构成。
 * 判定刻意保守：片段 ≥12 字、重复 ≥4 次、重复区 ≥240 字，正常列举/表格/代码不会命中。
 */
export function detectTrailingRepetition(text: string, opts: Partial<RepetitionOptions> = {}): RepetitionHit | null {
  const cfg = { ...DEFAULTS, ...opts };
  if (!text || text.length < cfg.minChars) return null;
  const tail = text.slice(-cfg.window);
  const maxUnit = Math.min(cfg.maxUnit, Math.floor(tail.length / cfg.minRepeats));
  for (let p = cfg.minUnit; p <= maxUnit; p += 1) {
    const unit = tail.slice(-p);
    if (!unit.trim()) continue;
    let repeats = 1;
    let i = tail.length - p;
    while (i - p >= 0 && tail.slice(i - p, i) === unit) {
      repeats += 1;
      i -= p;
    }
    const chars = repeats * p;
    if (repeats >= cfg.minRepeats && chars >= cfg.minChars) {
      return { unit, repeats, start: text.length - chars, chars };
    }
  }
  return null;
}

/**
 * 截掉尾部复读，保留一份原文与前文。
 * hit 只扫最后 window 字符，这里继续往窗口外回溯，把更早的同一串也一起去掉
 * （实测重复 237 次，只截窗口内那十几次等于没截）。
 */
export function stripTrailingRepetition(text: string, hit: RepetitionHit): string {
  const p = hit.unit.length;
  let start = hit.start;
  while (start - p >= 0 && text.slice(start - p, start) === hit.unit) start -= p;
  return `${text.slice(0, start)}${hit.unit}`.trimEnd();
}
