/**
 * 微信式选区窗（独立 BrowserWindow，query capture=1）。
 *
 * 能力：自动识别窗口（单击截整窗）、自由框选、八向手柄调整 / 拖动移动、
 * 矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 / 序号标注、颜色粗细、撤销、
 * 放大镜取色、复制 / 另存为 / 完成（进本轮随附）。
 *
 * 底图是主进程已经抓好的冻结帧；Canvas 用物理像素尺寸绘制标注，
 * 提交时按选区裁一块 PNG 交给主进程校验并复制 / 落盘。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  MIN_SELECTION_DIP,
  hitTestHandle,
  moveRect,
  normalizeRect,
  pickWindow,
  resizeRect,
  toPixelRect,
  type Handle,
  type Point,
} from "../../shared/capture-geometry";
import type { CaptureRect, CaptureSize, CaptureWindow } from "../../shared/contract";
import {
  COLORS,
  WIDTHS,
  renderAll,
  shapeFromDrag,
  type DrawTool,
  type Shape,
  type Tool,
} from "./drawing";

interface Frame {
  width: number;
  height: number;
  windows: CaptureWindow[];
  img: HTMLImageElement;
}

type Drag =
  | { mode: "new"; from: Point; moved: boolean }
  | { mode: "move"; from: Point; start: CaptureRect }
  | { mode: "resize"; from: Point; start: CaptureRect; handle: Handle }
  | { mode: "draw"; from: Point; tool: DrawTool; points: Point[] }
  | null;

interface TextDraft {
  x: number;
  y: number;
  value: string;
}

const TOOL_LIST: { id: Tool; label: string }[] = [
  { id: "select", label: "指针" },
  { id: "rect", label: "矩形" },
  { id: "ellipse", label: "椭圆" },
  { id: "arrow", label: "箭头" },
  { id: "pen", label: "画笔" },
  { id: "mosaic", label: "马赛克" },
  { id: "text", label: "文字" },
  { id: "number", label: "序号" },
];
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function CaptureOverlay() {
  const [view, setView] = useState<CaptureSize>({ width: 0, height: 0 });
  const [frameReady, setFrameReady] = useState(false);
  const [rect, setRect] = useState<CaptureRect | null>(null);
  const [hover, setHover] = useState<CaptureWindow | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [lineWidth, setLineWidth] = useState<number>(WIDTHS[1]);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 拖拽 / 标注 / 框选进行中：工具栏先收起，松手（选区确定）后才出现 */
  const [dragging, setDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magTextRef = useRef<HTMLSpanElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const viewRef = useRef<CaptureSize>({ width: 0, height: 0 });
  const rectRef = useRef<CaptureRect | null>(null);
  const dragRef = useRef<Drag>(null);
  const shapesRef = useRef<Shape[]>([]);
  const draftRef = useRef<Shape | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const numberSeq = useRef(0);

  const setRectBoth = (r: CaptureRect | null) => {
    rectRef.current = r;
    setRect(r);
  };
  const setTextBoth = (t: TextDraft | null) => {
    textDraftRef.current = t;
    setTextDraft(t);
  };

  /** 从原始冻结帧 + 全部标注重画（撤销 / 拖动预览都走这一条，结果确定） */
  const redraw = () => {
    const c = canvasRef.current;
    const f = frameRef.current;
    const v = viewRef.current;
    if (!c || !f || !v.width) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    renderAll({ ctx, base: f.img, scale: c.width / v.width, canvasW: c.width, canvasH: c.height }, shapesRef.current, draftRef.current);
  };

  useEffect(() => {
    let dead = false;
    const v = { width: window.innerWidth, height: window.innerHeight };
    viewRef.current = v;
    setView(v);
    void window.lynn
      .rpc("capture.frame")
      .then((r) => {
        if (dead) return;
        if (!r.ok || !r.data) {
          setMsg(r.error ?? "取不到冻结画面");
          return;
        }
        // 用主进程下发的视口口径（工作区），不猜 innerHeight：
        // Windows 任务栏会让窗口内容区比整屏矮几十像素，猜错会让导出图和选区差一截。
        const v = { width: r.view?.width || window.innerWidth, height: r.view?.height || window.innerHeight };
        viewRef.current = v;
        setView(v);
        const img = new Image();
        img.onload = () => {
          if (dead) return;
          frameRef.current = { width: r.width, height: r.height, windows: r.windows ?? [], img };
          const c = canvasRef.current;
          if (c) {
            c.width = r.width;
            c.height = r.height;
            redraw();
          }
          setFrameReady(true);
        };
        img.onerror = () => {
          if (!dead) setMsg("冻结画面解码失败");
        };
        img.src = r.data;
      })
      .catch((err: unknown) => {
        if (!dead) setMsg(`取不到冻结画面：${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (textDraft) textInputRef.current?.focus();
  }, [textDraft]);

  const cancel = useCallback(() => {
    void window.lynn.rpc("capture.cancel").catch(() => {
      /* 主进程的 Esc 兜底可能已经先关了窗 */
    });
  }, []);

  const undo = useCallback(() => {
    if (shapesRef.current.length === 0) return;
    shapesRef.current.pop();
    redraw();
  }, []);

  const commitText = useCallback(() => {
    const t = textDraftRef.current;
    if (!t) return;
    const text = t.value.trim();
    if (text) {
      shapesRef.current.push(shapeFromDrag("text", color, lineWidth, [{ x: t.x, y: t.y }], text));
      redraw();
    }
    setTextBoth(null);
  }, [color, lineWidth]);

  const finish = useCallback(async (action: "attach" | "copy" | "save") => {
    const f = frameRef.current;
    const v = viewRef.current;
    const r = rectRef.current;
    const c = canvasRef.current;
    if (!f || !v.width || !c) return;
    if (!r) {
      setMsg("先框一块区域（或单击自动识别的窗口）");
      return;
    }
    const px = toPixelRect(r, { width: f.width, height: f.height }, v);
    if (!px) {
      setMsg("选区太小，重新拖一次");
      return;
    }
    const out = document.createElement("canvas");
    out.width = px.width;
    out.height = px.height;
    const octx = out.getContext("2d");
    if (!octx) {
      setMsg("合成画布不可用");
      return;
    }
    octx.drawImage(c, px.x, px.y, px.width, px.height, 0, 0, px.width, px.height);
    let dataUrl: string;
    try {
      dataUrl = out.toDataURL("image/png");
    } catch (err) {
      setMsg(`导出 PNG 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setBusy(true);
    try {
      const res = await window.lynn.rpc("capture.commit", { rect: r, dataUrl, action });
      if (!res.ok) {
        setMsg(res.error ?? "截图没成功");
        setBusy(false);
        return;
      }
      if (action === "save") {
        setMsg(`已保存到 ${res.path ?? "文件"}`);
        setBusy(false);
      }
      // attach / copy：主进程会关窗，这里不必再动状态
    } catch (err) {
      setMsg(`截图没成功：${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 文字输入框自己处理 Enter / Esc，别让全局 Enter 顺手把截图提交了
      if ((e.target as HTMLElement | null)?.classList?.contains("cap-text-input")) return;
      if (textDraftRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          setTextBoth(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          commitText();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void finish("attach");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, commitText, finish, undo]);

  /** 放大镜：读工作画布的像素，跟微信一样给十字定位 + 色值，命令式更新不触发重渲染 */
  const updateMagnifier = (p: Point) => {
    const el = magRef.current;
    const mc = magCanvasRef.current;
    const c = canvasRef.current;
    const v = viewRef.current;
    if (!el || !mc || !c || !v.width) return;
    el.style.display = "block";
    el.style.left = `${Math.min(p.x + 20, v.width - 96)}px`;
    el.style.top = `${Math.min(p.y + 20, v.height - 108)}px`;
    try {
      const ctx = mc.getContext("2d");
      if (!ctx) return;
      const s = c.width / v.width;
      const sx = Math.round(p.x * s);
      const sy = Math.round(p.y * s);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(c, sx - 8, sy - 8, 16, 16, 0, 0, 64, 64);
      const d = ctx.getImageData(32, 32, 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      if (magTextRef.current) magTextRef.current.textContent = `${hex}　${Math.round(p.x)}, ${Math.round(p.y)}`;
    } catch {
      /* 取色失败不影响主流程 */
    }
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || busy || e.detail > 1) return;
    setDragging(true);
    const p = { x: e.clientX, y: e.clientY };
    if (textDraftRef.current) {
      commitText();
      return;
    }
    if (tool !== "select") {
      const r = rectRef.current;
      if (!r || p.x < r.x || p.x > r.x + r.width || p.y < r.y || p.y > r.y + r.height) {
        setMsg("标注请画在选区内");
        return;
      }
      if (tool === "text") {
        setTextBoth({ x: p.x, y: p.y, value: "" });
        return;
      }
      if (tool === "number") {
        numberSeq.current += 1;
        shapesRef.current.push(shapeFromDrag("number", color, lineWidth, [p], undefined, numberSeq.current));
        redraw();
        return;
      }
      dragRef.current = { mode: "draw", from: p, tool: tool as DrawTool, points: [p] };
      return;
    }
    const r = rectRef.current;
    if (r) {
      const h = hitTestHandle(r, p);
      if (h) {
        dragRef.current = { mode: "resize", from: p, start: r, handle: h };
        return;
      }
      if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) {
        dragRef.current = { mode: "move", from: p, start: r };
        return;
      }
    }
    dragRef.current = { mode: "new", from: p, moved: false };
    setHover(null);
  };

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const p = { x: e.clientX, y: e.clientY };
    updateMagnifier(p);
    const d = dragRef.current;
    if (!d) {
      if (!rectRef.current && tool === "select" && frameRef.current) setHover(pickWindow(frameRef.current.windows, p));
      return;
    }
    if (d.mode === "new") {
      if (Math.hypot(p.x - d.from.x, p.y - d.from.y) <= 3) return;
      d.moved = true;
      const nr = normalizeRect(d.from, p, viewRef.current);
      if (nr.width >= MIN_SELECTION_DIP && nr.height >= MIN_SELECTION_DIP) setRectBoth(nr);
    } else if (d.mode === "move") {
      setRectBoth(moveRect(d.start, d.from, p, viewRef.current));
    } else if (d.mode === "resize") {
      setRectBoth(resizeRect(d.start, d.handle, d.from, p, viewRef.current));
    } else if (d.mode === "draw") {
      if (d.tool === "pen") d.points.push(p);
      else d.points = [d.points[0], p];
      draftRef.current = shapeFromDrag(d.tool, color, lineWidth, d.points);
      redraw();
    }
  };

  const onMouseUp = (e: ReactMouseEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d) return;
    if (d.mode === "draw") {
      if (draftRef.current) {
        shapesRef.current.push(draftRef.current);
        draftRef.current = null;
        redraw();
      }
      return;
    }
    if (d.mode === "new" && !d.moved) {
      const p = { x: e.clientX, y: e.clientY };
      const r = rectRef.current;
      const inside = r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
      if (!inside) {
        const w = pickWindow(frameRef.current?.windows ?? [], p);
        if (w) setRectBoth({ x: w.x, y: w.y, width: w.width, height: w.height });
        else if (!r) setMsg("这里没有识别到窗口，拖动鼠标自由框选");
      }
    }
  };

  const barLeft = rect ? Math.max(8, Math.min(rect.x, Math.max(8, view.width - 640))) : 0;
  const barTop = rect
    ? rect.y + rect.height + 8 + 92 <= view.height
      ? rect.y + rect.height + 8
      : Math.max(8, rect.y - 96)
    : 0;

/** 选区预览：整张冻结帧按选区缩放后裁出一小块，截图小时也保持最小预览框，方便确认 */
function PreviewThumb({ data, view, rect }: { data: string; view: CaptureSize; rect: CaptureRect }) {
  const MAXW = 120;
  const MAXH = 76;
  const ratio = rect.width / rect.height;
  let pw = MAXW;
  let ph = MAXH;
  if (ratio > MAXW / MAXH) ph = Math.round(pw / ratio);
  else pw = Math.round(ph * ratio);
  pw = Math.max(36, pw);
  ph = Math.max(24, ph);
  const scale = pw / rect.width;
  return (
    <div className="cap-preview" style={{ width: pw, height: ph }}>
      <div
        className="cap-preview-inner"
        style={{
          width: view.width,
          height: view.height,
          left: -rect.x,
          top: -rect.y,
          transform: `scale(${scale})`,
          backgroundImage: `url("${data}")`,
          backgroundSize: `${view.width}px ${view.height}px`,
        }}
      />
    </div>
  );
}

  return (
    <div
      className="cap-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={() => void finish("attach")}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <canvas ref={canvasRef} className="cap-frame" />

      {!rect && <div className="cap-shade" style={{ left: 0, top: 0, width: view.width, height: view.height }} />}
      {rect && (
        <>
          <div className="cap-shade" style={{ left: 0, top: 0, width: view.width, height: rect.y }} />
          <div className="cap-shade" style={{ left: 0, top: rect.y + rect.height, width: view.width, height: Math.max(0, view.height - rect.y - rect.height) }} />
          <div className="cap-shade" style={{ left: 0, top: rect.y, width: rect.x, height: rect.height }} />
          <div className="cap-shade" style={{ left: rect.x + rect.width, top: rect.y, width: Math.max(0, view.width - rect.x - rect.width), height: rect.height }} />
        </>
      )}

      {!rect && hover && (
        <div className="cap-win" style={{ left: hover.x, top: hover.y, width: hover.width, height: hover.height }}>
          <span className="cap-win-label">{hover.title || "窗口"} · 单击截取</span>
        </div>
      )}

      {rect && (
        <div className="cap-outline" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
          <span className="cap-size mono">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
          {HANDLES.map((h) => (
            <i key={h} className={`cap-handle ${h}`} />
          ))}
        </div>
      )}

      {rect && !dragging && (
        <div
          className="cap-bar"
          style={{ left: barLeft, top: barTop }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <PreviewThumb data={frameRef.current?.img.src ?? ""} view={view} rect={rect} />
          <span className="cap-sep" />
          <div className="cap-bar-tools">
            {TOOL_LIST.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`cap-tool${tool === t.id ? " on" : ""}`}
                title={t.label}
                onClick={() => {
                  setTool(t.id);
                  setMsg(null);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="cap-sep" />
          <div className="cap-bar-tools">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`cap-swatch${color === c ? " on" : ""}`}
                style={{ background: c }}
                title={`颜色 ${c}`}
                aria-label={`颜色 ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
            {WIDTHS.map((w) => (
              <button key={w} type="button" className={`cap-tool${lineWidth === w ? " on" : ""}`} title={`粗细 ${w}`} onClick={() => setLineWidth(w)}>
                {w}
              </button>
            ))}
          </div>
          <span className="cap-sep" />
          <div className="cap-bar-tools">
            <button type="button" className="cap-tool" onClick={undo} title="Ctrl+Z">
              撤销
            </button>
            <button type="button" className="cap-tool" disabled={busy} onClick={() => void finish("copy")}>
              复制
            </button>
            <button type="button" className="cap-tool" disabled={busy} onClick={() => void finish("save")}>
              保存
            </button>
            <button type="button" className="cap-tool primary" disabled={busy} onClick={() => void finish("attach")}>
              完成
            </button>
            <button type="button" className="cap-tool" onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      )}

      {textDraft && (
        <input
          ref={textInputRef}
          className="cap-text-input"
          style={{ left: textDraft.x, top: textDraft.y }}
          value={textDraft.value}
          placeholder="输入文字，回车确认"
          onChange={(e) => setTextBoth({ ...textDraft, value: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitText();
            else if (e.key === "Escape") setTextBoth(null);
          }}
        />
      )}

      <div className="cap-mag" ref={magRef} style={{ display: "none" }}>
        <canvas ref={magCanvasRef} width={64} height={64} />
        <span ref={magTextRef} className="mono" />
      </div>

      <div className="cap-hint">
        {rect
          ? "拖动选区可移动 · 拖八向控制点可缩放 · 工具栏标注 · Enter / 双击完成 · Esc 取消"
          : "移动鼠标自动识别窗口 · 单击截整个窗口 · 拖动自由框选 · Esc 取消"}
      </div>
      {msg && <div className="cap-msg">{msg}</div>}
      {!frameReady && !msg && <div className="cap-msg">正在冻结画面…</div>}
    </div>
  );
}
