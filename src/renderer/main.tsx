import React from "react";
import { createRoot } from "react-dom/client";
// 字体随包（离线、零网络请求）：Archivo 只是拉丁标题字，等宽字承担审计线索（规范 §3.3）
import "@fontsource-variable/archivo/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import App from "./App";
import "./styles/dispatch.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
