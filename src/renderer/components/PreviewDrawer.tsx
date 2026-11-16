import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewReadResult } from "../../shared/contract";
import { Icon } from "./Icon";
import { FileIcon } from "./FileIcon";
import { useT } from "../i18n";
import { HighlightedCode, RichText } from "./RichText";

/**
 * 内置文件预览抽屉（参考 tether-ai 的 FileDrawer）：
 *  - Markdown / HTML 默认渲染视图，一键切源码（带语法高亮与行号）；
 *  - 代码 / 文本 / 日志 / JSON 一律本地高亮，不交给外部关联程序；
 *  - 图片内嵌显示（点图 1:1 ⇄ 适宽）；
 *  - 常见音频/视频用原生 <audio>/<video> 直接播放（2026-11-15：不用另开外部播放器）；
 *  - docx/xlsx/pptx 交给开源库保真渲染（docx-preview / @js-preview/excel /
 *    pptx-preview，全部动态 import 懒加载——只在真的预览该格式时才载入代码包）；
 *  - PDF 走应用内独立窗口（Chromium 自带阅读器）；其余二进制如实说明，外部打开只作为可选出口。
 * 数据全部来自主进程 preview.read，渲染层拿不到任意文件路径。
 */

const RENDERABLE = new Set(["md", "markdown", "mdx", "html", "htm", "csv", "tsv", "json", "jsonc"]);

/**
 * Office 三件套：开源库懒加载渲染。字节随 preview.read 的 RPC 一次到手
 * （Uint8Array，走 Electron IPC 结构化克隆），直接喂给对应库。
 *   docx  → docx-preview（Apache-2.0）保真渲染样式/图片/表格/分页
 *   xlsx  → @js-preview/excel（MIT）多 sheet 页签 + 合并单元格 + 样式
 *   pptx  → pptx-preview（npm 包可商用）幻灯片渲染
 *
 * 为什么不是自定义协议（2026-11-15 实测结论，写在这里免得有人再改回去）：
 *   lynn-asset:// 一次性令牌 + fetch 的方案在本项目跑不通——渲染层页面是 file:// 源，
 *   Chromium 对 fetch 的目标协议有硬限制：
 *   "Cross origin requests are only supported for protocol schemes:
 *    chrome, chrome-extension, chrome-untrusted, data, http, https"，
 *   自定义 scheme 即使注册了 supportFetchAPI 也会被 CORS 拦死（Failed to fetch）。
 *   base64 也不走（膨胀 33%），所以用结构化克隆的 TypedArray。
 * 仍不是"边下边渲染"：渲染库要完整 buffer 才能出图，这里如实说明。
 */
