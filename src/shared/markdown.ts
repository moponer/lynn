/**
 * 极简 Markdown 解析（只为聊天输出服务，不做完整 CommonMark）。
 *
 * 为什么要有：模型输出天然带 `**重点**` / 编号 / 列表，之前整段按纯文本直出，
 * 一屏全是星号和挤在一起的编号，读起来像乱码。
 *
 * 纪律：
 *  - 不产出 HTML 字符串（渲染层用 React 元素），没有注入面；
 *  - `*斜体*` / `_斜体_` 只去掉标记、不渲染成斜体（正文禁止斜体是产品约束）；
 *  - 流式未闭合的标记保持原样（半截 `**` 不会吞掉后面的字）。
 */

export interface MdInline {
  /** text=普通文本 / strong=加粗 / code=行内代码 */
  t: "text" | "strong" | "code";
  v: string;
}

export type MdBlock =
  | { t: "p"; spans: MdInline[] }
  | { t: "h"; level: number; spans: MdInline[] }
  | { t: "ul"; items: MdInline[][] }
  | { t: "ol"; items: MdInline[][] }
  | { t: "quote"; spans: MdInline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" };

/** 行内标记：代码 → 粗体 → 粗体(下划线式) → 斜体(只去标记) */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

export function inlineOf(line: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: line.slice(last, at) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "strong", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "strong", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "text", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "text", v: m[5] });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ t: "text", v: line.slice(last) });
  if (out.length === 0) out.push({ t: "text", v: "" });
  return out;
}

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,4})\s+(.+)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^\s*[-*+]\s+(.+)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const INDENTED = /^\s{2,}\S/;

export function parseMarkdown(src: string | undefined): MdBlock[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: MdInline[][] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    // 段内单换行用 \n 保留（渲染层 white-space: pre-wrap），不硬塞 <br/>
    blocks.push({ t: "p", spans: inlineOf(para.join("\n")) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ t: list.kind, items: list.items });
    list = null;
  };
  const flushAll = () => {
    flushList();
    flushPara();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾的 ```
      blocks.push({ t: "code", lang, v: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flushAll();
      i += 1;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      flushAll();
      blocks.push({ t: "h", level: h[1].length, spans: inlineOf(h[2]) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      flushAll();
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushList();
      flushPara();
      const parts: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        parts.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ t: "quote", spans: inlineOf(parts.join("\n")) });
      continue;
    }

    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      flushPara();
      const kind: "ul" | "ol" = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push(inlineOf(ul ? ul[1] : ol![2]));
      i += 1;
      continue;
    }

    // 列表项的续行（缩进）：并进上一条，不另起段落
    if (list && INDENTED.test(line)) {
      const last = list.items[list.items.length - 1];
      last.push({ t: "text", v: "\n" });
      last.push(...inlineOf(line.trim()));
      i += 1;
      continue;
    }

    flushList();
    para.push(line);
    i += 1;
  }
  flushAll();
  return blocks;
}
