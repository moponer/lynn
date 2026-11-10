import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 设置与数据根（§4.7）：一切落 `~/.lynn/`（可用 LYNN_HOME 覆盖，单测用）。
 * API Key 用 Electron safeStorage 加密落盘；不可用时降级明文并打标——
 * 文件在用户本机，但绝不把 Key 明文发给渲染层（§4.2.7 凭据代理红线）。
 */

export interface StoredModelConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: { encrypted: boolean; data: string };
  updatedAt: string;
}

/** 模型库里的一条（可编辑 / 删除 / 设为默认 / 指定给某个对话） */
export interface StoredModelEntry extends StoredModelConfig {
  id: string;
  label: string;
}

export interface Prefs {
  /** 任务契约默认自动开始（关闭时每次动手前都要用户点"开始"） */
  autoStart: boolean;
  /** 关窗进托盘而不是退出（M1-18） */
  trayOnClose: boolean;
  /** 窗口隐藏时用系统通知触达（M1-18） */
  notify: boolean;
  /** 会话软预算（token）：达到后提示并可切备用模型；0 = 未设预算（M2-11） */
  softBudgetTokens: number;
  /** 软上限触达后的备用模型（留空 = 只提示不切换，不静默停机） */
  fallbackModel: string;
  /** 界面语言（M3-08）：zh 是源语言；en 缺词条回退中文 */
  lang: "zh" | "en";
  /** 同时最多几个成员在跑（默认 4）：三个任务并行是常态，2 会把第三张单直接拒掉 */
  maxParallelMembers: number;
  /** 指挥者巡检（默认开）：成员长时间没动静或被边界反复拦下时，让风铃自己跟进一步 */
  supervisor: boolean;
  /** 心跳巡检（默认开）：机械层聚合待审查/停滞工单/定时任务异常，有事才起一轮由风铃自主处置 */
  heartbeat: boolean;
  /** 停用的技能名（M2-10）：停用后不参与 matchSkills 激活，也不会进 allowed-tools 强制 */
  disabledSkills: string[];
  /** 心跳最小间隔（分钟，默认 5）：同一批事实 30 分钟内不重复注入，token 消耗有事才有 */
  heartbeatMinutes: number;
  /** 区域截图的全局快捷键（Electron Accelerator，如 Alt+Shift+S）；被占用可在设置里改 */
  captureHotkey: string;
  /** 默认工作区（2026-11-10）：新会话/无会话发消息的落点；空 = 按平台默认解析 */
  defaultWorkspace: string;
  /** 常用只读根：跨会话长期授权（按单授权仍走 TaskRecord.readRoots） */
  knownReadRoots: string[];
  /** 清理 TTL（天）：只作用于过程文件，交付物与证据永久（2026-11-10 P2-1） */
  retention: { scratchDays: number; checkpointDays: number; logDays: number };
}

const DEFAULT_PREFS: Prefs = {
  autoStart: false,
  trayOnClose: true,
  notify: true,
  softBudgetTokens: 0,
  fallbackModel: "",
  lang: "zh",
  maxParallelMembers: 4,
  supervisor: true,
  heartbeat: true,
  heartbeatMinutes: 5,
  disabledSkills: [],
  captureHotkey: "Alt+Shift+S",
  defaultWorkspace: "",
  knownReadRoots: [],
  retention: { scratchDays: 14, checkpointDays: 7, logDays: 7 },
};

interface SettingsFile {
  /** 旧字段：单条全局配置。保留为「当前默认模型」的镜像，兼容 v1 配置与直连降级路径 */
  model?: StoredModelConfig;
  /** 模型库：多条配置，每条独立加密 Key */
  models?: StoredModelEntry[];
  /** 新对话默认用哪条；空 = 取模型库第一条 */
  defaultModelId?: string;
  /** 视觉/OCR 模型（M2-13）：与对话模型解耦，可独立配置 */
  vision?: StoredModelConfig;
  prefs?: Partial<Prefs>;
}

export function defaultDataRoot(): string {
  return process.env.LYNN_HOME || path.join(os.homedir(), ".lynn");
}

