import React from "react";
import { createRoot } from "react-dom/client";
// 字体随包（离线、零网络请求）：Archivo 只是拉丁标题字，等宽字承担审计线索（规范 §3.3）
import "@fontsource-variable/archivo/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/dispatch.css";

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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
