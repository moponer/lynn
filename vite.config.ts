import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * 构建号（2026-11-13 审计 #19）：优先 git 提交计数（同一仓库前后端必然一致且单调），
 * CI/打包环境没有 git 时回落到时间戳（退回旧行为）。时间戳取自构建机时钟，
 * 跨机器/时钟回拨会把"谁更旧"判错——git 计数才是单调可比的。
 */
function computeBuildId(): string {
  try {
    const n = execSync("git rev-list --count HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (/^\d+$/.test(n)) return `git-${n}`;
  } catch {
    /* 无 git（打包机/CI shallow 也算有效，count 是同一 commit 的一致值） */
  }
  return `t-${Date.now()}`;
}

// 渲染层构建：产物带相对路径，供 Electron 以 file:// 加载
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  // 构建号 + 时间戳：前端先用 buildId 判"内核是不是比我旧"，buildId 不可比时退回时间戳（见 App 的 app.info 握手）
  define: {
    __LYNN_BUILD_ID__: JSON.stringify(computeBuildId()),
    __LYNN_BUILD_AT__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    /**
     * 体积告警门槛（2026-11-16）：500 kB 的默认值对桌面端过严。
     * 当前超过它的只剩三个**按需加载**的第三方库整包，拆不开也拆不动（拆单个库没收益）：
     *   index-*.js（@js-preview/excel，xlsx 预览时才 import）约 1.65 MB
     *   pptx-preview.es（pptx 预览时才 import）约 1.22 MB
     *   avatars（12 款 DiceBear 插画数据）约 1.22 MB
     * 入口 chunk 已拆到 367 kB（React 单独成块），门槛设在 1700 kB 是为让**新增**的大块仍然报出来。
     */
    chunkSizeWarningLimit: 1700,
    rollupOptions: {
      output: {
        // DiceBear 的插画数据是几百 KB 的静态路径表，单独成块：
        // 主 bundle 不跟着膨胀，浏览器也能长期缓存这一块不常变的美术资源。
        manualChunks(id) {
          if (id.includes("node_modules/@dicebear/")) return "avatars";
          // Markdown / 语法高亮是一条独立的重活：单独成块，主聊天 bundle 不背它。
          if (/node_modules\/(react-markdown|remark-|rehype-|micromark|mdast|hast|unist|vfile|unified|highlight\.js|property-information|space-separated-tokens|comma-separated-tokens|zwitch|longest-streak|ccount|trim-lines|bail|is-plain-obj|trough|character-entities|decode-named-character-reference)/.test(id)) {
            return "rich-text";
          }
          // React 运行时单独成块（2026-11-16）：主 chunk 此前把 React 和全部界面代码打在一起，
          // 一改界面就得整块重下；拆开后 React 块只在升级 React 时变化。
          if (/node_modules\/(react|react-dom|scheduler|use-sync-external-store)\//.test(id)) return "react-vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      // 桌宠形象素材（短发 v3，assets/pet-dafeiyu）：静态 import 进前端 bundle，
      // 走 Vite 资源管线（file:// + 相对路径），不联网、不碰 CSP。
      "@pet": resolve(__dirname, "assets/pet-dafeiyu"),
    },
  },
});
