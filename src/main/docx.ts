// 零依赖 .docx 生成器（2026-11-11）。
//
// 为什么不用 Python：python-docx 质量上限更高，但依赖目标机器装了 Python 与第三方包；
// 标准库手写 OOXML 又需要模型即兴拼 XML，兼容性不稳。这里把「常用报告」做成结构化输入，
// 进程内直接产出完整 OOXML 包（[Content_Types] + rels + document + styles + footer），
// 毫秒级、可单测、路径受控。复杂排版（图片/公式/目录域）仍可由成员写 python-docx 兜底。
import * as zlib from "node:zlib";

export type DocxBlock =
  | { type: "heading"; level?: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string }
  | { type: "table"; headers?: string[]; rows: string[][] };

export interface DocxInput {
  title?: string;
  author?: string;
  blocks: DocxBlock[];
  /** 页脚左侧文字（可选） */
  footerText?: string;
  /** 页脚右侧页码（可选） */
  pageNumbers?: boolean;
}

const MAX_BLOCKS = 800;
const MAX_CHARS = 40_000;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * A4 纵向正文宽度（twips）= 页宽 11906 - 左右页边距 1440×2。
 * 表格列宽必须按这个总量分配：只写 `w:tblW auto` + `w:tcW auto` 且不给 `w:tblGrid`，
 * Word/WPS 会把每列压到「一个字宽」，中文表格被竖着排（2026-11-12 用户实拍）。
 */
export const PAGE_TEXT_WIDTH = 11906 - 1440 * 2;
/**
 * 单列最小宽度（twips）。10.5pt 的汉字约 210 twips，单元格左右默认内边距各 108：
 * 4 个字（如「修复层次」）要 4×210 + 216 ≈ 1056，所以下限给 1080，再窄表头就会逐字换行。
 */
const MIN_COL_WIDTH = 1080;

function escapeXml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------- zip（deflate + CRC32，无第三方依赖） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d = new Date()): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 打一个最小但完整的 zip 包（docx 就是 zip）。 */
export function zipPackage(files: readonly { name: string; data: Buffer }[]): Buffer {
  const { time, date } = dosStamp();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- OOXML ----------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/><w:basedOn w:val="Body"/><w:pPr><w:ind w:left="420" w:hanging="210"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table Head"/><w:basedOn w:val="Body"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W_NS}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:compat/></w:settings>`;

const RPR = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/></w:rPr>`;

function para(text: string, style = "Body", extraPPr = ""): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const runs = lines
    .map((line, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("");
  const pPr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extraPPr}</w:pPr>` : "";
  return `<w:p>${pPr}<w:r>${RPR}${runs}</w:r></w:p>`;
}

