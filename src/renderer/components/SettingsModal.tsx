import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelConfigView, UsageView } from "../../shared/contract";
import { THEMES, type ThemeId, type ThemeMode } from "../desk/theme";
import { buildPack, checkPack, describePack, downloadPack, type LynnPack } from "../desk/lynnpack";
import { useUiPlugins } from "../desk/ui-host";
import { AvatarStage } from "../desk/AvatarStage";
import type { AvatarState } from "../../shared/avatar";
import { AMBIENT_MODE_LABEL, type AmbientMode } from "../../shared/ambient";
import { useT } from "../i18n";
import { Icon, type IconName } from "./Icon";

const BUBBLE: Record<AvatarState, string> = {
  idle: "我在。今天想先做哪件？",
  thinking: "先看看这个表有几行…",
  running: "成员在跑，我盯着证据。",
  success: "这单可以收，等你盖章。",
  failed: "这次没过，我把原因写清楚了。",
  waiting_confirm: "这里要你拍板，我不敢替你定。",
  standby: "待机中，随时叫我。",
};

const PRESETS = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  { name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "MiniMax", baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-M2" },
];

type Tab = "overview" | "model" | "persona" | "plugins" | "safety" | "look" | "data";

const NAV: { k: Tab; labelKey: string; icon: IconName }[] = [
  { k: "overview", labelKey: "nav.overview", icon: "home" },
  { k: "model", labelKey: "nav.model", icon: "cpu" },
  { k: "persona", labelKey: "nav.persona", icon: "user" },
  { k: "plugins", labelKey: "nav.plugins", icon: "layers" },
  { k: "safety", labelKey: "nav.safety", icon: "shield" },
  { k: "look", labelKey: "nav.look", icon: "pen" },
  { k: "data", labelKey: "nav.data", icon: "folder" },
];

/**
 * 「我的风铃」：六页导航（概览 / 模型 / 能力与插件 / 权限与安全 / 外观 / 数据与日志）。
 * 每一页只放真实可用的配置；没实现的能力不在这里出现（不做占位）。
 */
