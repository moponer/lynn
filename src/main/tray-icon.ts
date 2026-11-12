import * as path from "node:path";

/**
 * 托盘图标兜底（2026-11-11）。
 * `assets/tray.png` 是 16×16 的真 PNG，但运行时只读 `dist/assets/tray.png`：
 * 构建产物没复制过去时 nativeImage 是空的，Electron 会创建一个「看不见」的托盘项。
 * 这里内嵌同一张图的 base64，保证任何情况下托盘都有图标；同时给出多个候选路径。
 */
export const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARElEQVR42mNgoAV4ttXrPzZMtkaiDIEp+P/mBBiTbAixmrEaQIzT8RoyagDphtAmISGDWTkK/9ExSXmBYgPQDWGgJQAAQEF/0W1bgoAAAAAASUVORK5CYII=";

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
