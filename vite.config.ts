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
    rollupOptions: {
      output: {
        // DiceBear 的插画数据是几百 KB 的静态路径表，单独成块：
        // 主 bundle 不跟着膨胀，浏览器也能长期缓存这一块不常变的美术资源。
        manualChunks(id) {
          if (id.includes("node_modules/@dicebear/")) return "avatars";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