function OfficePane({ ext, content }: { ext: string; content: Uint8Array }) {
  const holder = useRef<HTMLDivElement>(null);
  const excelRef = useRef<{ destroy: () => void } | null>(null);
  const pptxRef = useRef<{ destroy: () => void } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const t = useT();

  useEffect(() => {
    let gone = false;
    setErr(null);
    setBusy(true);

    (async () => {
      try {
        // 字节随 RPC 一次到手（结构化克隆的 Uint8Array）；空内容如实报，不喂库空转
        if (!content.byteLength) {
          if (!gone) {
            setBusy(false);
            setErr("文件是空的，没有可渲染的内容。");
          }
          return;
        }
        // 整块 buffer 直接复用，省一次 8MB 级拷贝；只有 subarray（自身只是窗口）才重新切一段，
        // 否则会把相邻数据一起喂给渲染库。as ArrayBuffer 是必要的：TS 只认得 .buffer 可能是
        // SharedArrayBuffer，而 IPC 结构化克隆不产生共享内存。
        const ab: ArrayBuffer =
          content.byteOffset === 0 && content.byteLength === content.buffer.byteLength
            ? (content.buffer as ArrayBuffer)
            : (content.slice().buffer as ArrayBuffer);
        if (gone || !holder.current) return;

        if (ext === "docx" || ext === "docm") {
          const docx = await import("docx-preview");
          if (gone || !holder.current) return;
          holder.current.innerHTML = "";
          await docx.renderAsync(ab, holder.current, undefined, {
            inWrapper: true,
            renderAltChunks: false,
            useBase64URL: true,
          });
        } else if (ext === "xlsx" || ext === "xlsm") {
          const excel = await import("@js-preview/excel");
          await import("@js-preview/excel/lib/index.css");
          if (gone || !holder.current) return;
          holder.current.innerHTML = "";
          const previewer = excel.default.init(holder.current);
          excelRef.current = previewer;
          await previewer.preview(ab);
        } else {
          const pptx = await import("pptx-preview");
          if (gone || !holder.current) return;
          holder.current.innerHTML = "";
          const previewer = pptx.init(holder.current, { width: 960 });
          pptxRef.current = previewer;
          await previewer.preview(ab);
          if (gone) return;
        }
        if (!gone) setBusy(false);
      } catch (e) {
        if (!gone) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      gone = true;
      try {
        excelRef.current?.destroy();
      } catch {
        /* 实例可能已随容器销毁 */
      }
      excelRef.current = null;
      try {
        pptxRef.current?.destroy();
      } catch {
        /* 实例可能已随容器销毁 */
      }
      pptxRef.current = null;
    };
  }, [ext, content]);

  if (err) {
    return (
      <div className="pv-err">
        <div className="pv-err-head">{t("pv.missing")}</div>
        <div className="pv-err-msg">{err}</div>
      </div>
    );
  }
  return (
    <div className="pv-office">
      <div className="pv-office-holder" ref={holder} />
      {busy && (
        <div className="pv-office-loading">
          <div className="pv-spinner" />
          <span>{t("pv.reading")}</span>
        </div>
      )}
    </div>
  );
}

function fileName(ref: string): string {
  return ref.split(/[\\/]/).filter(Boolean).pop() || ref;
}

/** JSON 美化：合法就缩进重排（键序不重排，只加空格换行）；坏的按原样当源码看 */
function prettyJson(text: string): string {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
}

function CsvTable({ text, ext }: { text: string; ext: string }) {
  const t = useT();
  const sep = ext === "tsv" ? "\t" : ",";
  const rows = useMemo(
    () =>
      text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(0, 200)
        .map((line) => line.split(sep)),
    [text, sep],
  );
  if (rows.length === 0) return <div className="pv-hint">{t("pv.emptyTable")}</div>;
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead>
          <tr>{rows[0].map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(1).map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PreviewDrawer({
  taskId,
  fileRef,
  onClose,
}: {
  taskId: string;
  /** 别叫 ref：那是 React 保留属性，传字符串会直接把组件渲染炸掉 */
  fileRef: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<PreviewReadResult | null>(null);
  const [rendered, setRendered] = useState(true);
  const [wide, setWide] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 图片：false=适配抽屉宽度，true=1:1 原始尺寸（可滚动细看） */
  const [zoomed, setZoomed] = useState(false);
  const t = useT();
  const name = fileName(fileRef);
  const ext = (data?.ext ?? fileRef.split(".").pop() ?? "").toLowerCase();
  const canRender = RENDERABLE.has(ext);

  useEffect(() => {
    let gone = false;
    setData(null);
    setRendered(true);
    setZoomed(false);
    void window.lynn
      .rpc("preview.read", { taskId, ref: fileRef })
      .then((r) => { if (!gone) setData(r); })
      .catch((err: unknown) => {
        if (!gone) setData({ ok: false, kind: "missing", error: err instanceof Error ? err.message : String(err) });
      });
    return () => { gone = true; };
  }, [taskId, fileRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = data?.text ?? "";
  // 音视频动辄几 MB：一律 KB 会在"20480KB"这种读数上失去量感（2026-11-15）
  const bytes = data?.bytes
    ? data.bytes >= 1024 * 1024
      ? `${(data.bytes / 1024 / 1024).toFixed(1)}MB`
      : data.bytes >= 1024
        ? `${Math.round(data.bytes / 1024)}KB`
        : `${data.bytes}B`
    : "";

  return (
    <div className="pv-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`pv-drawer${wide ? " wide" : ""}`} role="dialog" aria-label={`预览 ${name}`}>
        <header className="pv-head">
          <div className="pv-name">
            <FileIcon name={name} size="sm" />
            <strong title={fileRef}>{name}</strong>
            <span className="mono">{bytes}</span>
          </div>
          <div className="pv-acts">
            {canRender && data?.kind === "text" && (
              <button type="button" className="ghost-btn" onClick={() => setRendered((v) => !v)}>
                {rendered ? t("pv.source") : t("pv.preview")}
              </button>
            )}
            {text && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? t("pv.copied") : t("pv.copy")}
              </button>
            )}
            <button type="button" className="ghost-btn" title={t("pv.openExternal")} onClick={() => void window.lynn.rpc("evidence.open", { taskId, ref: fileRef })}>
              <Icon name="folder" size="sm" />
            </button>
            <button type="button" className="ghost-btn" title={wide ? t("pv.narrow") : t("pv.wide")} onClick={() => setWide((v) => !v)}>
              <Icon name={wide ? "minimize" : "maximize"} size="sm" />
            </button>
            <button type="button" className="ghost-btn" title={t("pv.close")} onClick={onClose}>
              <Icon name="x" size="sm" />
            </button>
          </div>
        </header>
        <div className="pv-path mono" title={fileRef}>{fileRef}</div>

        <div className="pv-body">
          {!data && <div className="pv-hint">{t("pv.reading")}</div>}
          {data?.kind === "missing" && <div className="pv-hint">{data.error || t("pv.missing")}</div>}
          {data?.kind === "empty" && <div className="pv-hint">{t("pv.empty")}</div>}
          {data?.kind === "binary" && (
            <div className="pv-hint">
              {data.error ?? t("pv.binary", { ext })}
              <button
                type="button"
                className="ghost-btn pv-hint-act"
                onClick={() => void window.lynn.rpc("evidence.open", { taskId, ref: fileRef })}
              >
                {t("pv.openNow")}
              </button>
            </div>
          )}
          {data?.kind === "pdf" && (
            <div className="pv-hint">
              {t("pv.pdfHint")}
              <button
                type="button"
                className="ghost-btn pv-hint-act"
                onClick={() => void window.lynn.rpc("preview.pdfWindow", { taskId, ref: fileRef })}
              >
                {t("pv.pdfOpen")}
              </button>
            </div>
          )}
          {data?.kind === "image" && data.dataUrl && (
            <div className="pv-image-wrap">
              <img
                className={`pv-image${zoomed ? " full" : ""}`}
                src={data.dataUrl}
                alt={name}
                title={zoomed ? t("pv.zoomFit") : t("pv.zoomFull")}
                onClick={() => setZoomed((v) => !v)}
              />
            </div>
          )}
          {/* 音频（2026-11-15）：原生播放器 + 一份类型/体积信息，不再让用户"用系统程序打开" */}
          {data?.kind === "audio" && data.dataUrl && (
            <div className="pv-media">
              <FileIcon name={name} size="lg" />
              <div className="pv-media-name" title={name}>{name}</div>
              <div className="pv-media-meta mono">
                {[(data.ext ?? ext).toUpperCase(), bytes].filter(Boolean).join(" · ")}
              </div>
              <audio className="pv-audio" src={data.dataUrl} controls preload="metadata" />
              <div className="pv-hint">{t("pv.audioHint")}</div>
            </div>
          )}
          {data?.kind === "video" && data.dataUrl && (
            <div className="pv-media">
              <video className="pv-video" src={data.dataUrl} controls preload="metadata" />
              <div className="pv-hint">{t("pv.videoHint")}</div>
            </div>
          )}
          {data?.kind === "office" && data.dataBytes && (
            <OfficePane ext={data.ext ?? ext} content={data.dataBytes} />
          )}
          {data?.kind === "text" && (
            <>
              {data.truncated && <div className="pv-hint">{t("pv.truncated")}</div>}
              {rendered && (ext === "html" || ext === "htm") ? (
                <iframe className="pv-frame" title={`预览 ${name}`} sandbox="" srcDoc={text} />
              ) : rendered && (ext === "csv" || ext === "tsv") ? (
                <CsvTable text={text} ext={ext} />
              ) : rendered && (ext === "md" || ext === "markdown" || ext === "mdx") ? (
                <RichText text={text} />
              ) : rendered && (ext === "json" || ext === "jsonc") ? (
                // JSON：美化视图（缩进重排，键序不动），源码开关切回原始字节
                <HighlightedCode code={prettyJson(text)} lang="json" path={fileRef} />
              ) : (
                <HighlightedCode code={text} path={fileRef} />
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
