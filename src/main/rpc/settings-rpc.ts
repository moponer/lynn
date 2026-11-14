// 设置面 RPC（2026-11-14）：config.prefs + model.* 七件，从 kernel.handle 的巨型 switch 里抽出来。
//
// 这是"抽文件"的第一个试点。选择这一组是因为它们的依赖面最小：只需要设置存储、对话存储、
// 当前对话 id、默认模型解析、重建运行时、解密、停语音——七个成员，不碰会话/工单/成员/UI 状态。
//
// 约定：方法返回 unknown，由 kernel 在转发处用 `as RpcContracts[M]["result"]` 收口。
// 这样搬动时不用为每个方法抄一遍泛型签名，代价是类型检查只在契约测试那一层兜底。
import type { RpcContracts } from "../../shared/contract";
import { isLang } from "../../shared/i18n";
import { loadApiKey, type SettingsStore } from "../settings";
import type { ThreadStore } from "../threads";
import { probeEndpoint } from "../llm";
import { endpointRiskLevel, normalizeBaseUrl } from "../endpoint";
import { isCaptureHotkey } from "../capture";
import { isValidVoiceId, isProsody, VOICE_SCOPES } from "../voice-policy";

export interface SettingsRpcDeps {
  settings: SettingsStore;
  threads: ThreadStore;
  /** 当前对话 id（换群时变） */
  currentThreadId(): string;
  /** 当前生效的模型 id（线程覆盖 → 默认 → 第一条） */
  activeModelId(): string | null | undefined;
  /** 换模型/删模型必须重建 Pi 运行时（--provider/--model 是启动参数） */
  resetAgentHost(): void;
  /** 解密 apiKey blob（safeStorage 的密文是 Buffer） */
  decrypt(blob: Buffer): string;
  /** 关掉总开关要立刻静音，不能等正在播的那句念完 */
  stopVoice(): void;
}

export interface SettingsRpc {
  savePrefs(params: unknown): unknown;
  modelList(): unknown;
  modelSave(params: unknown): unknown;
  modelRemove(params: unknown): unknown;
  modelSetDefault(params: unknown): unknown;
  modelSetThread(params: unknown): unknown;
  modelTest(params: unknown): unknown;
}

