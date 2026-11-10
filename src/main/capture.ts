/**
 * 截图侧的偏好与编码辅助（无 Electron / 无原生依赖，可直接单测）。
 * 几何运算在 `shared/capture-geometry.ts`：主进程和选区窗必须用同一份，
 * 这里保留原来的 import 路径做转出，避免调用点散开。
 */
import type { Buffer } from "node:buffer";

export {
  MIN_SELECTION_DIP,
  normalizeRect,
  toPixelRect,
  pickMonitorIndex,
  windowsToDip,
  pickWindow,
  hitTestHandle,
  resizeRect,
  moveRect,
  type Point,
  type DisplayBounds,
  type MonitorBounds,
  type WindowBounds,
  type Handle,
} from "../shared/capture-geometry";

export const DEFAULT_CAPTURE_HOTKEY = "Alt+Shift+S";

const MODIFIERS = /^(?:Alt|Ctrl|Control|Shift|Super|Cmd|Command|CommandOrControl|Option)$/;
const MAIN_KEY = /^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Space|Tab|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Enter|Backspace|PrintScreen)$/;

/** 全局快捷键必须是「至少一个修饰键 + 一个主键」，避免把单键注册成全局劫持 */
export function isCaptureHotkey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.trim().split("+");
  if (parts.length < 2 || parts.length > 4) return false;
  if (!MAIN_KEY.test(parts[parts.length - 1])) return false;
  return parts.slice(0, -1).every((p) => MODIFIERS.test(p));
}

export function captureFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `截图-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.png`;
}

export function pngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`;
}