export class SettingsStore {
  constructor(
    readonly dataRoot: string,
    /** safeStorage 的两个函数由 main.ts 注入（便于单测替换） */
    private readonly encrypt: (plain: string) => Buffer,
    private readonly isEncryptionAvailable: () => boolean,
  ) {}

  private get file(): string {
    return path.join(this.dataRoot, "settings.json");
  }

  private read(): SettingsFile {
    if (!fs.existsSync(this.file)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf-8")) as SettingsFile;
    } catch {
      return {};
    }
  }

  private write(s: SettingsFile): void {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2), "utf-8");
  }

  /** 视觉/OCR 模型（M2-13）：独立配置，与对话模型解耦；未配置返回 null（调用方如实降级） */
  getVisionModel(): StoredModelConfig | null {
    return this.read().vision ?? null;
  }

  getPrefs(): Prefs {
    return { ...DEFAULT_PREFS, ...(this.read().prefs ?? {}) };
  }

  savePrefs(patch: Partial<Prefs>): Prefs {
    const s = this.read();
    s.prefs = { ...this.getPrefs(), ...patch };
    this.write(s);
    return s.prefs as Prefs;
  }

  /**
   * 老版本只有单条 `model`：第一次访问时收编成模型库第一条，绝不丢配置也不重复。
   * 只在内存里规整，写盘由调用方决定；重复读是幂等的。
   */
  private normalize(s: SettingsFile): SettingsFile {
    const next: SettingsFile = { ...s, models: Array.isArray(s.models) ? [...s.models] : [] };
    if (next.model && next.models!.length === 0) {
      next.models!.push({
        ...next.model,
        id: "m-legacy",
        label: `${next.model.provider || "模型"} · ${next.model.model}`,
      });
      next.defaultModelId = "m-legacy";
    }
    if (!next.defaultModelId || !next.models!.some((e) => e.id === next.defaultModelId)) {
      next.defaultModelId = next.models![0]?.id;
    }
    return next;
  }

  /** 模型库（渲染层只拿脱敏视图，Key 永不下发） */
  getModels(): StoredModelEntry[] {
    return this.normalize(this.read()).models!;
  }

  getDefaultModelId(): string | null {
    return this.normalize(this.read()).defaultModelId ?? null;
  }

  /** 取一条配置：传 id 就精确取（找不到返回 null，绝不回退到别的模型的 Key）；不传取当前默认 */
  getModel(id?: string): StoredModelConfig | null {
    const s = this.normalize(this.read());
    const entry = id
      ? s.models!.find((e) => e.id === id)
      : s.models!.find((e) => e.id === s.defaultModelId) ?? s.models![0];
    // 指定 id 找不到就明确失败：绝不能静默用别的模型（尤其别的 Key）顶上
    if (id) return entry ? asConfig(entry) : null;
    return entry ? asConfig(entry) : s.model ?? null;
  }

  /** 新增 / 编辑一条（同一条纪律：换端点必须重填 Key） */
  upsertModel(input: {
    id?: string;
    label?: string;
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): StoredModelEntry {
    const s = this.normalize(this.read());
    const entries = s.models!;
    const id = input.id?.trim() || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const idx = entries.findIndex((e) => e.id === id);
    const previous = idx >= 0 ? entries[idx] : null;
    const cfg = this.buildConfig(input, previous);
    const entry: StoredModelEntry = {
      ...cfg,
      id,
      label: (input.label?.trim() || previous?.label || cfg.provider || cfg.model || "未命名模型").slice(0, 40),
    };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    s.models = entries;
    if (!s.defaultModelId || entries.length === 1) s.defaultModelId = id;
    if (s.defaultModelId === id) s.model = asConfig(entry); // 旧字段镜像，兼容直连降级路径
    this.write(s);
    return entry;
  }

  removeModel(id: string): { ok: boolean; error?: string; defaultModelId: string | null } {
    const s = this.normalize(this.read());
    if (!s.models!.some((e) => e.id === id)) return { ok: false, error: "模型不存在或已被删除", defaultModelId: s.defaultModelId ?? null };
    s.models = s.models!.filter((e) => e.id !== id);
    if (s.defaultModelId === id) s.defaultModelId = s.models[0]?.id;
    const def = s.models.find((e) => e.id === s.defaultModelId) ?? s.models[0];
    if (def) s.model = asConfig(def);
    else delete s.model;
    this.write(s);
    return { ok: true, defaultModelId: s.defaultModelId ?? null };
  }

  setDefaultModel(id: string): StoredModelEntry {
    const s = this.normalize(this.read());
    const entry = s.models!.find((e) => e.id === id);
    if (!entry) throw new Error("模型不存在");
    s.defaultModelId = id;
    s.model = asConfig(entry);
    this.write(s);
    return entry;
  }

  /** 清除 Key（保留端点与模型，界面上的"清除 Key"按钮用）：默认条目与镜像一起清 */
  clearApiKey(): boolean {
    const s = this.normalize(this.read());
    const def = s.models!.find((e) => e.id === s.defaultModelId) ?? s.models![0];
    if (!def?.apiKey?.data && !s.model?.apiKey?.data) return false;
    const blank = { encrypted: false, data: "" } as const;
    if (def) def.apiKey = { ...blank };
    if (s.model) s.model = { ...s.model, apiKey: { ...blank }, updatedAt: new Date().toISOString() };
    this.write(s);
    return true;
  }

  /** 清除视觉模型配置（M2-13：解耦后可单独撤下） */
  clearVision(): boolean {
    const s = this.read();
    if (!s.vision) return false;
    delete s.vision;
    this.write(s);
    return true;
  }

  /** 保存视觉/OCR 模型（M2-13）：与对话模型同一套加密纪律 */
  saveVisionModel(input: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    previous?: StoredModelConfig | null;
  }): StoredModelConfig {
    const cfg = this.buildConfig(input, input.previous ?? null);
    const s = this.read();
    s.vision = cfg;
    this.write(s);
    return cfg;
  }

  private buildConfig(
    input: { provider: string; baseUrl: string; model: string; apiKey?: string },
    previous: StoredModelConfig | null,
  ): StoredModelConfig {
    let apiKey: StoredModelConfig["apiKey"];
    const hasNewKey = input.apiKey !== undefined && input.apiKey !== "";
    if (hasNewKey) {
      const canEncrypt = this.isEncryptionAvailable();
      apiKey = canEncrypt
        ? { encrypted: true, data: this.encrypt(input.apiKey!).toString("base64") }
        : { encrypted: false, data: input.apiKey! };
    } else if (previous?.apiKey) {
      // 换端点还留空 = 把上一家服务商的 Key 发到新端点，端点只会回 401 Invalid token。
      const nextUrl = String(input.baseUrl ?? "").replace(/\/+$/, "");
      const prevUrl = String(previous.baseUrl ?? "").replace(/\/+$/, "");
      if (nextUrl && prevUrl && nextUrl !== prevUrl) {
        throw new Error("换了 Base URL，必须重新填写这个端点的 API Key（旧 Key 不会带到新服务商）。");
      }
      apiKey = previous.apiKey; // 同一端点内留空 = 沿用旧 Key
    } else {
      throw new Error("首次配置必须填写 API Key");
    }
    return {
      provider: input.provider || previous?.provider || "OpenAI 兼容",
      baseUrl: String(input.baseUrl ?? "").replace(/\/+$/, ""),
      model: input.model,
      apiKey,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 旧入口 config.save：覆盖写「当前默认」那条，保留向导 / 旧测试的行为 */
  saveModel(input: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    previous?: StoredModelConfig | null;
  }): StoredModelConfig {
    const s = this.normalize(this.read());
    const def = s.models!.find((e) => e.id === s.defaultModelId);
    return asConfig(this.upsertModel({ ...input, id: def?.id, label: def?.label }));
  }
}

function asConfig(e: StoredModelEntry | StoredModelConfig): StoredModelConfig {
  return { provider: e.provider, baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey, updatedAt: e.updatedAt };
}

/** 读回明文 Key（只供主进程发请求用）；modelId 指定时只取那一条 */
export function loadApiKey(
  store: SettingsStore,
  decrypt: (blob: Buffer) => string,
  modelId?: string,
): string | null {
  const m = store.getModel(modelId);
  if (!m) return null;
  try {
    return m.apiKey.encrypted ? decrypt(Buffer.from(m.apiKey.data, "base64")) : m.apiKey.data;
  } catch {
    return null;
  }
}
