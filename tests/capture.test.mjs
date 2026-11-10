// 区域截图：坐标 / 快捷键纯逻辑 + 改键落盘 + 打包接线防漂移（不依赖 electron 与真屏幕）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CAPTURE_HOTKEY,
  MIN_SELECTION_DIP,
  captureFileName,
  isCaptureHotkey,
  normalizeRect,
  pickMonitorIndex,
  pngDataUrl,
  toPixelRect,
} from "../dist/main/capture.js";
import {
  windowsToDip,
  pickWindow,
  hitTestHandle,
  resizeRect,
  moveRect,
} from "../dist/shared/capture-geometry.js";
import { Kernel } from "../dist/main/kernel.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf-8");

test("normalizeRect：反向拖拽与越界都钳到窗口内", () => {
  const view = { width: 800, height: 600 };
  assert.deepEqual(normalizeRect({ x: 300, y: 400 }, { x: 100, y: 200 }, view), {
    x: 100, y: 200, width: 200, height: 200,
  });
  assert.deepEqual(normalizeRect({ x: -50, y: -20 }, { x: 900, y: 700 }, view), {
    x: 0, y: 0, width: 800, height: 600,
  });
  assert.equal(normalizeRect({ x: 10, y: 10 }, { x: 10, y: 10 }, view).width, 0);
});

test("toPixelRect：按帧/视口比例换算，高 DPI 也不会错位", () => {
  // 单屏 1x：DIP 与物理像素一一对应
  assert.deepEqual(toPixelRect({ x: 100, y: 50, width: 200, height: 100 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }), {
    x: 100, y: 50, width: 200, height: 100,
  });
  // 200% 缩放：捕获图 3840×2160，窗口 1920×1080 DIP
  assert.deepEqual(toPixelRect({ x: 100, y: 50, width: 200, height: 100 }, { width: 3840, height: 2160 }, { width: 1920, height: 1080 }), {
    x: 200, y: 100, width: 400, height: 200,
  });
  // 驱动报的 scaleFactor 与真实像素尺寸有零头时，仍以实际帧尺寸为准且不出界
  const clipped = toPixelRect({ x: 1800, y: 1000, width: 500, height: 500 }, { width: 3841, height: 2159 }, { width: 1920, height: 1080 });
  assert.ok(clipped);
  assert.equal(clipped.x + clipped.width, 3841);
  assert.equal(clipped.y + clipped.height, 2159);
});

test("toPixelRect：太小 / 非数 / 空帧一律拒绝，不产出空白截图", () => {
  const frame = { width: 1920, height: 1080 };
  const view = { width: 1920, height: 1080 };
  assert.equal(toPixelRect({ x: 0, y: 0, width: MIN_SELECTION_DIP - 1, height: 99 }, frame, view), null);
  assert.equal(toPixelRect({ x: Number.NaN, y: 0, width: 100, height: 100 }, frame, view), null);
  assert.equal(toPixelRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }, view), null);
  // 负坐标 / 反向宽高先归一化再换算
  const p = toPixelRect({ x: 300, y: 300, width: -100, height: -100 }, frame, view);
  assert.deepEqual(p, { x: 200, y: 200, width: 100, height: 100 });
});

test("pickMonitorIndex：多屏 + 混合 DPI + 负坐标按光标选对屏", () => {
  const display = { x: -1920, y: 0, width: 1920, height: 1080, scaleFactor: 1 };
  const monitors = [
    { x: 0, y: 0, width: 3840, height: 2160, scaleFactor: 2 }, // 主屏 1920×1080 DIP @2x
    { x: -1920, y: 0, width: 1920, height: 1080, scaleFactor: 1 }, // 左屏
  ];
  assert.equal(pickMonitorIndex(monitors, display, { x: -1000, y: 500 }), 1);
  assert.equal(pickMonitorIndex(monitors, display, { x: 500, y: 500 }), 0);
  assert.equal(pickMonitorIndex([], display, { x: 0, y: 0 }), -1, "没有显示器就如实报找不到");
  assert.equal(pickMonitorIndex([{ x: 0, y: 0, width: 0, height: 0, scaleFactor: 1 }], display, { x: 0, y: 0 }), -1);
});

test("isCaptureHotkey：只认修饰键 + 主键，拒绝单键全局劫持", () => {
  assert.equal(isCaptureHotkey(DEFAULT_CAPTURE_HOTKEY), true);
  assert.equal(isCaptureHotkey("Ctrl+Alt+F12"), true);
  assert.equal(isCaptureHotkey("CommandOrControl+Shift+4"), true);
  for (const bad of ["S", "Alt+", "Alt+nope+", "Alt+Shift+Dancing", "", "Alt+Shift+S+Ctrl+K", 42, null]) {
    assert.equal(isCaptureHotkey(bad), false, `${String(bad)} 不该被接受`);
  }
});

test("captureFileName / pngDataUrl：文件名可排序，data URL 与原字节往返一致", () => {
  const name = captureFileName(new Date(2026, 10, 8, 14, 3, 5));
  assert.equal(name, "截图-20261108-140305.png");
  const buf = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const url = pngDataUrl(buf);
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.deepEqual(Buffer.from(url.slice("data:image/png;base64,".length), "base64"), buf);
});

