// .docx 读取器（2026-11-12）：把 Word 正文读成结构化 HTML / 纯文本。
//
// 为什么需要它：
//  - 内置预览此前只认文本与图片，.docx 一律落进「二进制，没有内置预览」，
//    用户拿到的 docx 只能靠系统 Word 打开才知道好不好（实机：表格被压成一列竖字，谁都没发现）；
//  - 风铃验收时也看不到产物正文，只能凭成员的「结构齐全」自述点头。
//
// 做法：docx 就是 zip，取出 word/document.xml，把 w:p / w:tbl 映射成 HTML。
// 只读正文，不碰样式表；不认识的部件（图/公式/域）如实跳过并在文本里留标记，不假装渲染。
import * as zlib from "node:zlib";

export interface DocxReadResult {
  html: string;
  text: string;
  /** 解析出的段落 + 表格块数（0 = 正文是空的） */
  blocks: number;
  truncated: boolean;
}

const MAX_BLOCKS = 3000;
const MAX_HTML = 400_000;
const MAX_TEXT = 120_000;

/** 从 zip 里取一个部件（只支持 store/deflate，docx 只用这两种） */
export function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  if (buf.length < 22) return null;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000); // zip 注释上限 65535
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wanted) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      if (start + compSize > buf.length) return null;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g.startsWith("#x") || g.startsWith("#X")) {
      const code = Number.parseInt(g.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (g.startsWith("#")) {
      const code = Number.parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[g] ?? m;
  });
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 一段 w:p 里的可见文字：w:t 拼起来，w:br 转换行，w:tab 转空格，图片留占位标记 */
function paragraphText(xml: string): string {
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>|<w:drawing[\s>]/g;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith("<w:br")) out += "\n";
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else out += "[图片]";
    m = re.exec(xml);
  }
  return out;
}

function styleOf(xml: string): string {
  const m = /<w:pStyle w:val="([^"]+)"/.exec(xml);
  return m ? m[1] : "";
}

interface Block {
  kind: "p" | "table";
  text: string;
  style: string;
  rows?: string[][];
  headerRow?: boolean;
  /** 表格列宽（twips，来自 w:tblGrid）：预览按它还原真实比例，不然看预览和后开 Word 是两个样子 */
  cols?: number[];
}

function parseTable(xml: string): Block {
  const rows: string[][] = [];
  const rowRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let rm: RegExpExecArray | null = rowRe.exec(xml);
  while (rm) {
    const cells: string[] = [];
    const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let cm: RegExpExecArray | null = cellRe.exec(rm[1]);
    while (cm) {
      const paras: string[] = [];
      const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
      let pm: RegExpExecArray | null = pRe.exec(cm[1]);
      while (pm) {
        const t = paragraphText(pm[1]);
        if (t.trim()) paras.push(t);
        pm = pRe.exec(cm[1]);
      }
      cells.push(paras.join("\n"));
      cm = cellRe.exec(rm[1]);
    }
    rows.push(cells);
    rm = rowRe.exec(xml);
  }
  // Word 的表头行带 <w:tblHeader/>；没有就按第一行当表头（报告类表格基本如此）
  const headerRow = /<w:tblHeader\s*\/>/.test(xml) || rows.length > 1;
  const cols = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  return { kind: "table", text: "", style: "", rows, headerRow, cols };
}

/** 把 document.xml 拆成「段落 / 表格」块，保持原顺序 */
export function parseDocxBlocks(xml: string): Block[] {
  const bodyStart = xml.indexOf("<w:body");
  const open = bodyStart >= 0 ? xml.indexOf(">", bodyStart) : -1;
  const close = xml.lastIndexOf("</w:body>");
  const body = open >= 0 && close > open ? xml.slice(open + 1, close) : xml;
  const blocks: Block[] = [];
  const tag = /<w:(tbl|p)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null = tag.exec(body);
  while (m && blocks.length < MAX_BLOCKS) {
    const from = m.index;
    if (m[1] === "tbl") {
      const end = body.indexOf("</w:tbl>", from);
      if (end < 0) break;
      const table = parseTable(body.slice(from, end + 8));
      if ((table.rows?.length ?? 0) > 0) blocks.push(table);
      tag.lastIndex = end + 8;
    } else {
      const end = body.indexOf("</w:p>", from);
      if (end < 0) break;
      const xmlPara = body.slice(from, end + 6);
      const text = paragraphText(xmlPara);
      // 空段落只在文档里制造空隙，预览里没有信息量
      if (text.trim()) blocks.push({ kind: "p", text, style: styleOf(xmlPara) });
      tag.lastIndex = end + 6;
    }
    m = tag.exec(body);
  }
  return blocks;
}

