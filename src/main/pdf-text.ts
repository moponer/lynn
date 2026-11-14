// PDF 文本提取（2026-11-14）：pdfjs-dist 的 legacy build（Mozilla，Apache-2.0）。
// 只做"读文字"：不渲染、不 OCR。扫描件提出来是空的——这时如实说，不能假装读到了内容。
import * as path from "node:path";

export interface PdfExtract {
  text: string;
  /** 总页数 */
  pages: number;
  /** 实际取了多少页 */
  readPages: number;
  /** 一页文字都没有的页数（多半是图片页） */
  emptyPages: number;
}

/** 懒加载 pdfjs（只有真遇到 PDF 才付这 10MB 的代价） */
export async function extractPdfText(buf: Buffer, opts: { maxPages?: number } = {}): Promise<PdfExtract> {
  // pdfjs 的类型对 Node 侧不全，这里只用到 getDocument / getTextContent
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (o: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }>; cleanup?: () => void }>;
      }>;
      destroy?: () => Promise<void>;
    };
  };

  // 标准字体数据：不给路径 pdfjs 会警告（不影响提取，但会刷日志）。
  // pdfjs 要求的是 URL 形式，必须**正斜杠结尾**，Windows 的 `\` 会被判为非法：
  // "Invalid factory url: ... must include trailing slash."
  const standardFontDataUrl = (() => {
    try {
      const dir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
      return `${dir.replace(/\\/g, "/")}/`;
    } catch {
      return undefined;
    }
  })();

  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  });
  const doc = await task.promise;
  const pages = doc.numPages;
  const readPages = Math.min(pages, Math.max(1, opts.maxPages ?? 80));
  const parts: string[] = [];
  let emptyPages = 0;
  try {
    for (let i = 1; i <= readPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => (typeof it.str === "string" ? it.str : "")).join("");
      if (!text.trim()) emptyPages += 1;
      parts.push(text);
      page.cleanup?.();
    }
  } finally {
    try {
      await task.destroy?.();
    } catch {
      /* 释放失败不影响已经拿到的文本 */
    }
  }
  return { text: parts.join("\n\n").trim(), pages, readPages, emptyPages };
}
