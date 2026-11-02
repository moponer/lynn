/** 三套主题（规范 §3.1）。语义不换色：结构 / 等你拍板 / 打回 / 预算各一色。 */

export const THEMES = [
  {
    id: "night",
    name: "夜航",
    hint: "深墨制图室 · 默认",
    dark: { desk: "#0d1116", blue: "#5ea9c9", seal: "#c8443a", brass: "#c9a227" },
    light: { desk: "#e8e4d9", blue: "#2f6f8a", seal: "#a8402f", brass: "#8a6f1e" },
  },
  {
    id: "paper",
    name: "纸墨",
    hint: "宣纸底 · 久看不累",
    dark: { desk: "#15120e", blue: "#c9a227", seal: "#c8443a", brass: "#c9a227" },
    light: { desk: "#f2ece0", blue: "#8a6f1e", seal: "#a8402f", brass: "#9a7a2a" },
  },
  {
    id: "celadon",
    name: "青瓦",
    hint: "墨绿安静 · 陪伴感",
    dark: { desk: "#101a1a", blue: "#79c2a4", seal: "#c8443a", brass: "#c9a227" },
    light: { desk: "#e9e6da", blue: "#3f6b7a", seal: "#a8402f", brass: "#8a6f1e" },
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeMode = "dark" | "light";

const KEY_THEME = "lynn.theme";
const KEY_MODE = "lynn.mode";

export function loadTheme(): { id: ThemeId; mode: ThemeMode } {
  const id = (localStorage.getItem(KEY_THEME) ?? "night") as ThemeId;
  const mode = (localStorage.getItem(KEY_MODE) ?? "dark") as ThemeMode;
  const okId = THEMES.some((t) => t.id === id) ? id : "night";
  return { id: okId, mode: mode === "light" ? "light" : "dark" };
}

/** 写到 <html data-theme data-mode>，CSS 里按这两层选择器换 Token */
export function applyTheme(id: ThemeId, mode: ThemeMode): void {
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.mode = mode;
  localStorage.setItem(KEY_THEME, id);
  localStorage.setItem(KEY_MODE, mode);
}

/**
 * 主题插件（L0）的 Token 覆盖：只写内联 CSS 变量，不加载任何脚本。
 * 传 undefined 即清空，回到当前主题。
 */
const pluginVars = new Set<string>();

export function applyPluginTokens(tokens?: Record<string, string>): void {
  for (const k of pluginVars) document.documentElement.style.removeProperty(k);
  pluginVars.clear();
  if (!tokens) return;
  for (const [k, v] of Object.entries(tokens)) {
    if (!k.startsWith("--")) continue;
    document.documentElement.style.setProperty(k, v);
    pluginVars.add(k);
  }
}