const PREVIEW_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 22px 26px 40px; max-width: 860px;
  font: 14px/1.75 "Segoe UI", "Microsoft YaHei", -apple-system, sans-serif;
  color: #1b1b1b; background: #fff; word-break: break-word;
}
.doc-title { text-align: center; font-size: 24px; font-weight: 600; margin: 6px 0 22px; }
h1 { font-size: 21px; margin: 26px 0 10px; }
h2 { font-size: 17px; margin: 22px 0 8px; }
h3 { font-size: 15px; margin: 18px 0 6px; }
p { margin: 0 0 10px; white-space: pre-wrap; }
p.bullet { padding-left: 1.2em; text-indent: -1.2em; }
table { border-collapse: collapse; width: 100%; margin: 12px 0 16px; font-size: 13px; }
th, td { border: 1px solid #cfcfd4; padding: 6px 9px; vertical-align: top; text-align: left; }
th { background: #f2f2f5; font-weight: 600; }
td:empty::after { content: " "; }
.doc-empty { color: #8a8a92; font-size: 13px; }
`;

function blockToHtml(b: Block): string {
  if (b.kind === "table") {
    const rows = b.rows ?? [];
    const head = b.headerRow && rows.length > 1 ? rows[0] : null;
    const body = head ? rows.slice(1) : rows;
    // 列宽按文档里的 tblGrid 还原：预览跟 Word 排得一样，才能靠预览发现「列被压成一字宽」
    const cols = b.cols ?? [];
    const total = cols.reduce((a, w) => a + w, 0);
    const colgroup =
      total > 0
        ? `<colgroup>${cols.map((w) => `<col style="width:${((w / total) * 100).toFixed(2)}%">`).join("")}</colgroup>`
        : "";
    const th = head ? `<thead><tr>${head.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>` : "";
    const tb = body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
    return `<table${colgroup ? ' style="table-layout:fixed"' : ""}>${colgroup}${th}<tbody>${tb}</tbody></table>`;
  }
  const style = b.style.toLowerCase();
  const text = escapeHtml(b.text);
  if (style.startsWith("title")) return `<div class="doc-title">${text}</div>`;
  if (style === "heading1") return `<h1>${text}</h1>`;
  if (style === "heading2") return `<h2>${text}</h2>`;
  if (style === "heading3" || style === "heading4") return `<h3>${text}</h3>`;
  if (style === "bullet") return `<p class="bullet">${text}</p>`;
  return `<p>${text}</p>`;
}

function blockToText(b: Block): string {
  if (b.kind === "table") {
    const rows = b.rows ?? [];
    return rows.map((r) => `| ${r.map((c) => c.replace(/\n/g, " / ")).join(" | ")} |`).join("\n");
  }
  const style = b.style.toLowerCase();
  if (style.startsWith("title")) return b.text;
  if (style === "heading1") return `\n# ${b.text}`;
  if (style === "heading2") return `\n## ${b.text}`;
  if (style === "heading3" || style === "heading4") return `\n### ${b.text}`;
  // 我们自己生成的 bullet 会把「• 」直接写进正文（不是真列表），读回来别重复叠一个
  if (style === "bullet") return `- ${b.text.replace(/^\s*[•·]\s*/, "")}`;
  return b.text;
}

/**
 * 读 .docx 字节。读不出来（不是合法 docx / 缺 document.xml）时抛错，
 * 由调用方决定降级成「二进制，请外部打开」——不假装读到了内容。
 */
export function readDocx(buf: Buffer): DocxReadResult {
  const doc = readZipEntry(buf, "word/document.xml");
  if (!doc) throw new Error("不是可读的 .docx（zip 里没有 word/document.xml）");
  const blocks = parseDocxBlocks(doc.toString("utf8"));
  let html = "";
  let text = "";
  let truncated = false;
  for (const b of blocks) {
    const h = blockToHtml(b);
    const t = blockToText(b);
    if (html.length + h.length > MAX_HTML || text.length + t.length > MAX_TEXT) {
      truncated = true;
      break;
    }
    html += h;
    text += `${t}\n`;
  }
  if (!blocks.length) {
    html = `<p class="doc-empty">（正文是空的：没有段落也没有表格）</p>`;
    text = "";
  }
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${html}</body></html>`,
    text: text.trim(),
    blocks: blocks.length,
    truncated,
  };
}

/** 只取纯文本（风铃验收读正文用） */
export function readDocxText(buf: Buffer): string {
  return readDocx(buf).text;
}