export function SettingsModal({
  current,
  theme,
  mode,
  avatar,
  ambientMode,
  members,
  autoStart,
  trayOnClose,
  notify,
  lang,
  project,
  usage,
  onPrefs,
  onTheme,
  onAvatar,
  onPack,
  onAmbient,
  onApplyThemeTokens,
  onAutoStart,
  onTrust,
  onClose,
  onSaved,
}: {
  current: ModelConfigView;
  theme: ThemeId;
  mode: ThemeMode;
  avatar: boolean;
  ambientMode: AmbientMode;
  members: { name: string; role: string }[];
  autoStart: boolean;
  /** 关窗进托盘（M1-18） */
  trayOnClose: boolean;
  /** 窗口隐藏时系统通知（M1-18） */
  notify: boolean;
  /** 界面语言（M3-08） */
  lang: "zh" | "en";
  project?: { root: string; trusted: boolean; hasMcp: boolean };
  usage: UsageView;
  onPrefs: (p: { trayOnClose: boolean; notify: boolean; lang?: "zh" | "en" }) => void;
  onTheme: (id: ThemeId, mode: ThemeMode) => void;
  onAvatar: (on: boolean) => void;
  onPack: (p: LynnPack) => void;
  onAmbient: (m: AmbientMode) => void;
  onApplyThemeTokens: (tokens?: Record<string, string>) => void;
  onAutoStart: (v: boolean) => void;
  onTrust?: (trusted: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [provider, setProvider] = useState(current.provider || "DeepSeek");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl || "https://api.deepseek.com/v1");
  const [model, setModel] = useState(current.model || "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [avState, setAvState] = useState<AvatarState>("waiting_confirm");
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [packMsg, setPackMsg] = useState<string>("");
  const [preview, setPreview] = useState<{ pack: LynnPack; lines: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const { all: uiPlugins, disabled: uiDisabled, errors: uiErrors, toggle: toggleUi } = useUiPlugins();

  // persona.md（M1-17）：编辑 + 版本化回滚
  const [personaText, setPersonaText] = useState<string | null>(null);
  const [personaVersions, setPersonaVersions] = useState<{ id: string; savedAt: string; chars: number }[]>([]);
  const [personaMsg, setPersonaMsg] = useState("");
  // 更新器（M1-23）：进数据页时拉一次状态
  const [updateInfo, setUpdateInfo] = useState<{
    supported?: boolean;
    reason?: string;
    version?: string;
    latest?: string;
    phase: "idle" | "available" | "downloading" | "downloaded" | "none";
    percent?: number;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (tab === "data" || tab === "overview") void window.lynn.rpc("update.status").then(setUpdateInfo);
  }, [tab]);

  const refreshPersona = async () => {
    try {
      const [g, v] = await Promise.all([
        window.lynn.rpc("persona.get"),
        window.lynn.rpc("persona.versions"),
      ]);
      setPersonaText(g.text);
      setPersonaVersions(v.versions);
    } catch {
      setPersonaMsg("读不到 persona（内核未连接？）");
    }
  };

  useEffect(() => {
    if (tab === "persona" && personaText === null) void refreshPersona();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [plugins, setPlugins] = useState<
    { id: string; name: string; version: string; tier: string; enabled: boolean; loadable: boolean }[]
  >([]);
  const [themePlugins, setThemePlugins] = useState<
    { id: string; name: string; theme?: { dark?: Record<string, string>; light?: Record<string, string> } }[]
  >([]);
  const [setStatus, setSetStatus] = useState<{
    fingerprint: string;
    count: number;
    safeMode: boolean;
    safeModeReason?: string;
  } | null>(null);

  const refreshPlugins = async () => {
    try {
      const r = await window.lynn.rpc("plugins.list");
      const list = Array.isArray(r?.plugins) ? r.plugins : [];
      setPlugins(list.map((p) => ({ id: p.id, name: p.name, version: p.version, tier: p.tier, enabled: p.enabled, loadable: p.loadable })));
      setThemePlugins(list.filter((p) => p.theme).map((p) => ({ id: p.id, name: p.name, theme: p.theme })));
    } catch {
      /* 无内核时忽略 */
    }
    try {
      const s = await window.lynn.rpc("plugins.status");
      if (s && typeof s.fingerprint === "string") {
        setSetStatus({ fingerprint: s.fingerprint, count: s.count, safeMode: s.safeMode, safeModeReason: s.safeModeReason });
      }
    } catch {
      /* 同上 */
    }
  };

  useEffect(() => {
    void refreshPlugins();
  }, []);

  // Esc 关闭 + 焦点不逃逸（模态基本盘）
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !cardRef.current) return;
      const nodes = cardRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    cardRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!provider.trim() || !baseUrl.trim() || !model.trim()) {
      setResult({ ok: false, text: "服务商、Base URL、模型都要填。" });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      await window.lynn.rpc("config.save", {
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setResult({ ok: true, text: "已保存；下一条消息生效。" });
      setApiKey("");
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const testConn = async () => {
    setBusy("test");
    setResult(null);
    try {
      const r = await window.lynn.rpc("config.test", {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
      });
      setResult(r.ok ? { ok: true, text: `连通正常，延迟 ${r.latencyMs}ms` } : { ok: false, text: r.error });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const clearKey = async () => {
    setBusy("clear");
    try {
      const r = await window.lynn.rpc("config.clearKey");
      setResult(r.ok ? { ok: true, text: "已清除本机保存的 Key。" } : { ok: false, text: "没有已保存的 Key。" });
      onSaved();
    } finally {
      setBusy("");
    }
  };

  const exportPack = () => {
    const pack = buildPack({
      theme: { id: theme, mode },
      avatar,
      model: { provider: provider.trim(), baseUrl: baseUrl.trim(), model: model.trim() },
      capabilities: [],
      roles: members.map((m) => ({ name: m.name, role: m.role, goal: "", tools: [] })),
      teamName: "我的班底",
    });
    const name = downloadPack(pack);
    setPackMsg(`已导出 ${name}（只含配置，不含记忆 / 会话 / 凭据）`);
  };

  const pickPack = async (file: File) => {
    setPackMsg("");
    setPreview(null);
    const text = await file.text();
    const r = checkPack(text);
    if (!r.ok || !r.pack) {
      setPackMsg(`导入失败：${r.issues.join("；")}`);
      return;
    }
    setPreview({ pack: r.pack, lines: describePack(r.pack) });
  };

  const page = useMemo(() => {
    if (tab === "model") {
      return (
        <div className="sf-pane">
          <h3>{t("model.title")}</h3>
          <div className="sf-inline">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                className={`sf-btn${provider === p.name ? " primary" : ""}`}
                onClick={() => {
                  setProvider(p.name);
                  setBaseUrl(p.baseUrl);
                  setModel(p.model);
                  setResult(null);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="sf-grid2">
            <label className="sf-field">
              <span className="sf-label">{t("model.provider")}</span>
              <input className="sf-input" value={provider} onChange={(e) => setProvider(e.target.value)} />
            </label>
            <label className="sf-field">
              <span className="sf-label">{t("model.model")}</span>
              <input className="sf-input" value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
          <label className="sf-field">
            <span className="sf-label">Base URL</span>
            <input className="sf-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="sf-field">
            <span className="sf-label">API Key</span>
            <input
              className="sf-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.apiKeySet ? t("model.keySaved") : "sk-…"}
            />
            <small className="sf-hint">{t("model.keyHint")}</small>
          </label>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={() => void testConn()} disabled={busy !== "" || (!apiKey.trim() && !current.apiKeySet)}>
              {busy === "test" ? t("model.testing") : t("model.test")}
            </button>
            <button type="button" className="sf-btn primary" onClick={() => void save()} disabled={busy !== ""}>
              {busy === "save" ? t("model.saving") : t("common.save")}
            </button>
            <button type="button" className="sf-btn" onClick={() => void clearKey()} disabled={busy !== "" || !current.apiKeySet}>
              {busy === "clear" ? t("model.clearing") : t("model.clearKey")}
            </button>
          </div>
        </div>
      );
    }

    if (tab === "persona") {
      return (
        <div className="sf-pane">
          <h3>{t("persona.title")}</h3>
          <div className="sf-hint">{t("persona.hint")}</div>
          {personaText === null ? (
            <p className="sf-empty">{personaMsg || t("persona.loading")}</p>
          ) : (
            <>
              <textarea
                className="sf-persona"
                rows={14}
                value={personaText}
                onChange={(e) => setPersonaText(e.target.value)}
                spellCheck={false}
              />
              <div className="sf-actions">
                <button
                  type="button"
                  className="sf-btn primary"
                  onClick={() => {
                    void window.lynn.rpc("persona.save", { text: personaText }).then((r) => {
                      setPersonaMsg(r.hot ? t("persona.savedHot") : t("persona.savedNext"));
                      void window.lynn.rpc("persona.versions").then((v) => setPersonaVersions(v.versions));
                    });
                  }}
                >
                  {t("persona.save")}
                </button>
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() => {
                    void refreshPersona();
                    setPersonaMsg("");
                  }}
                >
                  {t("persona.discard")}
                </button>
              </div>
              {personaMsg && <div className="sf-hint">{personaMsg}</div>}
              {personaVersions.length > 0 && (
                <>
                  <span className="sf-label">{t("persona.versions")}</span>
                  <div className="sf-list">
                    {personaVersions.map((v) => (
                      <div className="sf-row" key={v.id}>
                        <div className="sf-row-main">
                          <span className="mono">{new Date(v.savedAt).toLocaleString()}</span>
                          <span className="sf-row-sub">{t("persona.chars", { n: v.chars })}</span>
                        </div>
                        <button
                          type="button"
                          className="sf-btn"
                          onClick={() => {
                            void window.lynn.rpc("persona.rollback", { id: v.id }).then((r) => {
                              setPersonaText(r.text);
                              setPersonaMsg(r.hot ? t("persona.rollbackHot") : t("persona.rollbackNext"));
                            });
                          }}
                        >
                          {t("persona.rollback")}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      );
    }

    if (tab === "plugins") {
      return (
        <div className="sf-pane">
          <h3>{t("plugins.title")}</h3>
          <div className="sf-hint">
            {t("plugins.fingerprint")} <span className="mono">{setStatus?.fingerprint.slice(0, 12) ?? "—"}</span> · {t("plugins.count", { n: setStatus?.count ?? 0 })}
            {setStatus?.safeMode && (
              <span className="sf-badge bad">{t("plugins.safeMode", { reason: setStatus.safeModeReason ?? "…" })}</span>
            )}
          </div>
          {plugins.length === 0 ? (
            <p className="sf-empty">{t("plugins.empty")}</p>
          ) : (
            <div className="sf-list">
              {plugins.map((p) => (
                <div className="sf-row" key={p.id}>
                  <div className="sf-row-main">
                    <b>{p.name}</b>
                    <small className="mono">
                      {p.id} · v{p.version} · {p.tier}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={`sf-btn${p.enabled ? " primary" : ""}`}
                    onClick={() =>
                      void window.lynn.rpc("plugins.toggle", { id: p.id, enabled: !p.enabled }).then(() => refreshPlugins())
                    }
                  >
                    {p.enabled ? t("plugins.disable") : t("common.enable")}
                  </button>
                  <button
                    type="button"
                    className="sf-btn"
                    onClick={() =>
                      void window.lynn.rpc("plugins.probe", { id: p.id }).then((r) =>
                        setResult({ ok: r.ok, text: t("plugins.probeResult", { id: p.id, detail: r.detail }) }),
                      )
                    }
                  >
                    {t("plugins.probe")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="sf-actions">
            <button
              type="button"
              className="sf-btn"
              onClick={() =>
                void window.lynn.rpc("plugins.rollback", {}).then((r) => {
                  setResult({ ok: r.ok, text: r.ok ? t("plugins.rollbackOk") : r.detail });
                  if (r.ok) void refreshPlugins();
                })
              }
            >
              {t("plugins.rollback")}
            </button>
          </div>
          {themePlugins.length > 0 && (
            <div className="sf-sub">
              <span className="sf-label">{t("plugins.themePlugins")}</span>
              <div className="sf-inline">
                {themePlugins.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className="sf-btn"
                    onClick={() => onApplyThemeTokens(p.theme?.[mode] ?? p.theme?.dark ?? p.theme?.light)}
                  >
                    {p.name}
                  </button>
                ))}
                <button type="button" className="sf-btn" onClick={() => onApplyThemeTokens(undefined)}>
                  {t("plugins.restoreTheme")}
                </button>
              </div>
            </div>
          )}
          <div className="sf-sub">
            <span className="sf-label">{t("plugins.uiSlots", { n: uiPlugins.length })}</span>
            {uiPlugins.length === 0 ? (
              <p className="sf-empty">{t("plugins.uiEmpty")}</p>
            ) : (
              <div className="sf-list">
                {uiPlugins.map((p) => (
                  <div className="sf-row" key={p.id}>
                    <div className="sf-row-main">
                      <b>{p.name}</b>
                      <small className="mono">
                        {p.id} · {p.slots.join(" / ")}
                      </small>
                    </div>
                    <button type="button" className={`sf-btn${uiDisabled.includes(p.id) ? "" : " primary"}`} onClick={() => toggleUi(p.id)}>
                      {uiDisabled.includes(p.id) ? t("common.enable") : t("plugins.disable")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {uiErrors.length > 0 && <div className="sf-result bad">{uiErrors.join("；")}</div>}
          </div>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
        </div>
      );
    }

    if (tab === "safety") {
      return (
        <div className="sf-pane">
          <h3>{t("safety.title")}</h3>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>{t("safety.contractTitle")}</b>
              <small>{t("safety.contractHint")}</small>
            </div>
            <button
              type="button"
              className={`sf-btn${autoStart ? "" : " primary"}`}
              onClick={() => onAutoStart(false)}
            >
              {t("safety.alwaysAsk")}
            </button>
            <button type="button" className={`sf-btn${autoStart ? " primary" : ""}`} onClick={() => onAutoStart(true)}>
              {t("safety.autoStart")}
            </button>
          </div>
          <div className="sf-sub">
            <span className="sf-label">{t("safety.permLabel")}</span>
            <p className="sf-hint">{t("safety.permHint")}</p>
          </div>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>
                {t("safety.project")}
                <span className={`sf-badge ${project?.trusted ? "ok" : "warn"}`}>
                  {project?.trusted ? t("safety.trusted") : t("safety.untrusted")}
                </span>
              </b>
              <small className="mono">{project?.root ?? "—"}</small>
              <small>{project?.hasMcp ? t("safety.hasMcp") : t("safety.noMcp")}</small>
            </div>
            <button type="button" className="sf-btn" onClick={() => onTrust?.(!project?.trusted)}>
              {project?.trusted ? t("safety.untrust") : t("safety.trust")}
            </button>
          </div>

          <div className="sf-sub">
            <span className="sf-label">{t("safety.isolationLabel")}</span>
            <p className="sf-hint">{t("safety.isolationHint")}</p>
          </div>
          <div className="sf-sub">
            <span className="sf-label">{t("safety.dataLabel")}</span>
            <p className="sf-hint">{t("safety.dataHint")}</p>
          </div>
        </div>
      );
    }

    if (tab === "look") {
      return (
        <div className="sf-pane">
          <h3>{t("look.title")}</h3>
          <span className="sf-label">{t("look.language")}</span>
          <div className="sf-inline">
            <button type="button" className={`sf-btn${lang === "zh" ? " primary" : ""}`} onClick={() => onPrefs({ trayOnClose, notify, lang: "zh" })}>
              {t("lang.zh")}
            </button>
            <button type="button" className={`sf-btn${lang === "en" ? " primary" : ""}`} onClick={() => onPrefs({ trayOnClose, notify, lang: "en" })}>
              {t("lang.en")}
            </button>
          </div>
          <small className="sf-hint">{t("look.languageHint")}</small>
          <span className="sf-label">{t("look.theme")}</span>
          <div className="theme-row">
            {THEMES.map((th) => {
              const c = th[mode];
              return (
                <button
                  type="button"
                  key={th.id}
                  className={`theme${theme === th.id ? " on" : ""}`}
                  onClick={() => onTheme(th.id, mode)}
                  title={`${th.name} · ${th.hint}`}
                >
                  <div className="swatches">
                    <i style={{ background: c.desk }} />
                    <i style={{ background: c.blue }} />
                    <i style={{ background: c.seal }} />
                    <i style={{ background: c.brass }} />
                  </div>
                  <div className="theme-name">
                    <span className="t">{th.name}</span>
                  </div>
                  <div className="theme-desc">{th.hint}</div>
                </button>
              );
            })}
          </div>
          <div className="sf-inline">
            <button type="button" className={`sf-btn${mode === "dark" ? " primary" : ""}`} onClick={() => onTheme(theme, "dark")}>
              {t("look.modeDark")}
            </button>
            <button type="button" className={`sf-btn${mode === "light" ? " primary" : ""}`} onClick={() => onTheme(theme, "light")}>
              {t("look.modeLight")}
            </button>
          </div>
          <span className="sf-label">{t("look.ambient")}</span>
          <div className="sf-inline">
            {(["full", "low", "off"] as AmbientMode[]).map((m) => (
              <button type="button" key={m} className={`sf-btn${ambientMode === m ? " primary" : ""}`} onClick={() => onAmbient(m)}>
                {AMBIENT_MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <span className="sf-label">{t("look.avatar")}</span>
          <div className="sf-inline">
            <button type="button" className={`sf-btn${avatar ? " primary" : ""}`} onClick={() => onAvatar(true)}>
              {t("common.enable")}
            </button>
            <button type="button" className={`sf-btn${!avatar ? " primary" : ""}`} onClick={() => onAvatar(false)}>
              {t("common.disable")}
            </button>
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("pet.open")}>
              {t("look.petOpen")}
            </button>
          </div>
          {avatar && <AvatarStage state={avState} onState={setAvState} bubble={BUBBLE[avState]} height={200} />}
          <span className="sf-label">{t("look.presence")}</span>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>{t("look.trayTitle")}</b>
              <small>{t("look.trayHint")}</small>
            </div>
            <button
              type="button"
              className={`sf-btn${trayOnClose ? " primary" : ""}`}
              onClick={() => onPrefs({ trayOnClose: !trayOnClose, notify, lang })}
            >
              {trayOnClose ? t("common.on") : t("common.off")}
            </button>
          </div>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>{t("look.notifyTitle")}</b>
              <small>{t("look.notifyHint")}</small>
            </div>
            <button
              type="button"
              className={`sf-btn${notify ? " primary" : ""}`}
              onClick={() => onPrefs({ trayOnClose, notify: !notify, lang })}
            >
              {notify ? t("common.on") : t("common.off")}
            </button>
          </div>
        </div>
      );
    }

    if (tab === "data") {
      const upd = updateInfo;
      const updMsg = upd?.error ? t("data.updateErr", { msg: upd.error }) : upd?.reason ?? "";
      return (
        <div className="sf-pane">
          <h3>{t("data.title")}</h3>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>
                {t("data.version")} <span className="mono">{upd?.version ?? "…"}</span>
                {upd?.latest && upd.latest !== upd.version && (
                  <small> · {t("data.updatable")} <span className="mono">{upd.latest}</span></small>
                )}
                {upd?.phase === "downloading" && <small> · {t("data.downloading", { pct: Math.round(upd.percent ?? 0) })}</small>}
                {upd?.phase === "downloaded" && <small> · {t("data.downloaded")}</small>}
              </b>
              {updMsg && <small>{updMsg}</small>}
              {!updMsg && upd?.supported === false && upd.phase === "idle" && (
                <small>{upd.reason ?? ""}</small>
              )}
            </div>
            <div className="sf-inline">
              <button
                type="button"
                className="sf-btn"
                onClick={() =>
                  void window.lynn.rpc("update.check").then((r) => {
                    setUpdateInfo(r);
                    if (r.phase === "available") void window.lynn.rpc("update.download").then(setUpdateInfo);
                  })
                }
              >
                {t("data.check")}
              </button>
              {upd?.phase === "downloaded" && (
                <button
                  type="button"
                  className="sf-btn primary"
                  onClick={() => void window.lynn.rpc("update.install").then(() => undefined)}
                >
                  {t("data.install")}
                </button>
              )}
            </div>
          </div>
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("app.openData", { kind: "data" })}>
              {t("data.openData")}
            </button>
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("app.openData", { kind: "logs" })}>
              {t("data.openLogs")}
            </button>
            <button
              type="button"
              className="sf-btn"
              onClick={() => {
                if (!window.confirm(t("data.clearConfirm"))) return;
                void window.lynn.rpc("session.new", {}).then(() => {
                  setPackMsg(t("data.cleared"));
                  onSaved();
                });
              }}
            >
              {t("data.clearSession")}
            </button>
          </div>
          <span className="sf-label">{t("data.pack")}</span>
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={exportPack}>
              {t("data.export")}
            </button>
            <button type="button" className="sf-btn" onClick={() => fileRef.current?.click()}>
              {t("data.import")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".lynnpack,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickPack(f);
              }}
            />
          </div>
          {packMsg && <div className="sf-hint">{packMsg}</div>}
          {preview && (
            <div className="sf-preview">
              <ul>
                {preview.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              <div className="sf-actions">
                <button
                  type="button"
                  className="sf-btn primary"
                  onClick={() => {
                    onPack(preview.pack);
                    setPreview(null);
                    setPackMsg(t("data.applied"));
                  }}
                >
                  {t("data.apply")}
                </button>
                <button type="button" className="sf-btn" onClick={() => setPreview(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // 概览 = 待办清单（E5）：只放需要用户处理的真问题，每条可点直达对应页；
    // 上下文百分比/会话用量顶栏已有，不再画一遍（删掉的 sf-tile）。
    const brokenPlugins = plugins.filter((p) => !p.loadable).length;
    const todos: { key: string; text: string; tab: Tab }[] = [];
    if (!current.configured) todos.push({ key: "model", text: t("overview.todoModel"), tab: "model" });
    else if (!current.apiKeySet) todos.push({ key: "key", text: t("overview.todoKey"), tab: "model" });
    if (project && !project.trusted) todos.push({ key: "trust", text: t("overview.todoTrust"), tab: "safety" });
    if (brokenPlugins > 0) todos.push({ key: "plugins", text: t("overview.todoPlugins", { n: brokenPlugins }), tab: "plugins" });
    if (uiErrors.length > 0) todos.push({ key: "ui", text: t("overview.todoUi"), tab: "plugins" });
    if (updateInfo && (updateInfo.phase === "available" || updateInfo.phase === "downloaded")) {
      todos.push({ key: "update", text: t("overview.todoUpdate", { v: updateInfo.latest ?? "" }), tab: "data" });
    }

    return (
      <div className="sf-pane">
        <h3>{t("overview.title")}</h3>
        {todos.length === 0 ? (
          <p className="sf-empty">{t("overview.allClear")}</p>
        ) : (
          <div className="sf-list">
            {todos.map((td) => (
              <div className="sf-row" key={td.key}>
                <div className="sf-row-main">
                  <b>{td.text}</b>
                </div>
                <button type="button" className="sf-btn primary" onClick={() => setTab(td.tab)}>
                  {t("overview.goFix")}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="sf-row">
          <div className="sf-row-main">
            <b>{t("overview.crew", { n: members.length })}</b>
            <small>{members.length === 0 ? t("overview.crewEmpty") : members.map((m) => m.name).join("、")}</small>
          </div>
        </div>
      </div>
    );
  }, [
    tab,
    provider,
    baseUrl,
    model,
    apiKey,
    current,
    mode,
    theme,
    avatar,
    avState,
    ambientMode,
    autoStart,
    trayOnClose,
    notify,
    usage,
    members,
    project,
    updateInfo,
    busy,
    result,
    plugins,
    themePlugins,
    setStatus,
    uiPlugins,
    uiDisabled,
    uiErrors,
    preview,
    packMsg,
    onAmbient,
    onApplyThemeTokens,
    onAutoStart,
    onPrefs,
    onAvatar,
    onTheme,
    toggleUi,
  ]);

  return (
    <div className="sf-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sf-card wide" ref={cardRef} role="dialog" aria-modal="true" aria-label={t("settings.title")}>
        <header className="sf-head">
          <div>
            <b>{t("settings.title")}</b>
            <span className="sf-sub">{t("settings.subtitle")}</span>
          </div>
          <button type="button" className="sf-x" onClick={onClose} title={t("settings.close")}>
            ✕
          </button>
        </header>
        <div className="sf-shell">
          <nav className="sf-nav">
            {NAV.map((n) => (
              <button type="button" key={n.k} className={`sf-nav-item${tab === n.k ? " on" : ""}`} onClick={() => setTab(n.k)}>
                <Icon name={n.icon} size="sm" />
                {t(n.labelKey)}
              </button>
            ))}
          </nav>
          <div className="sf-body">{page}</div>
        </div>
      </div>
    </div>
  );
}