export function createSettingsRpc(deps: SettingsRpcDeps): SettingsRpc {
  const { settings, threads } = deps;

  return {
    savePrefs(params: unknown): unknown {
      const p = params as RpcContracts["config.prefs"]["params"];
      if (p.lang !== undefined && !isLang(p.lang)) {
        return { ok: false, error: `未知语言：${String(p.lang)}（只支持 zh / en）` };
      }
      if (p.captureHotkey !== undefined && !isCaptureHotkey(p.captureHotkey)) {
        return { ok: false, error: `截图快捷键格式不对：${String(p.captureHotkey)}（要像 Alt+Shift+S）` };
      }
      const proxy = p.voiceProxy === undefined ? undefined : String(p.voiceProxy).trim().slice(0, 200);
      if (proxy !== undefined && proxy !== "" && !/^https?:\/\/[\w.:-]+\/?$/.test(proxy)) {
        return { ok: false, error: "代理格式不对（要像 http://127.0.0.1:7890）" };
      }
      const saved = settings.savePrefs({
        autoStart: Boolean(p.autoStart),
        ...(p.trayOnClose !== undefined ? { trayOnClose: Boolean(p.trayOnClose) } : {}),
        ...(p.notify !== undefined ? { notify: Boolean(p.notify) } : {}),
        ...(p.softBudgetTokens !== undefined ? { softBudgetTokens: Math.max(0, Number(p.softBudgetTokens) || 0) } : {}),
        ...(p.fallbackModel !== undefined ? { fallbackModel: String(p.fallbackModel).trim() } : {}),
        ...(p.lang !== undefined ? { lang: p.lang } : {}),
        ...(p.captureHotkey !== undefined ? { captureHotkey: String(p.captureHotkey).trim() } : {}),
        ...(p.heartbeat !== undefined ? { heartbeat: Boolean(p.heartbeat) } : {}),
        ...(p.voiceEnabled !== undefined ? { voiceEnabled: Boolean(p.voiceEnabled) } : {}),
        ...(p.voiceId !== undefined && isValidVoiceId(p.voiceId) ? { voiceId: p.voiceId } : {}),
        ...(p.voiceRate !== undefined && isProsody(p.voiceRate) ? { voiceRate: p.voiceRate } : {}),
        ...(p.voiceVolume !== undefined && isProsody(p.voiceVolume) ? { voiceVolume: p.voiceVolume } : {}),
        ...(p.voiceScope !== undefined && VOICE_SCOPES.includes(p.voiceScope) ? { voiceScope: p.voiceScope } : {}),
        ...(p.voiceMaxChars !== undefined ? { voiceMaxChars: Math.max(30, Math.min(300, Number(p.voiceMaxChars) || 120)) } : {}),
        ...(p.voiceWhenHidden !== undefined ? { voiceWhenHidden: Boolean(p.voiceWhenHidden) } : {}),
        ...(proxy !== undefined ? { voiceProxy: proxy } : {}),
        ...(p.advisorEnabled !== undefined ? { advisorEnabled: Boolean(p.advisorEnabled) } : {}),
        ...(p.modelRoles !== undefined ? { modelRoles: p.modelRoles } : {}),
      });
      if (saved.voiceEnabled === false) deps.stopVoice();
      return {
        ok: true,
        autoStart: saved.autoStart,
        trayOnClose: saved.trayOnClose,
        notify: saved.notify,
        softBudgetTokens: saved.softBudgetTokens,
        fallbackModel: saved.fallbackModel,
        lang: saved.lang,
        captureHotkey: saved.captureHotkey,
        heartbeat: saved.heartbeat,
        voiceEnabled: saved.voiceEnabled,
        voiceId: saved.voiceId,
        voiceRate: saved.voiceRate,
        voiceVolume: saved.voiceVolume,
        voiceScope: saved.voiceScope,
        voiceMaxChars: saved.voiceMaxChars,
        voiceWhenHidden: saved.voiceWhenHidden,
        voiceProxy: saved.voiceProxy,
        advisorEnabled: saved.advisorEnabled,
        modelRoles: saved.modelRoles,
      };
    },

    modelList(): unknown {
      const entries = settings.getModels();
      const defaultId = settings.getDefaultModelId();
      const threadId = threads.get(deps.currentThreadId())?.modelId ?? null;
      const activeId = deps.activeModelId() ?? defaultId ?? entries[0]?.id ?? null;
      return {
        models: entries.map((e) => ({
          id: e.id,
          label: e.label,
          provider: e.provider,
          baseUrl: e.baseUrl,
          model: e.model,
          apiKeySet: !!e.apiKey?.data,
          isDefault: e.id === defaultId,
          isThreadModel: !!threadId && e.id === threadId,
          updatedAt: e.updatedAt,
          riskLevel: endpointRiskLevel(e.baseUrl),
          riskAccepted: Boolean(e.riskAcceptedAt),
        })),
        defaultModelId: defaultId,
        threadModelId: threadId,
        activeModelId: activeId,
        threadTitle: threads.get(deps.currentThreadId())?.title ?? "新群",
        canEncrypt: settings.encryptionAvailable(),
      };
    },

    modelSave(params: unknown): unknown {
      const p = params as {
        id?: string;
        label: string;
        provider: string;
        baseUrl: string;
        model: string;
        apiKey?: string;
        riskAccepted?: boolean;
        plaintextOk?: boolean;
      };
      if (!p.baseUrl?.trim() || !p.model?.trim()) {
        return { ok: false, error: "Base URL 和模型都要填。" };
      }
      const risk = endpointRiskLevel(p.baseUrl);
      const previous = p.id ? settings.getModels().find((e) => e.id === p.id) : undefined;
      const sameEndpoint = previous && normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(p.baseUrl);
      if (risk !== "remote" && !p.riskAccepted && !(sameEndpoint && previous?.riskAcceptedAt)) {
        return {
          ok: false,
          error:
            risk === "local"
              ? "这是本机/局域网网关：可能复用第三方免费额度，prompt 可能被上游记录，且随时可能限流或下线。请勾选风险确认后再保存。"
              : "这个端点不是 HTTPS：API Key 与内容会明文传输。请勾选风险确认后再保存。",
        };
      }
      try {
        const entry = settings.upsertModel({
          id: p.id,
          label: p.label,
          provider: p.provider,
          baseUrl: p.baseUrl,
          model: p.model,
          apiKey: p.apiKey,
          plaintextOk: p.plaintextOk === true,
          riskAcceptedAt: p.riskAccepted ? new Date().toISOString() : undefined,
        });
        return { ok: true, id: entry.id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    modelRemove(params: unknown): unknown {
      const p = params as { id: string };
      const r = settings.removeModel(String(p.id));
      if (!r.ok) return { ok: false, error: r.error ?? "删除失败" };
      // 清理所有指向它的对话覆盖，避免留悬空 id
      for (const t of threads.list()) {
        if (t.modelId === p.id) threads.setModel(t.id, null);
      }
      deps.resetAgentHost();
      return { ok: true, defaultModelId: r.defaultModelId };
    },

    modelSetDefault(params: unknown): unknown {
      const p = params as { id: string };
      try {
        settings.setDefaultModel(String(p.id));
        deps.resetAgentHost();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    modelSetThread(params: unknown): unknown {
      const p = params as { id: string | null };
      const id = p.id === null || p.id === "" ? null : String(p.id);
      if (id && !settings.getModels().some((e) => e.id === id)) {
        return { ok: false, error: "模型不存在" };
      }
      try {
        threads.setModel(deps.currentThreadId(), id);
        // 换模型必须换 Pi 运行时（--provider/--model 是启动参数），下一条消息重建
        deps.resetAgentHost();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    modelTest(params: unknown): unknown {
      const p = params as { id?: string; baseUrl?: string; apiKey?: string; model?: string };
      let baseUrl = p.baseUrl?.trim() ?? "";
      let model = p.model?.trim() ?? "";
      let apiKey = p.apiKey?.trim() ?? "";
      if (p.id) {
        const cfg = settings.getModel(p.id);
        if (!cfg) return { ok: false, error: "模型不存在" };
        baseUrl = baseUrl || cfg.baseUrl;
        model = model || cfg.model;
        if (!apiKey) apiKey = loadApiKey(settings, (b) => deps.decrypt(b), p.id) ?? "";
      }
      if (!baseUrl || !model) return { ok: false, error: "Base URL 和模型都要填。" };
      if (!apiKey) return { ok: false, error: "请先填写 API Key（新配置不能借用别的模型 Key）。" };
      return probeEndpoint({ baseUrl, apiKey, model });
    },
  };
}
