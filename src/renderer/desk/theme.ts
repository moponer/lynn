/** 主题（规范 §3.1）。语义不换色：结构 / 等你拍板 / 打回 / 预算各一色。
 *
 *  只留一张皮：暗色=深墨底（正文与背景同色，不再是一块更浅的面板），
 *  亮色=Notion 结构（白纸面 + 极浅灰侧栏 + 发丝线）。
 *  青瓷绿只做小面积强调（结构/选中），不再给整块面染色。
 *
 *  `desk` 是窗口底色（首帧由壳先涂，避免白闪），`sheet` 是正文纸面；
 *  暗色下两者同值——这正是"输出文本块没有独立背景"的实现方式。
 */
export const THEMES = [
  {
    id: "celadon",
    name: "青瓦",
    hint: "深墨底 · 青瓷强调",
    dark: { desk: "#0a0d0f", sheet: "#0a0d0f", blue: "#6fa892", seal: "#c8443a", brass: "#c9a227" },
    light: { desk: "#f7f7f5", sheet: "#ffffff", blue: "#3e6f5b", seal: "#b0402f", brass: "#8a6f1e" },
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeMode = "dark" | "light";

const KEY_THEME = "lynn.theme";
const KEY_MODE = "lynn.mode";

/**
 * 旧数据/旧 .lynnpack 里的 night、paper 已下线：
 * 一律归一到现存的唯一主题，而不是留下一个没有 CSS 的 data-theme。
 */
export function normalizeThemeId(id: unknown): ThemeId {
  return THEMES.some((t) => t.id === id) ? (id as ThemeId) : "celadon";
}

export function loadTheme(): { id: ThemeId; mode: ThemeMode } {
  const id = normalizeThemeId(localStorage.getItem(KEY_THEME));
  const mode = (localStorage.getItem(KEY_MODE) ?? "dark") as ThemeMode;
  return { id, mode: mode === "light" ? "light" : "dark" };
}

/** 写到 <html data-theme data-mode>，CSS 里按这两层选择器换 Token */
export function applyTheme(rawId: ThemeId, mode: ThemeMode): void {
  // 写进来的可能是旧主题 id（皮肤/打包文件），先归一
  const id = normalizeThemeId(rawId);
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const m: ThemeMode = mode === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.mode = m;
  localStorage.setItem(KEY_THEME, id);
  localStorage.setItem(KEY_MODE, m);
  // 把底色交给壳：下次冷启动首帧就用它，不闪白也不闪错色
  void window.lynn.rpc("app.appearance", { mode: m, desk: theme[m].desk }).catch(() => undefined);
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

/**
 * 主题插件（L0）的形态层：注入单个 <style>，并给 <html> 打 `data-theme-plugin="<id>"`。
 *
 * 为什么必须有这个属性：`applyTheme` 写的 `data-theme` 永远停在基础主题（celadon）上，
 * 插件拿不到自己的 id 做作用域——所以形态 CSS 只能用
 * `html[data-theme-plugin="<插件 id>"] .cls{…}`，不能写 `html[data-theme="…"]`。
 *
 * 传 `null` 即卸载。CSS 原文来自 `plugins.list`（主进程已过 checkPluginCss），
 * 这里只当样式文本用，不做任何求值。
 */
const STYLE_EL_ID = "lynn-plugin-style";

export function applyPluginStyle(id: string | null, css?: string): void {
  const root = document.documentElement;
  document.getElementById(STYLE_EL_ID)?.remove();
  if (!id || !css) {
    delete root.dataset.themePlugin;
    return;
  }
  root.dataset.themePlugin = id;
  const el = document.createElement("style");
  el.id = STYLE_EL_ID;
  el.dataset.plugin = id;
  el.textContent = css;
  document.head.appendChild(el);
}
