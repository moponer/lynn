import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LogPrefs } from "./log-policy";
import type { CommandFamily } from "../shared/contract";
import { VOICE_DEFAULT_PREFS } from "./voice-policy";

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
  /** 风险确认时间：本机/局域网网关或非 HTTPS 端点首次保存时由用户勾选 */
  riskAcceptedAt?: string;
}

export interface Prefs {
  /** 任务契约默认自动开始（默认开；关掉时每次动手前都要用户点"开始"） */
  autoStart: boolean;
  /** 2026-11-11 一次性迁移标记：升级后默认自主，之后尊重用户在设置里的显式选择 */
  autonomyMigrated?: boolean;
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
  /**
   * 风铃自己一轮对话里最多跑几个工具轮次（默认 24）：审查→派单→激活技能→验收→汇报
   * 一条龙轻松超过 8 轮，旧值 8 会把她中途掐断；给足后极少触顶，且触顶也只总结不硬停。
   */
  maxAgentRounds: number;
  /** 指挥者巡检（默认开）：成员长时间没动静或被边界反复拦下时，让风铃自己跟进一步 */
  supervisor: boolean;
  /** 心跳巡检（默认开）：机械层聚合待审查/停滞工单/定时任务异常，有事才起一轮由风铃自主处置 */
  heartbeat: boolean;
  /**
   * 去 AI 味（2026-11-15）：加载外部插件 humanizer-stream，把模型文本在展示前过滤一遍。
   * 只影响界面与写盘文本，**不改提示词、不改上下文、不额外消耗 token**。
   * 插件没装时这个开关无效（如实显示"未安装"，不假装有效果）。
   */
  humanizer?: boolean;
  /** 停用的技能名（M2-10）：停用后不参与 matchSkills 激活，也不会进 allowed-tools 强制 */
  disabledSkills: string[];
  /** 心跳最小间隔（分钟，默认 5）：同一批事实 30 分钟内不重复注入，token 消耗有事才有 */
  heartbeatMinutes: number;
  /** 秒级探针间隔（ms；0 = 关掉探针，只保留事件驱动与分钟级巡检） */
  heartbeatProbeMs?: number;
  /** 事件驱动唤醒的最小合并间隔（ms）：同一波事件只叫醒一次 */
  heartbeatWakeMinMs?: number;
  /** 事件驱动唤醒的每小时配额：防异常刷屏打穿预算 */
  heartbeatWakePerHour?: number;
  /**
   * 日志分类与限流（2026-11-11）：`enabled: false` 一条都不写；
   * `categories.member/tool/task/heartbeat/system` 可单独关；`perMinute` 控频。
   * 缺省：heartbeat 关，其余开（tool 每分钟 120 条，单条字段截断 400 字符）。
   */
  log?: LogPrefs;
  /** 区域截图的全局快捷键（Electron Accelerator，如 Alt+Shift+S）；被占用可在设置里改 */
  captureHotkey: string;
  /** 默认工作区（2026-11-10）：新会话/无会话发消息的落点；空 = 按平台默认解析 */
  defaultWorkspace: string;
  /** 常用只读根：跨会话长期授权（按单授权仍走 TaskRecord.readRoots） */
  knownReadRoots: string[];
  /** 清理 TTL（天）：只作用于过程文件，交付物与证据永久（2026-11-10 P2-1） */
  retention: { scratchDays: number; checkpointDays: number; logDays: number };
  /** 语音播报（2026-11-13）：默认只念汇报与进度节点，人不在不念；文本会送微软在线语音服务 */
  voiceEnabled: boolean;
  voiceId: string;
  voiceRate: string;
  voiceVolume: string;
  voiceScope: "brief" | "detail";
  voiceMaxChars: number;
  voiceWhenHidden: boolean;
  voiceProxy: string;
  /**
   * 顾问（2026-11-14）：成员交回报后，用另一个模型独立审一遍"这份交付会不会返工"。
   * 每单只审一次、不给工具、不改状态；关掉就完全不调用。
   */
  advisorEnabled: boolean;
  /**
   * 角色模型（2026-11-14）：值是模型库条目 id，缺省回落当前默认模型。
   * 目前只有 advisor 在用；worker/smol/tiny 是给「便宜模型干粗活」留的位置。
   */
  modelRoles?: Partial<Record<"worker" | "smol" | "advisor" | "tiny", string>>;
  /**
   * 已放行的删除命令族（2026-11-14）：用户在审批卡上点过"这类以后都允许"的族。
   * 只影响"要不要弹卡"，不改变路径守卫——工作区外的删除仍然直接拒。
   */
  allowCommandFamilies?: CommandFamily[];
}

