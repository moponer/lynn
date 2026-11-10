/**
 * 区域截图的壳层接线（Electron 窗口 / 全局快捷键 / 原生捕获 / 剪贴板与落盘）。
 *
 * 引擎选 node-screenshots（Rust XCap + N-API，Apache-2.0，各平台预编译二进制）：
 * Windows 走 DXGI 直取帧缓冲，实测 1920×1080 全屏捕获 87ms；比 Electron
 * desktopCapturer 快且不需要 macOS 屏幕录制授权。同一个包还提供 Window.all()，
 * 用来做微信截图那种「鼠标停哪就高亮哪个窗口」。
 *
 * 分工：主进程只负责抓一帧、枚举窗口、校验合成结果、复制/保存；
 * 标注绘制与裁剪在选区窗的 Canvas 上做（原生库没有绘图 API，不为此再引一个图像依赖）。
 * 主进程会核对 PNG 的 IHDR 尺寸与选区是否一致，界面和落盘结果不许错位。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BrowserWindow, ClipboardItem, app, clipboard, dialog, globalShortcut, screen } from "electron";
import type { CaptureRect, CaptureShot, CaptureSize, CaptureStatus, CaptureWindow } from "../shared/contract";
import { MAX_IMAGE_BYTES } from "./attachments";
import {
  captureFileName,
  DEFAULT_CAPTURE_HOTKEY,
  isCaptureHotkey,
  pickMonitorIndex,
  pngDataUrl,
  toPixelRect,
  windowsToDip,
  type DisplayBounds,
  type MonitorBounds,
  type Point,
  type WindowBounds,
} from "./capture";

interface NativeImage {
  readonly width: number;
  readonly height: number;
  cropSync(x: number, y: number, width: number, height: number): NativeImage;
  /** Electron 下必须传 true 复制输出缓冲区，否则 native 侧释放后 V8 读已释放内存会崩（上游 README / napi-rs#1346） */
  toPngSync(copyOutputData: boolean): Buffer;
}

interface NativeMonitor {
  x(): number;
  y(): number;
  width(): number;
  height(): number;
  scaleFactor(): number;
  captureImageSync(): NativeImage;
}

interface NativeWindow {
  x(): number;
  y(): number;
  width(): number;
  height(): number;
  title(): string;
  isMinimized(): boolean;
}

interface NativeModule {
  Monitor: {
    all(): NativeMonitor[];
    fromPoint(x: number, y: number): NativeMonitor | null;
  };
  Window: {
    all(): NativeWindow[];
  };
}

export interface CaptureHostDeps {
  indexHtml(): string;
  preload(): string;
  /** 偏好里配置的全局快捷键（非法值自动回退默认） */
  hotkey: string;
  /** 截图完成：壳层负责推事件 + 唤起主窗 */
  onShot(shot: CaptureShot): void;
  focusMain(): void;
}

export interface CaptureCommit {
  rect: CaptureRect;
  dataUrl: string;
  action: "attach" | "copy" | "save";
}

export interface CaptureHost {
  register(): void;
  start(): { ok: boolean; error?: string };
  frame(): { ok: boolean; data?: string; width: number; height: number; view: CaptureSize; windows: CaptureWindow[]; error?: string };
  commit(p: CaptureCommit): Promise<{ ok: boolean; error?: string; path?: string }>;
  cancel(): { ok: true };
  status(): CaptureStatus;
  takePending(): CaptureShot[];
  setHotkey(combo: string): { ok: boolean; combo: string; registered: boolean; error?: string };
  dispose(): void;
}

