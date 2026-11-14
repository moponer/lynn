// 魔法词（2026-11-14，借鉴 oh-my-pi 的 magic keywords）：用户在原话里写一个词，
// 当轮临时改变她的做法。**只影响那一轮**，不落盘、不改设置、不进 system prompt。
//
// 设计上的三条纪律（都是防误触）：
//   1) 只认全小写；
//   2) 必须是独立散文词——`ultrathink.ts` / `orchestrated` / `foo::ultrathink` / `ultrathink()` 都不算；
//   3) 围栏代码块、行内代码、HTML 注释里的一律忽略（写代码时提到这个词不该改变行为）。
//
// 为什么用词而不是开关：这是个"这一句我想让你想清楚点"的临场要求，翻设置页太远；
// 而它又不该成为常态（常态靠人设与技能），所以只作用于当轮。

export interface MagicWordSpec {
  /** 触发词（全小写） */
  word: string;
  /** 一句话说明（给测试与以后可能的设置页用） */
  why: string;
  /** 拼进当轮消息尾部的说明（不是命令，是"这轮多做一点/少做一点"） */
  notice: string;
}

export const MAGIC_WORDS: readonly MagicWordSpec[] = [
  {
    word: "ultrathink",
    why: "这一轮先想清楚再动手",
    notice:
      "【本轮要求·想清楚】先把做法与依据说清楚再动手：列出关键判断、可能的坑、以及你打算怎么验证。不要边想边改。",
  },
  {
    word: "chillax",
    why: "这一轮结论先行、别展开",
    notice: "【本轮要求·简短】结论先行，不复述过程、不展开分析；需要细节的地方只说一句去哪看。",
  },
  {
    word: "orchestrate",
    why: "这一轮优先并行派单",
    notice:
      "【本轮要求·并行】能拆成互不依赖的几段的，就同时派给不同成员（各管一段、各交各的），不要串行等一个人做完再派下一个。",
  },
];

/** 去掉不该参与匹配的区域：围栏代码块、行内代码、HTML 注释 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** 独立散文词：前后不能是字母数字、下划线、点、斜杠、反斜杠、连字符、冒号（`foo::x` 不算）；
 *  后面紧跟 `(` 也算调用语法（`orchestrate()`） */
function wordPattern(word: string): RegExp {
  return new RegExp(String.raw`(?<![-A-Za-z0-9_./:\\])${word}(?![A-Za-z0-9_./:\\(-])`);
}

/** 命中哪些词（按表顺序，去重） */
export function detectMagicWords(text: string): string[] {
  if (!text) return [];
  const prose = stripCode(text);
  return MAGIC_WORDS.filter((m) => wordPattern(m.word).test(prose)).map((m) => m.word);
}

/** 拼成一段追加到当轮消息尾部的文本；没命中返回空串 */
export function magicWordsNotice(text: string): string {
  const hits = detectMagicWords(text);
  if (!hits.length) return "";
  const notes = MAGIC_WORDS.filter((m) => hits.includes(m.word)).map((m) => m.notice);
  return `【本轮临时要求（用户在这句话里点的，只这一轮有效）】\n${notes.join("\n")}`;
}