/** 字符显示宽度：CJK/全角算 2，其余算 1（列宽分配的依据，纯函数可单测） */
export function displayWidth(text: string): number {
  let n = 0;
  for (const ch of String(text ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

/**
 * 按内容分配列宽（twips，总和恰为正文宽度）。
 * 权重 = 该列最长单元格的显示宽度，钳在 4~32 之间：太窄会把标题拆成一列竖字，
 * 太宽会让某一列吃掉整页，剩下的列被挤成 1 个字。
 */
export function planTableColumns(rows: readonly (readonly string[])[], total = PAGE_TEXT_WIDTH): number[] {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  if (cols === 0) return [];
  const weights: number[] = [];
  for (let i = 0; i < cols; i += 1) {
    const longest = rows.reduce((m, r) => Math.max(m, displayWidth(String(r[i] ?? ""))), 0);
    weights.push(Math.min(Math.max(longest, 4), 32));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.max(MIN_COL_WIDTH, Math.round((total * w) / sum)));
  // 超出总量就按比例从最宽的那列往下削，直到装得进一页
  let excess = widths.reduce((a, b) => a + b, 0) - total;
  while (excess > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN_COL_WIDTH) break;
    const take = Math.min(excess, Math.max(20, Math.round(widths[widest] * 0.05)));
    widths[widest] -= take;
    excess -= take;
  }
  // 抹掉四舍五入的零头，让总和精确等于正文宽度（Word 按固定布局时会按这个算）
  const diff = total - widths.reduce((a, b) => a + b, 0);
  const widest = widths.indexOf(Math.max(...widths));
  widths[widest] += diff;
  return widths;
}

function tableXml(headers: string[] | undefined, rows: string[][]): string {
  const head = headers?.length ? [headers] : [];
  const all = [...head, ...rows];
  const widths = planTableColumns(all);
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const trs = all
    .map((cells, ri) => {
      const headRow = head.length > 0 && ri === 0;
      // 表格里不要段后距（默认 120 会把每个单元格撑高一倍）
      const cellPPr = `<w:spacing w:after="0" w:line="260" w:lineRule="auto"/>`;
      const tcs = cells
        .map((c, ci) => {
          const w = widths[ci] ?? widths[widths.length - 1] ?? MIN_COL_WIDTH;
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
            `${headRow ? '<w:vAlign w:val="center"/>' : ""}</w:tcPr>` +
            `${para(String(c ?? ""), headRow ? "TableHead" : "Body", cellPPr)}</w:tc>`
          );
        })
        .join("");
      // 表头行跨页重复 + 行不跨页断开：长表格翻页后还能对上列名
      return `<w:tr><w:trPr>${headRow ? "<w:tblHeader/>" : ""}<w:cantSplit/></w:trPr>${tcs}</w:tr>`;
    })
    .join("");
  return (
    // 宽度用百分比 100%（5000 fiftieths of a percent）+ 固定布局：列宽只认 tblGrid，不再让 Word 自动猜
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>` +
    `<w:tblLayout w:type="fixed"/>` +
    `<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>` +
    `${grid}${trs}</w:tbl>`
  );
}

/** 占位符文本：模板变量没取到值时会原样落进文档（实机：正文里出现「• undefined」） */
const PLACEHOLDER = /^(?:undefined|null|nan|\[object object\])$/i;

/** 正文块的空值/占位符闸：与其生成一份"看着有内容"的废稿，不如当场报错让它改 */
function assertBlockText(text: unknown, index: number, kind: string): void {
  const t = String(text ?? "");
  if (!t.trim()) {
    throw new Error(
      `第 ${index} 个内容块（${kind}）的 text 是空的：空段落/空条目会让文档看起来像缺内容。补上文字，或删掉这一块再生成。`,
    );
  }
  if (PLACEHOLDER.test(t.trim())) {
    throw new Error(
      `第 ${index} 个内容块（${kind}）的 text 是「${t.trim()}」——通常是模板变量没取到值。回到数据源补上真实内容再生成。`,
    );
  }
}

function blocksXml(blocks: readonly DocxBlock[]): string {
  return blocks
    .map((b, i) => {
      switch (b.type) {
        case "heading": {
          assertBlockText(b.text, i + 1, "heading");
          const lv = b.level === 3 ? 3 : b.level === 2 ? 2 : 1;
          return para(b.text, `Heading${lv}`);
        }
        case "paragraph":
          assertBlockText(b.text, i + 1, "paragraph");
          return para(b.text);
        case "bullet":
          assertBlockText(b.text, i + 1, "bullet");
          return para(`• ${b.text}`, "Bullet");
        case "table":
          return tableXml(b.headers, b.rows ?? []);
        default:
          throw new Error(`不支持的 block 类型：${String((b as { type?: string }).type)}`);
      }
    })
    .join("");
}

const FOOTER = (text: string, page: boolean): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
  (text ? `<w:r>${RPR}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : "") +
  (page
    ? `<w:r>${RPR}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${RPR}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r>${RPR}<w:fldChar w:fldCharType="end"/></w:r>`
    : "") +
  `</w:p></w:ftr>`;

/**
 * 生成 .docx 字节。blocks 至少要有一块；超过 800 块或单块超 4 万字直接拒，
 * 避免模型把整个仓库塞进来生成一个打不开的巨文件。
 */
export function buildDocx(input: DocxInput): Buffer {
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (!blocks.length) throw new Error("blocks 不能为空：至少一个段落、标题或表格");
  if (blocks.length > MAX_BLOCKS) throw new Error(`blocks 过多（${blocks.length}），上限 ${MAX_BLOCKS}`);
  for (const [i, b] of blocks.entries()) {
    const text = b.type === "table" ? JSON.stringify(b.rows ?? []) : String((b as { text?: string }).text ?? "");
    if (text.length > MAX_CHARS) throw new Error(`第 ${i + 1} 个内容块过长（${text.length} 字符），上限 ${MAX_CHARS}`);
  }
  if (blocks.some((b) => b.type === "table" && !(b.rows?.length ?? 0) && !(b.headers?.length ?? 0))) {
    throw new Error("表格块至少要给 headers 或 rows");
  }
  if (input.title !== undefined && PLACEHOLDER.test(String(input.title).trim())) {
    throw new Error(`title 是「${String(input.title).trim()}」——模板变量没取到值，补上真实标题再生成。`);
  }

  const titleBlock = input.title ? para(input.title, "Title") : "";
  const body = `${titleBlock}${blocksXml(blocks)}`;
  const sect =
    `<w:sectPr><w:footerReference w:type="default" r:id="rId3"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>` +
    `<w:cols w:space="425"/></w:sectPr>`;

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${sect}</w:body></w:document>`;

  return zipPackage([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOC_RELS, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES, "utf8") },
    { name: "word/settings.xml", data: Buffer.from(SETTINGS, "utf8") },
    {
      name: "word/footer1.xml",
      data: Buffer.from(FOOTER(input.footerText ?? input.author ?? "", input.pageNumbers !== false), "utf8"),
    },
  ]);
}
