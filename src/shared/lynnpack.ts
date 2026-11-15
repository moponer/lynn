/**
 * `.lynnpack` 配置包（计划书 §2.2 / §4.9 分享边界）—— 纯逻辑，主进程与渲染层共用。
 *
 * 硬规则：**只含配置** —— 插件清单、主题、模型端点、能力选择、可选岗位模板。
 * **永不含** 记忆、会话、凭据、任何本地文件。导出与导入两侧都按这条校验。
 */

export type PackThemeId = "night" | "paper" | "celadon";
export type PackThemeMode = "dark" | "light";

export const THEME_NAMES: Record<PackThemeId, string> = {
  night: "夜航",
  paper: "纸墨",
  celadon: "青瓦",
};

export interface LynnPack {
  kind: "lynnpack";
  version: 1;
  createdAt: string;
  theme: { id: PackThemeId; mode: PackThemeMode };
  avatar: boolean;
  model?: { provider: string; baseUrl: string; model: string };
  capabilities: string[];
  /** 岗位模板：只写岗位说明，不含战绩与运行记录 */
  teamTemplate?: { name: string; roles: { name: string; role: string; goal: string; tools: string[] }[] };
}

/** 出现这些键就说明包里混进了不该分享的东西 —— 直接拒收 */
const FORBIDDEN_KEYS = [
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "credential",
  "memory",
  "session",
  "timeline",
  "messages",
];

export interface PackCheck {
  ok: boolean;
  pack?: LynnPack;
  issues: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function checkPack(rawText: string): PackCheck {
  const issues: string[] = [];
  const lower = rawText.toLowerCase();
  for (const k of FORBIDDEN_KEYS) {
    if (lower.includes(`"${k}"`)) issues.push(`包里出现禁止字段 "${k}" —— .lynnpack 只能带配置`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { ok: false, issues: ["不是合法 JSON"] };
  }
  if (!isObj(raw)) return { ok: false, issues: ["顶层必须是对象"] };
  if (raw.kind !== "lynnpack") issues.push("kind 必须是 lynnpack");
  if (raw.version !== 1) issues.push("version 必须是 1");
  if (typeof raw.createdAt !== "string" || !raw.createdAt.trim() || Number.isNaN(Date.parse(raw.createdAt))) {
    issues.push("createdAt 必须是有效时间字符串");
  }

  const theme = raw.theme;
  if (!isObj(theme) || typeof theme.id !== "string" || !(theme.id in THEME_NAMES)) {
    issues.push("theme.id 必须是 night / paper / celadon 之一");
  }
  if (!isObj(theme) || (theme.mode !== "dark" && theme.mode !== "light")) issues.push("theme.mode 必须是 dark / light");

  if (typeof raw.avatar !== "boolean") issues.push("avatar 必须是布尔");

  if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== "string")) {
    issues.push("capabilities 必须是字符串数组");
  }

  if (raw.model !== undefined) {
    const m = raw.model;
    if (!isObj(m) || typeof m.provider !== "string" || typeof m.baseUrl !== "string" || typeof m.model !== "string") {
      issues.push("model 至少要有 provider / baseUrl / model 三个字符串");
    }
  }

  if (raw.teamTemplate !== undefined) {
    const team = raw.teamTemplate;
    if (!isObj(team) || typeof team.name !== "string" || !Array.isArray(team.roles)) {
      issues.push("teamTemplate 至少要有 name 字符串与 roles 数组");
    } else {
      team.roles.forEach((role, index) => {
        if (!isObj(role) || typeof role.name !== "string" || typeof role.role !== "string" || typeof role.goal !== "string") {
          issues.push(`teamTemplate.roles[${index}] 至少要有 name / role / goal 三个字符串`);
        }
        if (!isObj(role) || !Array.isArray(role.tools) || role.tools.some((tool) => typeof tool !== "string")) {
          issues.push(`teamTemplate.roles[${index}].tools 必须是字符串数组`);
        }
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], pack: raw as unknown as LynnPack };
}

export function buildPack(input: {
  theme: { id: PackThemeId; mode: PackThemeMode };
  avatar: boolean;
  model?: { provider: string; baseUrl: string; model: string };
  capabilities: string[];
  roles?: { name: string; role: string; goal: string; tools: string[] }[];
  teamName?: string;
}): LynnPack {
  return {
    kind: "lynnpack",
    version: 1,
    createdAt: new Date().toISOString(),
    theme: input.theme,
    avatar: input.avatar,
    model: input.model,
    capabilities: input.capabilities,
    teamTemplate:
      input.roles && input.roles.length
        ? { name: input.teamName ?? "我的班底", roles: input.roles }
        : undefined,
  };
}

/** 导入前的人话摘要：逐项告诉你"将要应用什么" */
export function describePack(pack: LynnPack): string[] {
  const themeName = THEME_NAMES[pack.theme.id] ?? pack.theme.id;
  const lines = [
    `主题：${themeName} · ${pack.theme.mode === "dark" ? "暗色" : "亮色"}`,
    `形象：${pack.avatar ? "启用" : "关闭"}`,
    `能力：${pack.capabilities.length ? pack.capabilities.join("、") : "无"}`,
  ];
  if (pack.model) lines.push(`模型端点：${pack.model.provider} · ${pack.model.baseUrl} · ${pack.model.model}（不含 Key）`);
  if (pack.teamTemplate) {
    lines.push(`岗位模板：${pack.teamTemplate.name} · ${pack.teamTemplate.roles.length} 个岗位（只含说明，不含战绩）`);
  }
  return lines;
}