const DEFAULT_PREFS: Prefs = {
  // 2026-11-11 默认自主：用户只提需求，契约直接开工；要逐步确认可在设置里关掉
  autoStart: true,
  trayOnClose: true,
  notify: true,
  softBudgetTokens: 0,
  fallbackModel: "",
  lang: "zh",
  maxParallelMembers: 4,
  /** 风铃单轮工具轮次上限（默认 24，给足避免中途被掐断；触顶也只总结不硬停） */
  maxAgentRounds: 24,
  supervisor: true,
  heartbeat: true,
  heartbeatMinutes: 5,
  humanizer: true,
  // 秒级心跳（2026-11-11）：探针只读内存态，唤醒仍受合并窗口与每小时配额约束
  heartbeatProbeMs: 1000,
  heartbeatWakeMinMs: 20_000,
  heartbeatWakePerHour: 12,
  disabledSkills: [],
  captureHotkey: "Alt+Shift+S",
  defaultWorkspace: "",
  knownReadRoots: [],
  retention: { scratchDays: 14, checkpointDays: 7, logDays: 7 },
  advisorEnabled: true,
  ...VOICE_DEFAULT_PREFS,
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
  /**
   * IM 渠道（2026-11-18 P14-1）。
   *
   * 存的是**渠道配置**，不是凭据明文——appSecret 走加密路径后存，
   * 与模型 Key 同一套（`setEncryptors` 注入的 safeStorage）。
   */
  im?: {
    /** 是否启用本地 IM 端点（默认 false：联网能力必须显式开） */
    bridgeEnabled?: boolean;
    feishu?: {
      appId: string;
      /** 加密后的 appSecret（与 model.apiKey 同形） */
      appSecret: { encrypted: boolean; data: string };
      /** 允许驱动 Agent 的用户 open_id 白名单（空 = 拒绝所有人） */
      allowOpenIds: string[];
      allowGroup?: boolean;
      enabled?: boolean;
      /**
       * 见过的发送者（P18-2）：渠道收到消息时自动记录，最多留 10 条。
       *
       * 为什么需要：用户不知道自己的 open_id，而
       * `GET /im/v1/chats` **只返回群不返回私聊**，API 查不到"只私聊过"的情形。
       * 这里把实际收到的发送者记下来，设置页直接列出候选。
       *
       * 只存 open_id 与会话 id，**不存消息内容**。
       */
      seenSenders?: { openId: string; chatType: string; chatId: string; at: string }[];
    };
  };
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
  ) {
    this.migrateAutonomy();
  }

  /**
   * 2026-11-11：默认自主。历史上 autoStart 默认 false，每张单都要用户点「开始」，
   * 与「用户只提需求、只要结果」冲突。升级时迁移一次并把标记写盘；
   * 之后用户在设置里显式关掉会保留 autonomyMigrated，不再被覆盖。
   */
  private migrateAutonomy(): void {
    try {
      const s = this.read();
      if (s.prefs?.autonomyMigrated) return;
      s.prefs = { ...DEFAULT_PREFS, ...(s.prefs ?? {}), autoStart: true, autonomyMigrated: true };
      this.write(s);
    } catch {
      /* 迁移失败不阻断启动；getPrefs 仍按默认值走 */
    }
  }

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
    // 0600（审计 #9）：settings.json 里是加密/明文的 API Key，默认权限下同机其它用户可读。
    // Windows 上 mode 被忽略（NTFS 用 ACL），chmod 对已存在的过宽文件也尽量收紧；失败不挡保存。
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* 非 POSIX 平台/只读介质：尽力而为 */
    }
  }

  /** 本机能否安全加密存储 Key（safeStorage 可用性）：界面据此决定要不要展示「明文存储」确认 */
  encryptionAvailable(): boolean {
    return this.isEncryptionAvailable();
  }

  /** 视觉/OCR 模型（M2-13）：独立配置，与对话模型解耦；未配置返回 null（调用方如实降级） */
  getVisionModel(): StoredModelConfig | null {
    return this.read().vision ?? null;
  }

  /**
   * IM 渠道配置（2026-11-18 P14-1）。
   *
   * 返回**原始形态**（secret 仍是加密的），解密由 kernel 做——
   * 因为 decryptor 是内核注入的，settings 层不该知道怎么解。
   */
  getIm(): SettingsFile["im"] | null {
    return this.read().im ?? null;
  }

  /** 写 IM 渠道配置（整体替换；调用方负责先把 secret 加密） */
  saveIm(im: NonNullable<SettingsFile["im"]>): void {
    const cur = this.read();
    this.write({ ...cur, im });
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
    /** safeStorage 不可用时允许明文落盘（界面勾选「明文存储，我知晓风险」才传 true） */
    plaintextOk?: boolean;
    /** 风险确认时间；不传 = 沿用该条旧值（换端点时由内核清空/拒绝） */
    riskAcceptedAt?: string;
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
      riskAcceptedAt: input.riskAcceptedAt ?? previous?.riskAcceptedAt,
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
    /** safeStorage 不可用时允许明文落盘（界面勾选「明文存储，我知晓风险」才传 true） */
    plaintextOk?: boolean;
    previous?: StoredModelConfig | null;
  }): StoredModelConfig {
    const cfg = this.buildConfig(input, input.previous ?? null);
    const s = this.read();
    s.vision = cfg;
    this.write(s);
    return cfg;
  }

  private buildConfig(
    input: { provider: string; baseUrl: string; model: string; apiKey?: string; plaintextOk?: boolean },
    previous: StoredModelConfig | null,
  ): StoredModelConfig {
    let apiKey: StoredModelConfig["apiKey"];
    const hasNewKey = input.apiKey !== undefined && input.apiKey !== "";
    if (hasNewKey) {
      const canEncrypt = this.isEncryptionAvailable();
      // 审计 #9：safeStorage 不可用时不再静默降级成明文——必须调用方显式确认
      // （界面勾选「明文存储，我知晓风险」），否则拒绝保存并说清原因。
      if (!canEncrypt && input.plaintextOk !== true) {
        throw new Error(
          "本机不支持安全加密存储（系统密钥环不可用）。API Key 将以明文写入磁盘——在模型设置里勾选「明文存储，我知晓风险」后再保存。",
        );
      }
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
    /** safeStorage 不可用时允许明文落盘（界面勾选「明文存储，我知晓风险」才传 true） */
    plaintextOk?: boolean;
    /** 风险确认时间；旧入口 config.save 与模型库共用同一份确认记录 */
    riskAcceptedAt?: string;
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
