// M2-12：多 provider 预设 + models.yaml + 模型发现（§4.4 L601–603）。
// 配置驱动：内置五家预设只是"推荐值"，增删厂商只动 ~/.lynn/models.yaml，不改主程序。
// 模型发现：OpenAI-compatible GET {baseUrl}/models（5s 超时，失败如实报错）。
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** 常用模型（推荐顺序） */
  models: string[];
  contextWindow: number;
  /** 计价提示（$/1M tokens，input/output），未知价如实写 null */
  pricing?: { input: number | null; output: number | null; note?: string };
}

/** 内置预设（§4.4：DeepSeek/GLM/Kimi/Qwen/MiniMax，均 OpenAI-compatible） */
export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    contextWindow: 128000,
    pricing: { input: null, output: null, note: "价格随峰谷浮动，以官网为准" },
  },
  {
    id: "glm",
    name: "GLM（智谱）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    contextWindow: 128000,
    pricing: { input: null, output: null, note: "以 open.bigmodel.cn 为准" },
  },
  {
    id: "kimi",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-32k", "moonshot-v1-128k", "kimi-latest"],
    contextWindow: 131072,
    pricing: { input: null, output: null, note: "以 platform.moonshot.cn 为准" },
  },
  {
    id: "qwen",
    name: "Qwen（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    contextWindow: 131072,
    pricing: { input: null, output: null, note: "以阿里云百炼为准" },
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    models: ["abab6.5s-chat", "MiniMax-Text-01"],
    contextWindow: 1000190,
    pricing: { input: null, output: null, note: "以 platform.minimaxi.com 为准" },
  },
];

// ---------- models.yaml（手写 YAML 子集：providers 列表的扁平键值） ----------

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  /** API Key 的凭据名（经内核凭据代理下发，文件里绝不落明文 Key） */
  apiKeyRef?: string;
  models: string[];
  contextWindow?: number;
}

/**
 * 解析 models.yaml 的子集形状：
 *   providers:
 *     - id: deepseek
 *       name: DeepSeek
 *       base_url: https://...
 *       models: [deepseek-chat, deepseek-reasoner]
 * 列表项用 "name: value" 行 + 可选 "name: [a, b]" 行内数组；足够本 schema 往返。
 */
export function parseModelsYaml(text: string): { providers: ProviderEntry[]; error?: string } {
  const lines = text.split(/\r?\n/);
  const providers: ProviderEntry[] = [];
  let cur: Partial<ProviderEntry> | null = null;
  let inProviders = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^providers:\s*$/.test(line.trim())) {
      inProviders = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inProviders = inProviders && false; // 顶层其他键：退出 providers 段
      continue;
    }
    if (!inProviders) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (cur) providers.push(cur as ProviderEntry);
      cur = {};
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(item[1]);
      if (kv) assignField(cur, kv[1], kv[2]);
      continue;
    }
    const kv = /^\s+(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv && cur) assignField(cur, kv[1], kv[2]);
  }
  if (cur) providers.push(cur as ProviderEntry);
  // 校验：缺 id/base_url 的条目如实报，不静默丢
  const bad = providers.filter((p) => !p.id || !p.baseUrl);
  if (bad.length) {
    return { providers: [], error: `models.yaml 有 ${bad.length} 个 provider 缺 id 或 base_url，整份不生效` };
  }
  return { providers };
}

function assignField(target: Partial<ProviderEntry>, key: string, rawVal: string): void {
  const val = rawVal.trim();
  const str = /^"(.*)"$/.exec(val)?.[1] ?? /^'(.*)'$/.exec(val)?.[1] ?? val;
  switch (key) {
    case "id":
      target.id = str;
      break;
    case "name":
      target.name = str;
      break;
    case "base_url":
      target.baseUrl = str;
      break;
    case "api_key_ref":
      target.apiKeyRef = str;
      break;
    case "context_window":
      target.contextWindow = Number(str) || undefined;
      break;
    case "models": {
      const m = /^\[(.*)\]$/.exec(str);
      target.models = m
        ? m[1].split(",").map((x) => x.trim()).filter(Boolean)
        : str
          ? [str]
          : [];
      break;
    }
    default:
      break; // 未知字段忽略（向前兼容）
  }
}

export function serializeModelsYaml(providers: ProviderEntry[]): string {
  const lines: string[] = ["providers:"];
  for (const p of providers) {
    lines.push(`  - id: ${p.id}`);
    if (p.name) lines.push(`    name: ${p.name}`);
    lines.push(`    base_url: ${p.baseUrl}`);
    if (p.apiKeyRef) lines.push(`    api_key_ref: ${p.apiKeyRef}`);
    lines.push(`    models: [${(p.models ?? []).join(", ")}]`);
    if (p.contextWindow) lines.push(`    context_window: ${p.contextWindow}`);
  }
  return lines.join("\n") + "\n";
}

export function loadProviders(dataRoot: string): { providers: ProviderEntry[]; error?: string } {
  const file = path.join(dataRoot, "models.yaml");
  if (!fs.existsSync(file)) return { providers: [] };
  try {
    return parseModelsYaml(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return { providers: [], error: `models.yaml 读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function saveProviders(dataRoot: string, providers: ProviderEntry[]): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "models.yaml"), serializeModelsYaml(providers), "utf-8");
}

// ---------- 模型发现（OpenAI-compatible /models） ----------

export async function discoverModels(baseUrl: string, apiKey?: string, timeoutMs = 5000): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return { models: [], error: `模型发现失败：HTTP ${res.status}` };
    const j = (await res.json()) as { data?: { id?: string }[] };
    const ids = (j?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string");
    return { models: ids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { models: [], error: msg.includes("abort") ? `模型发现超时（${timeoutMs}ms）` : `模型发现失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
