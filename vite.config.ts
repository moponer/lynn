import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 渲染层构建：产物带相对路径，供 Electron 以 file:// 加载
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  // 构建时间戳：前端据此判断"内核是不是比我旧"（见 App 的 app.info 握手）
  define: { __LYNN_BUILD_AT__: JSON.stringify(new Date().toISOString()) },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
