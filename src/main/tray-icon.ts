import * as path from "node:path";

/**
 * 托盘图标兜底（2026-11-11）。
 * `assets/tray.png` 是 16×16 的真 PNG，但运行时只读 `dist/assets/tray.png`：
 * 构建产物没复制过去时 nativeImage 是空的，Electron 会创建一个「看不见」的托盘项。
 * 这里内嵌同一张图的 base64，保证任何情况下托盘都有图标；同时给出多个候选路径。
 */
export const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABg0lEQVR4nJ2TTUvkQBCGn+p0ZnA0qIjgXT148ePiaWGvu4t69m948C948ecI+gu8elTx86AIq7AshMmYj+6WzsQxOhkRC5Kmq+ut963qagHoRNEfUPvAkt8DQrO5aj0Du5vE8aF0oug3qANEApzzASIi/o+ztjmJD3DOgN2UzsTkJSIL4B0EnttkBaYwhO0WohrFGCgJr6QTTXrWktmzWmOYmptlYmaKp9t7sqSHKDWqHFEDcF87+XPKyq8fbO/tMD03S5EXo1R4p/MJhk5tUZCnWdWST00atflSykZ+wdSXor6bQJRCBQpVrU2q9GcJ0m5C2utSZDnOWMKxNkEYQq03ehSzZ1vd+MnivzUCrUrgxfEJf6/v0K1w0GBdv8YKTf6ckfyPmV9fRochzhja42M83tzxcH6LbrdeVbj3g1S6XBkQhBpr7JtcEUye9319KzEax9X7UfbDlJH10obSBtdbH+Xhx/TKOGSV7PpjUkkcH4HdwrnTmrR+8Mfv7ezUYzz2BfVWsGE+fw+3AAAAAElFTkSuQmCC";

/** 兜底 PNG 原始字节：nativeImage.createFromBuffer 用 */
export function trayFallbackBuffer(): Buffer {
  return Buffer.from(TRAY_PNG_BASE64, "base64");
}

/**
 * 候选路径按优先级：
 * 1. app.getAppPath()/assets/tray.png —— 开发态仓库根、打包后 resources/app/assets
 * 2. dist/main/../../assets/tray.png —— 同上（asar:false 时的相对写法）
 * 3. dist/main/../assets/tray.png —— 兼容旧代码用的 dist/assets
 */
export function trayIconPaths(appPath: string, mainDir: string): string[] {
  return [
    path.join(appPath, "assets", "tray.png"),
    path.join(mainDir, "..", "..", "assets", "tray.png"),
    path.join(mainDir, "..", "assets", "tray.png"),
  ];
}
