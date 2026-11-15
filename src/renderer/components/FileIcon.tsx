/**
 * 文件类型彩色图标（2026-11-15）：交付箱列表按扩展名给"资源管理器那样"的彩色图标。
 *
 * 两条纪律：
 *  1) 一律内联 SVG（设计规范：图标内联，不引图标库）；
 *  2) 颜色按类型固定、不随主题变——它承载的是"这是什么文件"的分类信息，
 *     不是装饰色；彩色正是用户点名要的（同类文件同色，扫一眼就分得清）。
 */

/** 文件大类：决定颜色与字形 */
export type FileKind = "doc" | "sheet" | "slide" | "pdf" | "image" | "audio" | "video" | "archive" | "code" | "text" | "file";

const KIND_EXT: { kind: FileKind; exts: string[] }[] = [
  { kind: "sheet", exts: ["xlsx", "xlsm", "xls", "csv", "tsv", "ods", "numbers"] },
  { kind: "slide", exts: ["pptx", "pptm", "ppt", "odp", "key"] },
  { kind: "doc", exts: ["docx", "docm", "doc", "odt", "rtf", "pages", "wps"] },
  { kind: "pdf", exts: ["pdf"] },
  { kind: "image", exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff", "heic"] },
  { kind: "audio", exts: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba", "wma", "aiff", "mid"] },
  { kind: "video", exts: ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv"] },
  { kind: "archive", exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"] },
  {
    kind: "code",
    exts: [
      "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "kt", "c", "h", "cpp", "cs",
      "json", "jsonc", "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "less",
      "sh", "ps1", "bat", "sql", "rb", "php", "lua",
    ],
  },
  { kind: "text", exts: ["txt", "md", "markdown", "mdx", "log", "cfg", "conf", "env", "gitignore"] },
];

const COLOR: Record<FileKind, string> = {
  doc: "#3b7dd8",     // 蓝：文档
  sheet: "#2f9e5f",   // 绿：表格
  slide: "#e0762d",   // 橙：演示
  pdf: "#d64545",     // 红：PDF
  image: "#0ea5a4",   // 青：图片
  audio: "#d6409f",   // 品红：音频
  video: "#8b5cf6",   // 紫：视频
  archive: "#b07d3a", // 棕：压缩包
  code: "#5b7186",    // 石板灰蓝：代码/配置
  text: "#7a808a",    // 灰：纯文本
  file: "#9aa0a8",    // 灰（未知）：普通文件
};

/** 白色字形（24×24 坐标系里的一张 16×16 内容区），统一描边风格 */
const GLYPH: Record<FileKind, string> = {
  doc: '<path d="M8 8h8M8 11.6h8M8 15.2h8M8 18.4h5"/>',
  sheet: '<rect x="7.4" y="7.4" width="9.2" height="9.2" rx="1"/><path d="M7.4 10.6h9.2M7.4 13.8h9.2M10.9 7.4v9.2"/>',
  slide: '<rect x="7" y="8" width="10" height="7.6" rx="1"/><path d="M9.2 13.4v-1.8M11.6 13.4v-3M14 13.4v-1.2M11 17.6h2"/>',
  pdf: '<path d="M9.4 16.4V7.6h2.5a2.6 2.6 0 0 1 0 5.2H9.4"/><path d="M14.6 7.6v8.8"/>',
  image: '<circle cx="10" cy="10.2" r="1.3"/><path d="m7.4 16 3.2-3.2 2.1 2.1 2.4-2.6 2.5 3.3z"/>',
  audio: '<path d="M10.6 16.2V9.4l5.2-1.8v6.4"/><circle cx="9" cy="16.4" r="1.7"/><circle cx="14.3" cy="14.4" r="1.7"/>',
  video: '<rect x="6.6" y="8" width="10.8" height="8" rx="1.6"/><path d="M10.6 10.4v3.2l3-1.6z"/>',
  archive: '<rect x="7.6" y="7.2" width="8.8" height="9.6" rx="1"/><path d="M11 7.2v1.6M13 10.2v1.6M11 13.2v1.6M11.4 16.2h1.2"/>',
  code: '<path d="m10 9-3 3 3 3M14 9l3 3-3 3"/>',
  text: '<path d="M8 8.4h8M8 12h8M8 15.6h8M8 19.2h4.4"/>',
  file: '<path d="M9 7.4h4.6L16.6 10v6.6H9z"/><path d="M13.4 7.4V10h3"/>',
};

/** 按文件名/路径判大类（取最后一个点后的扩展名；无扩展名算 file） */
export function fileKindOf(name: string): FileKind {
  const base = String(name ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "file";
  const ext = base.slice(dot + 1).toLowerCase();
  for (const g of KIND_EXT) if (g.exts.includes(ext)) return g.kind;
  return "file";
}

export function FileIcon({ name, size }: { name: string; size?: "sm" | "lg" }) {
  const kind = fileKindOf(name);
  return (
    <svg
      className={`fic${size ? ` ${size}` : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-kind={kind}
    >
      <rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4.2" fill={COLOR[kind]} />
      <g
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: GLYPH[kind] }}
      />
    </svg>
  );
}