test("config.prefs：非法快捷键如实拒且不落盘，合法键持久并回读", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-capture-"));
  const kernel = new Kernel(dir);
  try {
    await kernel.init();
    assert.equal(kernel.getPrefs().captureHotkey, DEFAULT_CAPTURE_HOTKEY);
    const bad = kernel.handle("config.prefs", { autoStart: false, captureHotkey: "S" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /格式不对/);
    assert.equal(kernel.getPrefs().captureHotkey, DEFAULT_CAPTURE_HOTKEY, "非法值不能悄悄写进设置");
    const good = kernel.handle("config.prefs", { autoStart: false, captureHotkey: "Ctrl+Alt+4" });
    assert.equal(good.ok, true);
    assert.equal(good.captureHotkey, "Ctrl+Alt+4");
    assert.equal(kernel.getPrefs().captureHotkey, "Ctrl+Alt+4");
  } finally {
    await kernel.dispose();
  }
});

test("windowsToDip：自动识别窗口的物理矩形折成 DIP，过滤小窗并按面积升序", () => {
  const frame = { width: 3840, height: 2160 };
  const view = { width: 1920, height: 1080 };
  const origin = { x: -1920, y: 0 }; // 左屏的物理原点
  const boxes = [
    { x: -1920, y: 0, width: 3840, height: 2160, title: "大窗口" },
    { x: -1520, y: 200, width: 800, height: 600, title: "小窗口" },
    { x: -1500, y: 210, width: 20, height: 20, title: "提示条" },
  ];
  const wins = windowsToDip(boxes, origin, frame, view);
  assert.equal(wins.length, 2, "过小的系统浮层不当窗口");
  assert.deepEqual(wins[0], { x: 200, y: 100, width: 400, height: 300, title: "小窗口" }, "小窗排前面，命中时优先 innermost");
  assert.deepEqual(wins[1], { x: 0, y: 0, width: 1920, height: 1080, title: "大窗口" });
  assert.deepEqual(windowsToDip(boxes, origin, { width: 0, height: 0 }, view), []);
});

test("pickWindow：嵌套窗口命中最小的一块，空白处返回 null", () => {
  const wins = [
    { x: 0, y: 0, width: 1920, height: 1080, title: "桌面" },
    { x: 100, y: 100, width: 400, height: 300, title: "内层" },
  ];
  assert.equal(pickWindow(wins, { x: 120, y: 120 })?.title, "内层");
  assert.equal(pickWindow(wins, { x: 900, y: 900 })?.title, "桌面");
  assert.equal(pickWindow(wins, { x: -1, y: 0 }), null);
});

test("hitTestHandle / resizeRect / moveRect：八向调整与整体平移都不越界", () => {
  const view = { width: 800, height: 600 };
  const r = { x: 100, y: 100, width: 200, height: 150 };
  assert.equal(hitTestHandle(r, { x: 100, y: 100 }), "nw");
  assert.equal(hitTestHandle(r, { x: 300, y: 250 }), "se");
  assert.equal(hitTestHandle(r, { x: 200, y: 100 }), "n");
  assert.equal(hitTestHandle(r, { x: 180, y: 170 }), null, "内部不是手柄");

  assert.deepEqual(resizeRect(r, "se", { x: 300, y: 250 }, { x: 350, y: 280 }, view), {
    x: 100, y: 100, width: 250, height: 180,
  });
  const nw = resizeRect(r, "nw", { x: 100, y: 100 }, { x: 60, y: 70 }, view);
  assert.deepEqual(nw, { x: 60, y: 70, width: 240, height: 180 }, "拖左上角，右下角不动");
  const flipped = resizeRect(r, "e", { x: 300, y: 250 }, { x: -500, y: 250 }, view);
  assert.ok(flipped.width >= 4, "不允许把选区翻过去变成负宽");

  assert.deepEqual(moveRect(r, { x: 150, y: 150 }, { x: 1000, y: -300 }, view), {
    x: 600, y: 0, width: 200, height: 150,
  }, "平移出界只贴边，不缩选区");
});

test("接线防漂移：依赖 / 打包白名单 / 契约 / 壳层 / 许可声明都在", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.dependencies["node-screenshots"], /0\.2\.8/);
  assert.match(read("electron-builder.yml"), /node_modules\/node-screenshots-\*\/\*\*\/\*/);
  assert.match(read("src/shared/contract.ts"), /"capture\.pending"/);
  assert.match(read("src/shared/contract.ts"), /type: "capture"/);
  assert.match(read("src/main/main.ts"), /captureHost\.register\(\)/);
  assert.match(read("src/main/main.ts"), /capture\.pending/);
  // 上游 README 实锤：Electron 里不复制输出缓冲区会崩（napi-rs#1346）
  assert.match(read("src/main/capture-host.ts"), /toPngSync\(true\)/);
  assert.match(read("src/main/capture-host.ts"), /clipboard\.write\(\[item\]\)/);
  assert.match(read("src/main/capture-host.ts"), /showSaveDialog/);
  assert.match(read("src/main/capture-host.ts"), /windowsToDip/);
  // Windows 任务栏会让窗口内容区比整屏矮：冻结帧必须裁到工作区，否则导出图尺寸与选区对不上
  assert.match(read("src/main/capture-host.ts"), /workArea/);
  assert.match(read("src/main/capture-host.ts"), /cropSync\(cx, cy, cw, ch\)/);
  assert.match(read("src/shared/contract.ts"), /view: CaptureSize/);
  assert.match(read("src/shared/contract.ts"), /windows: CaptureWindow\[\]/);
  assert.match(read("src/renderer/capture/CaptureOverlay.tsx"), /pickWindow/);
  assert.match(read("src/renderer/capture/drawing.ts"), /case "mosaic"/);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /node-screenshots/);
});
