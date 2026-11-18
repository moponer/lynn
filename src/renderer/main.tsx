import React from "react";
import { createRoot } from "react-dom/client";
// 字体随包（离线、零网络请求）：Archivo 只是拉丁标题字，等宽字承担审计线索（规范 §3.3）
import "@fontsource-variable/archivo/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
// 中文不随包，走系统 CJK 栈（见 tokens.css 的 --f-cjk 注释）：
// 一套思源黑体三档字重 ≈ 20MB+，对桌面应用是纯负担；Windows/macOS 自带的
// 微软雅黑 / 苹方在 12–22px 区间的字形质量足够。此前的问题不是"没打包"，
// 而是字体栈把从未随包的 "Noto Sans SC" 写在第一位，让人误以为它在。
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CaptureOverlay } from "./capture/CaptureOverlay";
// 样式表加载顺序（顺序即优先级，同选择器后者胜）：
//   tokens.css     值（颜色/字号/间距/圆角/层级/阴影）—— 唯一来源
//   dispatch.css   值台布局与专有组件
//   components.css 跨页面组件原语（按钮/卡片/表单/徽章/空态）
//   capture.css    截图窗（独立窗口，只借令牌）
// components.css 放在 dispatch.css 之后：原语是唯一真相，页面样式里的
// 旧类名定义（.sf-btn / .ghost-btn 等）不得再覆盖它们。
import "./styles/tokens.css";
import "./styles/dispatch.css";
import "./styles/components.css";
import "./styles/capture.css";

// 未捕获异常一律落盘：白屏时至少留下现场（写 <数据根>/logs/renderer.log）
const report = (payload: { kind: "error" | "rejection"; message: string; stack?: string; source?: string }) => {
  try {
    window.lynn?.logError?.(payload);
  } catch {
    /* 日志通道本身不可用时静默 */
  }
};
window.addEventListener("error", (e) => {
  report({ kind: "error", message: e.message || String(e.error ?? ""), stack: e.error instanceof Error ? e.error.stack : undefined, source: e.filename ? `${e.filename}:${e.lineno}` : undefined });
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  report({ kind: "rejection", message: r instanceof Error ? r.message : String(r), stack: r instanceof Error ? r.stack : undefined });
});

// 选区窗是同一份 index.html + 独立 query：只挂选区树，不加载指挥台状态与会话快照
const isCapture = new URLSearchParams(location.search).get("capture") === "1";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{isCapture ? <CaptureOverlay /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
