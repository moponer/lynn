/**
 * UI 插件卡槽契约（计划书 §4.2.4）—— 纯逻辑，主进程/渲染层/测试共用。
 *
 * 约束：
 *  - U 插件只能注册到**已声明卡槽**，不得直接操作宿主 DOM；
 *  - 第三方一律走 iframe sandbox（allow-scripts，不给 allow-same-origin），CSP 禁外联；
 *  - 卡槽名保持不变（M0 冻结承诺，§5）。
 */

export const UI_SLOTS = [
  "theme.tokens",
  "stage.view",
  "card.renderer",
  "avatar.driver",
  "sidebar.item",
  "settings.section",
  "status.bar",
  "composer.action",
] as const;

export type UiSlot = (typeof UI_SLOTS)[number];

export type UiPluginSource = "official" | "third-party";

export interface UiPluginManifest {
  /** 反向域名，与 plugin.json 的 id 同源 */
  id: string;
  name: string;
  version: string;
  slots: UiSlot[];
  source: UiPluginSource;
  /** 第三方必须为 true；官方受限组件可为 false */
  sandbox: boolean;
  /** 一句话说明（设置面板里展示） */
  description?: string;
}

export interface UiPluginCheck {
  ok: boolean;
  issues: string[];
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

export function checkUiPlugin(raw: unknown): UiPluginCheck {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, issues: ["manifest 必须是对象"] };
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== "string" || !ID_RE.test(m.id)) issues.push("id 必须是反向域名格式");
  if (typeof m.name !== "string" || !m.name.trim()) issues.push("name 必填");
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) issues.push("version 必须是语义化版本");

  if (!Array.isArray(m.slots) || m.slots.length === 0) {
    issues.push("slots 必须是非空数组");
  } else {
    for (const s of m.slots) {
      if (typeof s !== "string" || !(UI_SLOTS as readonly string[]).includes(s)) {
        issues.push(`"${String(s)}" 不是已声明的卡槽`);
      }
    }
  }

  if (m.source !== "official" && m.source !== "third-party") issues.push("source 必须是 official / third-party");
  if (typeof m.sandbox !== "boolean") issues.push("sandbox 必须是布尔");

  // 第三方必须沙箱：不允许在主 DOM 里跑任意组件
  if (m.source === "third-party" && m.sandbox !== true) {
    issues.push("第三方 UI 插件必须 sandbox=true（iframe，无 same-origin）");
  }

  return { ok: issues.length === 0, issues };
}

/** 某个卡槽上有哪些插件（保持声明顺序） */
export function pluginsForSlot(list: UiPluginManifest[], slot: UiSlot): UiPluginManifest[] {
  return list.filter((p) => p.slots.includes(slot));
}

/**
 * 内置 U 插件：**没有**。
 * 之前放过"用量读数 + 番茄钟"两个示例，但一个与顶栏 gauge 重复、一个点了只会往输入框塞字
 * （没有真实后端动作）——按"界面每一处都要有真值支撑"的规矩撤掉。卡槽契约与磁盘插件照常。
 */
export const BUILTIN_UI_PLUGINS: UiPluginManifest[] = [];

/** 本地启停状态（只存 id；插件本体由加载器管） */
export function enabledUiPlugins(all: UiPluginManifest[], disabledIds: string[]): UiPluginManifest[] {
  return all.filter((p) => !disabledIds.includes(p.id));
}
