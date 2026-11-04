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
};

interface SettingsFile {
  model?: StoredModelConfig;
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

  getModel(): StoredModelConfig | null {
    return this.read().model ?? null;
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

  /** 清除 Key（保留端点与模型，界面上的"清除 Key"按钮用） */
  clearApiKey(): boolean {
    const s = this.read();
    if (!s.model?.apiKey?.data) return false;
    s.model = { ...s.model, apiKey: { encrypted: false, data: "" }, updatedAt: new Date().toISOString() };
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

  /** 保存视觉/OCR 模型（M2-13）：与 saveModel 同一套加密纪律 */
  saveVisionModel(input: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    previous?: StoredModelConfig | null;
  }): StoredModelConfig {
    return this.saveTarget("vision", input);
  }

  private saveTarget(
    target: "model" | "vision",
    input: { provider: string; baseUrl: string; model: string; apiKey?: string; previous?: StoredModelConfig | null },
  ): StoredModelConfig {
    let apiKey: StoredModelConfig["apiKey"];
    if (input.apiKey !== undefined && input.apiKey !== "") {
      const canEncrypt = this.isEncryptionAvailable();
      apiKey = canEncrypt
        ? { encrypted: true, data: this.encrypt(input.apiKey).toString("base64") }
        : { encrypted: false, data: input.apiKey };
    } else if (input.previous?.apiKey) {
      apiKey = input.previous.apiKey; // 未填 = 沿用旧 Key
    } else {
      throw new Error("首次配置必须填写 API Key");
    }
    const cfg: StoredModelConfig = {
      provider: input.provider || input.previous?.provider || "OpenAI 兼容",
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      model: input.model,
      apiKey,
      updatedAt: new Date().toISOString(),
    };
    const s = this.read();
    s[target] = cfg;
    this.write(s);
    return cfg;
  }

  saveModel(input: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    previous?: StoredModelConfig | null;
  }): StoredModelConfig {
    let apiKey: StoredModelConfig["apiKey"];
    if (input.apiKey !== undefined && input.apiKey !== "") {
      const canEncrypt = this.isEncryptionAvailable();
      apiKey = canEncrypt
        ? { encrypted: true, data: this.encrypt(input.apiKey).toString("base64") }
        : { encrypted: false, data: input.apiKey };
    } else if (input.previous?.apiKey) {
      apiKey = input.previous.apiKey; // 未填 = 沿用旧 Key
    } else {
      throw new Error("首次配置必须填写 API Key");
    }
    const cfg: StoredModelConfig = {
      provider: input.provider || input.previous?.provider || "OpenAI 兼容",
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      model: input.model,
      apiKey,
      updatedAt: new Date().toISOString(),
    };
    const s = this.read();
    s.model = cfg;
    this.write(s);
    return cfg;
  }
}

/** 读回明文 Key（只供主进程发请求用） */
export function loadApiKey(
  store: SettingsStore,
  decrypt: (blob: Buffer) => string,
): string | null {
  const m = store.getModel();
  if (!m) return null;
  try {
    return m.apiKey.encrypted ? decrypt(Buffer.from(m.apiKey.data, "base64")) : m.apiKey.data;
  } catch {
    return null;
  }
}