export function createCaptureHost(deps: CaptureHostDeps): CaptureHost {
  let engine: NativeModule | null = null;
  let engineError = "";
  let activeHotkey = isCaptureHotkey(deps.hotkey) ? deps.hotkey.trim() : DEFAULT_CAPTURE_HOTKEY;
  let hotkeyRegistered = false;
  /** 选区窗全屏置顶：渲染层万一挂了，主进程这一路 Esc 仍能退出，不把用户锁在屏幕上 */
  let escRegistered = false;
  let overlay: BrowserWindow | null = null;
  let seq = 0;
  const pending: CaptureShot[] = [];

  /** 一次截图会话：冻结帧、显示器几何、可识别窗口都留到选区结束 */
  let current: {
    frameData: string;
    frame: CaptureSize;
    view: CaptureSize;
    windows: CaptureWindow[];
    captureMs: number;
  } | null = null;

  function loadEngine(): NativeModule | null {
    if (engine) return engine;
    try {
      // 动态加载：缺平台二进制不能拖垮整个主进程，status/start 会如实报「引擎不可用」
      engine = require("node-screenshots") as NativeModule;
      engineError = "";
    } catch (err) {
      engineError = `截图引擎加载失败：${err instanceof Error ? err.message : String(err)}`;
      engine = null;
    }
    return engine;
  }

  function releaseEsc(): void {
    if (!escRegistered) return;
    try {
      globalShortcut.unregister("Escape");
    } catch {
      /* 退出路径不因注销失败卡住 */
    }
    escRegistered = false;
  }

  function bindEsc(): void {
    // 只在选区期间临时占用 Esc；注册不上也没关系（渲染层自己的 Esc 仍在）
    try {
      escRegistered = globalShortcut.register("Escape", closeOverlay);
    } catch {
      escRegistered = false;
    }
  }

  function closeOverlay(): void {
    releaseEsc();
    const o = overlay;
    overlay = null;
    current = null;
    if (o && !o.isDestroyed()) o.close();
  }

  function trigger(): void {
    start();
  }

  /** 抓屏之后、开窗之前枚举窗口：列表与冻结帧一致，也不会把选区窗自己算进去 */
  function collectWindows(mod: NativeModule, origin: Point, frame: CaptureSize, view: CaptureSize): CaptureWindow[] {
    let raw: NativeWindow[] = [];
    try {
      raw = mod.Window.all();
    } catch {
      return [];
    }
    const boxes: WindowBounds[] = [];
    for (const w of raw) {
      try {
        if (w.isMinimized() || w.width() < 80 || w.height() < 60) continue;
        boxes.push({ x: w.x(), y: w.y(), width: w.width(), height: w.height(), title: w.title() });
      } catch {
        /* 单个窗口枚举失败不影响其它窗口 */
      }
    }
    return windowsToDip(boxes, origin, frame, view);
  }

  function start(): { ok: boolean; error?: string } {
    if (overlay) return { ok: false, error: "截图正在进行中（Esc 取消后再试）" };
    const mod = loadEngine();
    if (!mod) return { ok: false, error: engineError };

    let cursor: { x: number; y: number };
    let display: DisplayBounds;
    /** Windows 无边框窗口盖不住任务栏，实际内容区是 workArea */
    let area: { x: number; y: number; width: number; height: number };
    try {
      cursor = screen.getCursorScreenPoint();
      const d = screen.getDisplayNearestPoint(cursor);
      display = { ...d.bounds, scaleFactor: d.scaleFactor };
      area = { ...d.workArea };
    } catch (err) {
      return { ok: false, error: `读不到显示器信息：${err instanceof Error ? err.message : String(err)}` };
    }

    let monitor: NativeMonitor | null = null;
    try {
      const list = mod.Monitor.all();
      const boxes: MonitorBounds[] = list.map((m) => ({
        x: m.x(),
        y: m.y(),
        width: m.width(),
        height: m.height(),
        scaleFactor: m.scaleFactor(),
      }));
      const idx = pickMonitorIndex(boxes, display, cursor);
      if (idx >= 0) monitor = list[idx];
      if (!monitor) monitor = mod.Monitor.fromPoint(cursor.x * display.scaleFactor, cursor.y * display.scaleFactor);
    } catch (err) {
      return { ok: false, error: `枚举显示器失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!monitor) return { ok: false, error: "找不到光标所在的显示器，没有截图。" };

    let frameData: string;
    let frame: CaptureSize;
    let origin: Point;
    let captureMs = 0;
    try {
      const t0 = Date.now();
      const image = monitor.captureImageSync();
      if (image.width < 1 || image.height < 1) return { ok: false, error: "抓到的画面是空的，没有截图。" };
      // 把冻结帧裁到窗口真正能覆盖的工作区：否则整屏帧被压缩显示，
      // 选区窗的 DIP 坐标与主进程换算的物理坐标会差几个像素，导出图尺寸对不上。
      const sx = image.width / display.width;
      const sy = image.height / display.height;
      const cx = Math.max(0, Math.round((area.x - display.x) * sx));
      const cy = Math.max(0, Math.round((area.y - display.y) * sy));
      const cw = Math.max(1, Math.min(image.width - cx, Math.round(area.width * sx)));
      const ch = Math.max(1, Math.min(image.height - cy, Math.round(area.height * sy)));
      const png = image.cropSync(cx, cy, cw, ch).toPngSync(true);
      captureMs = Date.now() - t0;
      frame = { width: cw, height: ch };
      frameData = pngDataUrl(png);
      origin = { x: monitor.x() + cx, y: monitor.y() + cy };
    } catch (err) {
      return { ok: false, error: `抓屏失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const view: CaptureSize = { width: area.width, height: area.height };
    current = { frameData, frame, view, windows: collectWindows(mod, origin, frame, view), captureMs };

    try {
      const o = new BrowserWindow({
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        frame: false,
        transparent: false,
        backgroundColor: "#000000",
        show: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        webPreferences: {
          preload: deps.preload(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      overlay = o;
      o.setAlwaysOnTop(true, "screen-saver");
      o.on("closed", () => {
        if (overlay === o) {
          overlay = null;
          current = null;
        }
      });
      o.once("ready-to-show", () => {
        if (!o.isDestroyed()) {
          o.show();
          o.focus();
        }
      });
      void o.loadFile(deps.indexHtml(), { query: { capture: "1" } });
      bindEsc();
    } catch (err) {
      closeOverlay();
      return { ok: false, error: `选区窗打不开：${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  function frame(): { ok: boolean; data?: string; width: number; height: number; view: CaptureSize; windows: CaptureWindow[]; error?: string } {
    if (!current) {
      return { ok: false, width: 0, height: 0, view: { width: 0, height: 0 }, windows: [], error: "没有正在进行的截图（可能已被取消）" };
    }
    return {
      ok: true,
      data: current.frameData,
      width: current.frame.width,
      height: current.frame.height,
      view: current.view,
      windows: current.windows,
    };
  }

  async function commit(p: CaptureCommit): Promise<{ ok: boolean; error?: string; path?: string }> {
    const t0 = Date.now();
    const c = current;
    if (!c) return { ok: false, error: "没有正在进行的截图（可能已被取消）" };
    const px = toPixelRect(p.rect, c.frame, c.view);
    if (!px) return { ok: false, error: "选区无效或太小，重新拖一次。" };

    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(p.dataUrl ?? ""));
    if (!m) return { ok: false, error: "没拿到合成后的 PNG 截图" };
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `这张图 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过随附图片 8MB 上限；请缩小选区。` };
    }
    // 校验 PNG 头与 IHDR 尺寸：渲染层给的图必须就是这块选区，不许界面/落盘错位
    if (buf.length < 24 || buf.subarray(1, 4).toString() !== "PNG") return { ok: false, error: "合成图片不是有效的 PNG" };
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);
    if (Math.abs(pngW - px.width) > 2 || Math.abs(pngH - px.height) > 2) {
      return { ok: false, error: `合成图 ${pngW}×${pngH} 与选区 ${px.width}×${px.height} 不一致` };
    }

    let copied = false;
    if (p.action === "attach" || p.action === "copy") {
      try {
        // Electron 45 起剪贴板走 W3C 风格：旧的 writeImage 已移除
        const item = new ClipboardItem({ "image/png": new Blob([new Uint8Array(buf)], { type: "image/png" }) });
        await clipboard.write([item]);
        copied = true;
      } catch {
        /* 剪贴板不可用时如实标 copied=false，不阻断随附条 */
      }
    }

    if (p.action === "save") {
      // 保存对话框期间先放开 Esc，免得全局快捷键抢走对话框的取消键
      releaseEsc();
      try {
        const options: Electron.SaveDialogOptions = {
          title: "保存截图",
          defaultPath: path.join(app.getPath("pictures"), captureFileName(new Date())),
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        };
        const r = overlay && !overlay.isDestroyed()
          ? await dialog.showSaveDialog(overlay, options)
          : await dialog.showSaveDialog(options);
        if (r.canceled || !r.filePath) return { ok: false, error: "已取消保存" };
        fs.writeFileSync(r.filePath, buf);
        return { ok: true, path: r.filePath };
      } catch (err) {
        return { ok: false, error: `保存失败：${err instanceof Error ? err.message : String(err)}` };
      } finally {
        // 取消保存也要能继续用 Esc 退出选区
        if (overlay && !overlay.isDestroyed()) bindEsc();
      }
    }

    if (p.action === "attach") {
      seq += 1;
      const shot: CaptureShot = {
        id: `cap-${Date.now()}-${seq}`,
        name: captureFileName(new Date()),
        data: pngDataUrl(buf),
        width: pngW,
        height: pngH,
        ms: c.captureMs + (Date.now() - t0),
        copied,
      };
      closeOverlay();
      // 截完回到输入框；窗口刚创建时事件可能漏接，渲染层 mount / focus 会用 capture.pending 补取
      deps.focusMain();
      pending.push(shot);
      if (pending.length > 8) pending.shift();
      deps.onShot(shot);
    } else {
      closeOverlay();
    }
    return { ok: true };
  }

  function cancel(): { ok: true } {
    closeOverlay();
    return { ok: true };
  }

  function status(): CaptureStatus {
    const ready = loadEngine() !== null;
    const note = !ready
      ? engineError || "原生截图引擎不可用。"
      : !hotkeyRegistered
        ? `快捷键 ${activeHotkey} 没注册上（可能被其它程序占用），可在「我的风铃 → 外观」改一个。`
        : `${activeHotkey} 全局截图；自动识别窗口，可标注，Enter / 双击完成，Esc 取消。`;
    return {
      engine: ready,
      ...(engineError ? { engineError } : {}),
      hotkey: activeHotkey,
      registered: hotkeyRegistered,
      active: overlay !== null,
      note,
    };
  }

  function takePending(): CaptureShot[] {
    const all = pending.slice();
    pending.length = 0;
    return all;
  }

  function setHotkey(combo: string): { ok: boolean; combo: string; registered: boolean; error?: string } {
    const next = typeof combo === "string" ? combo.trim() : "";
    if (!isCaptureHotkey(next)) {
      return { ok: false, combo: activeHotkey, registered: hotkeyRegistered, error: "快捷键格式不对：要像 Alt+Shift+S（修饰键 + 主键）。" };
    }
    const old = activeHotkey;
    try {
      globalShortcut.unregister(old);
    } catch {
      /* 本来就没注册上 */
    }
    let ok = false;
    try {
      ok = globalShortcut.register(next, trigger);
    } catch (err) {
      return { ok: false, combo: old, registered: false, error: `注册 ${next} 出错：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!ok) {
      // 不能留着「设置里显示新键、实际一个键都没注册」的假状态：失败就恢复旧的
      try {
        globalShortcut.register(old, trigger);
      } catch {
        /* 旧键也注册不上的话 status 会如实显示 */
      }
      return { ok: false, combo: old, registered: false, error: `${next} 被其它程序占用了，已保持 ${old}。` };
    }
    activeHotkey = next;
    hotkeyRegistered = true;
    return { ok: true, combo: next, registered: true };
  }

  function register(): void {
    try {
      hotkeyRegistered = globalShortcut.register(activeHotkey, trigger);
    } catch (err) {
      hotkeyRegistered = false;
      console.warn(`[capture] ${activeHotkey} 注册异常：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!hotkeyRegistered) console.warn(`[capture] ${activeHotkey} 注册失败（可能被占用）；可在设置里改键，托盘菜单仍可截图`);
  }

  function dispose(): void {
    try {
      globalShortcut.unregister(activeHotkey);
    } catch {
      /* 退出时不因注销失败卡住 */
    }
    closeOverlay();
  }

  return { register, start, frame, commit, cancel, status, takePending, setHotkey, dispose };
}
