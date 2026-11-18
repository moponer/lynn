/**
 * 能力中心（2026-11-15）：设置面板里唯一的能力入口。
 *
 * 五个分段：插件 / MCP / 技能 / 自动化 / 外部应用。
 * 设计纪律：
 *  - 每段都是「已装（真实现状）」+「可预装（清单+先决条件）」两张组卡，不堆碎卡；
 *  - 开关统一用 role="switch" 的小开关（不是按钮），点了就落配置并即时生效；
 *  - 外部应用的凭据只显示"填了没有"，值永不出内核；测连接是真请求，失败如实带原因。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { RpcContracts } from "../../shared/contract";
import { useUiPlugins } from "../desk/ui-host";
import { PluginImportPanel } from "./PluginImportPanel";
import { fmtTime } from "../desk/model";
import { useT } from "../i18n";
import { askConfirm } from "./ConfirmCard";

type Section = "plugins" | "mcp" | "skills" | "auto" | "apps";

type PluginRow = RpcContracts["plugins.list"]["result"]["plugins"][number];
type PresetRow = RpcContracts["cap.presets"]["result"]["presets"][number];
type McpView = RpcContracts["mcp.status"]["result"];
type SkillRow = RpcContracts["skills.list"]["result"]["skills"][number];
type ScheduleRow = RpcContracts["schedule.list"]["result"]["tasks"][number];
type DraftRow = RpcContracts["workshop.list"]["result"]["drafts"][number];
type ConnState = RpcContracts["connectors.list"]["result"];
type ConnItem = ConnState["items"][number];
type ConnSpec = ConnState["catalog"][number];
type Bilingual = { zh: string; en: string };

/** 外部应用分类 → 文案键（后端只给 category，文案走 i18n） */
const CAT_LABEL: Record<string, "cap.catCode" | "cap.catMail" | "cap.catDrive" | "cap.catServer"> = {
  code: "cap.catCode",
  mail: "cap.catMail",
  drive: "cap.catDrive",
  server: "cap.catServer",
};

/** 技能来源 → 文案键（user/project/plugin 是内部枚举，界面上写人话） */
const LEVEL_LABEL: Record<string, "skills.levelUser" | "skills.levelProject" | "skills.levelPlugin"> = {
  user: "skills.levelUser",
  project: "skills.levelProject",
  plugin: "skills.levelPlugin",
};

const SECTIONS: { k: Section; labelKey: "cap.tabPlugins" | "cap.tabMcp" | "cap.tabSkills" | "cap.tabAuto" | "cap.tabApps" }[] = [

  { k: "plugins", labelKey: "cap.tabPlugins" },
  { k: "mcp", labelKey: "cap.tabMcp" },
  { k: "skills", labelKey: "cap.tabSkills" },
  { k: "auto", labelKey: "cap.tabAuto" },
  { k: "apps", labelKey: "cap.tabApps" },
];

/** 开关：role=switch，零描边，轨道 + 圆钮 */
function Switch({ on, onToggle, title, disabled }: { on: boolean; onToggle: () => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={title}
      disabled={disabled}
      className={`cap-sw${on ? " on" : ""}`}
      onClick={onToggle}
    >
      <i />
    </button>
  );
}

/** 外部应用图标：自绘几何字形，不用商标 */
function CapGlyph({ icon, size = 30 }: { icon: string; size?: number }) {
  const box: CSSProperties = { width: size, height: size };
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <span className={`cap-glyph${icon ? ` ${icon}` : ""}`} style={box}>
      {icon === "mail" ? (
        <svg viewBox="0 0 24 24" {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3.5 7 8.5 6 8.5-6" />
        </svg>
      ) : icon === "cloud" ? (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M6.5 19a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 9.5z" />
          <path d="M12 12v5M9.8 14.2 12 12l2.2 2.2" />
        </svg>
      ) : icon === "server" ? (
        <svg viewBox="0 0 24 24" {...common}>
          <rect x="3.5" y="4" width="17" height="6.5" rx="1.6" />
          <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6" />
          <path d="M7 7.2h.01M7 16.7h.01" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="7" cy="6" r="2.4" />
          <circle cx="7" cy="18" r="2.4" />
          <circle cx="17" cy="12" r="2.4" />
          <path d="M7 8.4v7.2M9.4 7.1 14.6 11M9.4 16.9 14.6 13" />
        </svg>
      )}
    </span>
  );
}

const pick = (lang: "zh" | "en", v: Bilingual): string => (lang === "en" ? v.en : v.zh);

export function CapabilityCenter({
  section,
  onSection,
  mode,
  lang,
  onApplyThemeTokens,
  onApplyPluginStyle,
  onOpenAuto,
}: {
  section: Section;
  onSection: (s: Section) => void;
  mode: "light" | "dark";
  lang: "zh" | "en";
  onApplyThemeTokens: (tokens?: Record<string, string>) => void;
  onApplyPluginStyle?: (id: string | null, css?: string) => void;
  /** 自动化表单在外部（历史入口）；这里只给一个跳转 */
  onOpenAuto?: () => void;
}) {
  const t = useT();
  const { all: uiPlugins, disabled: uiDisabled, errors: uiErrors, toggle: toggleUi } = useUiPlugins();

  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [pluginErrors, setPluginErrors] = useState<string[]>([]);
  const [setStatus, setSetStatus] = useState<RpcContracts["plugins.status"]["result"] | null>(null);
  const [mcp, setMcp] = useState<McpView | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [skillErrors, setSkillErrors] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [conn, setConn] = useState<ConnState | null>(null);

  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 正在配置的外部应用 id + 草稿字段值 */
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [plaintextAck, setPlaintextAck] = useState(false);

  const refreshPlugins = useCallback(async () => {
    const [r, st] = await Promise.all([
      window.lynn.rpc("plugins.list"),
      window.lynn.rpc("plugins.status"),
    ]);
    setPlugins(r.plugins);
    setPluginErrors(r.errors);
    setSetStatus(st);
  }, []);

  const refreshMcp = useCallback(async () => {
    setMcp(await window.lynn.rpc("mcp.status"));
  }, []);

  const refreshSkills = useCallback(async () => {
    const r = await window.lynn.rpc("skills.list");
    setSkills(r.skills);
    setSkillErrors(r.errors);
  }, []);

  const refreshAuto = useCallback(async () => {
    const r = await window.lynn.rpc("schedule.list");
    setSchedules(r.tasks);
  }, []);

  const refreshPresets = useCallback(async () => {
    const r = await window.lynn.rpc("cap.presets");
    setPresets(r.presets);
  }, []);

  const refreshWorkshop = useCallback(async () => {
    const r = await window.lynn.rpc("workshop.list");
    setDrafts(r.drafts);
  }, []);

  const refreshConn = useCallback(async () => {
    setConn(await window.lynn.rpc("connectors.list"));
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshPlugins(), refreshMcp(), refreshSkills(), refreshAuto(), refreshPresets(), refreshConn(), refreshWorkshop()]);
  }, [refreshPlugins, refreshMcp, refreshSkills, refreshAuto, refreshPresets, refreshConn, refreshWorkshop]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // 切回本页时重新拉 MCP 实况（重连是异步的，状态会变）
  useEffect(() => {
    if (section === "mcp") void refreshMcp();
    if (section === "apps") void refreshConn();
  }, [section, refreshMcp, refreshConn]);

  const install = async (kind: PresetRow["kind"], id: string) => {
    setBusy(`install:${kind}:${id}`);
    try {
      const r = await window.lynn.rpc("cap.install", { kind, id });
      setMsg({ ok: r.ok, text: r.ok ? t("cap.installOk", { detail: r.detail }) : t("cap.installFail", { detail: r.detail }) });
      await Promise.all([refreshPresets(), refreshPlugins(), refreshMcp(), refreshSkills(), refreshAuto(), refreshConn()]);
    } catch (err) {
      setMsg({ ok: false, text: t("cap.installFail", { detail: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy("");
    }
  };

  const presetOf = (kind: PresetRow["kind"]) => presets.filter((p) => p.kind === kind);
  const counts = useMemo(() => {
    const installedApps = (conn?.items ?? []).filter((i) => i.enabled).length;
    return {
      plugins: plugins.length,
      mcp: mcp?.servers.length ?? 0,
      skills: skills.length,
      auto: schedules.length,
      apps: installedApps,
      appsTotal: conn?.catalog.length ?? 0,
    };
  }, [plugins.length, mcp, skills.length, schedules.length, conn]);

  /** 分段标签上的计数（2026-11-16：原来单独一排计数与标签同序同位，等于同一句话说两遍） */
  const countOf = (k: Section) =>
    k === "plugins"
      ? `${counts.plugins}`
      : k === "mcp"
        ? `${counts.mcp}`
        : k === "skills"
          ? `${counts.skills}`
          : k === "auto"
            ? `${counts.auto}`
            : `${counts.apps}/${counts.appsTotal}`;

  /** 预装卡（四类共用）：来源、先决条件、配套技能、已装状态 */
  const PresetCard = ({ p }: { p: PresetRow }) => (
    <div className="sf-market-card" key={`${p.kind}:${p.id}`}>
      <div className="sf-market-head">
        <CapGlyph icon={p.icon ?? "pkg"} size={22} />
        <b title={p.id}>{p.name}</b>
        {p.installed && <span className="sf-badge ok">{t("cap.installed")}</span>}
      </div>
      <small title={p.summary}>{p.summary}</small>
      {p.source && (
        <small className="mono" title={p.source}>
          {t("cap.source")} · {p.source}
        </small>
      )}
      {p.requires && <small>{t("cap.requires")} · {p.requires}</small>}
      {p.skill && (
        <small className="mono cap-skill" title={p.skillReady ? t("cap.skillReady") : t("cap.skillPending")}>
          {t("cap.skill", { name: p.skill })} · {p.skillReady ? t("cap.skillReady") : t("cap.skillPending")}
        </small>
      )}
      <div className="sf-market-actions">
        {/* 已装且技能在位 = 不用再点；已装但技能丢了（被删/被停用）= 「补技能」还能救 */}
        {(() => {
          const fixSkill = p.installed && Boolean(p.skill) && p.skillReady === false;
          const label = fixSkill ? t("cap.fixSkill") : p.installed ? t("cap.installed") : t("cap.install");
          return (
            <button
              type="button"
              className={`sf-btn${p.installed && !fixSkill ? "" : " primary"}`}
              disabled={busy === `install:${p.kind}:${p.id}` || (p.installed && !fixSkill)}
              onClick={() => void install(p.kind, p.id)}
            >
              {busy === `install:${p.kind}:${p.id}` ? "…" : label}
            </button>
          );
        })()}
      </div>
    </div>
  );

  const PresetGroup = ({ kind }: { kind: PresetRow["kind"] }) => {
    const list = presetOf(kind);
    if (list.length === 0) return null;
    return (
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.presetsTitle")}</b>
          <small>{t("cap.presetsHint")}</small>
        </div>
        <div className="sf-group-body">
          <div className="sf-market">
            {list.map((p) => (
              <PresetCard key={`${p.kind}:${p.id}`} p={p} />
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ---------- 插件 ----------
  const kindOf = (p: PluginRow): { label: string; title: string } => {
    if (p.theme || p.style) return { label: t("plugins.kindTheme"), title: `L0 · ${p.tier}` };
    if ((p.slots?.length ?? 0) > 0 || p.view) return { label: t("plugins.kindView"), title: `L0 · ${p.tier}` };
    if (p.tier === "L1") return { label: t("plugins.kindTool"), title: "L1" };
    if (p.tier === "L2") return { label: t("plugins.kindCmd"), title: "L2" };
    return { label: t("plugins.kindDeclarative"), title: p.tier };
  };
  /**
   * 插件版本面板（P12-1）：改插件不用卸载重装。
   * 展开在列表下方而不是弹窗——版本列表通常只有几条，弹窗反而更绕。
   */
  const [verOf, setVerOf] = useState<string | null>(null);
  const [vers, setVers] = useState<{ dir: string; version: string; at: string; bytes: number }[]>([]);
  const [verKeep, setVerKeep] = useState(5);
  const openVersions = async (id: string) => {
    if (verOf === id) {
      setVerOf(null);
      return;
    }
    const r = await window.lynn.rpc("plugins.versions", { id });
    setVers(r.versions ?? []);
    setVerKeep(r.keep ?? 5);
    setVerOf(id);
  };
  const slotOnly = uiPlugins.filter((u) => !plugins.some((p) => p.id === u.id));
  const themePlugins = plugins.filter((p) => p.theme && p.enabled);

  const pluginsPane = (
    <>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.pluginsTitle")}</b>
          <small>
            {t("cap.pluginsHint")}
            {setStatus ? ` · ${t("plugins.fingerprint")} ${setStatus.fingerprint.slice(0, 10)} · ${t("plugins.count", { n: setStatus.count })}` : ""}
          </small>
        </div>
        {setStatus?.safeMode && (
          <div className="sf-actions">
            <button
              type="button"
              className="sf-btn"
              onClick={() =>
                void window.lynn.rpc("plugins.safeMode", { on: false }).then(() => {
                  setMsg({ ok: true, text: t("plugins.exitSafeModeOk") });
                  void refreshPlugins();
                })
              }
            >
              {t("plugins.exitSafeMode")}
            </button>
          </div>
        )}
        <div className="sf-group-body">
          {plugins.length === 0 ? (
            <p className="sf-empty">{t("plugins.empty")}</p>
          ) : (
            <div className="sf-list">
              {plugins.map((p) => {
                const kind = kindOf(p);
                return (
                  <div className="sf-row" key={p.id}>
                    <div className="sf-row-main">
                      <b>
                        {p.name}
                        <span className="sf-badge" title={kind.title}>
                          {kind.label}
                        </span>
                      </b>
                      <small title={p.description || p.id}>{p.description || p.id}</small>
                      <small className="mono">
                        {p.id} · v{p.version}
                        {p.slots?.includes("stage.console") ? ` · ${t("plugins.slotConsole")}` : ""}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="sf-btn"
                      onClick={() =>
                        void window.lynn.rpc("plugins.probe", { id: p.id }).then((r) =>
                          setMsg({ ok: r.ok, text: t("plugins.probeResult", { id: p.id, detail: r.detail }) }),
                        )
                      }
                    >
                      {t("plugins.probe")}
                    </button>
                    {/* P12-1：改插件不用卸载重装——看历史版本、一键回滚 */}
                    <button
                      type="button"
                      className="sf-btn"
                      onClick={() => void openVersions(p.id)}
                    >
                      {t("plugins.versions")}
                    </button>
                    <Switch
                      on={p.enabled}
                      title={p.enabled ? t("plugins.disable") : t("common.enable")}
                      onToggle={() =>
                        void window.lynn.rpc("plugins.toggle", { id: p.id, enabled: !p.enabled }).then(() => {
                          void refreshPlugins();
                          window.dispatchEvent(new Event("lynn:ui-plugins"));
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
          {/*
            版本面板（P12-1）：展开在列表下方。
            空态要说清"更新之后才会有历史版本"——否则用户会以为坏了。
          */}
          {verOf && (
            <div className="sf-group">
              <div className="sf-group-head">
                <b>{t("plugins.versionsOf", { id: verOf })}</b>
                <small>{t("plugins.versionsKeep", { n: verKeep })}</small>
              </div>
              {vers.length === 0 ? (
                <p className="sf-empty">{t("plugins.versionsEmpty")}</p>
              ) : (
                <div className="sf-list">
                  {vers.map((v) => (
                    <div className="sf-row" key={v.dir}>
                      <div className="sf-row-main">
                        <b>v{v.version}</b>
                        <small className="mono">
                          {v.dir} · {(v.bytes / 1024).toFixed(1)}KB
                        </small>
                      </div>
                      <button
                        type="button"
                        className="sf-btn"
                        onClick={() =>
                          void window.lynn.rpc("plugins.rollbackVersion", { id: verOf, versionDir: v.dir }).then((r) => {
                            setMsg({
                              ok: r.ok,
                              text: r.ok ? t("plugins.rollbackVersionOk", { version: r.version ?? "" }) : r.issues.map((i) => i.message).join("；"),
                            });
                            if (r.ok) {
                              setVerOf(null);
                              void refreshPlugins();
                            }
                          })
                        }
                      >
                        {t("plugins.rollbackToThis")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {pluginErrors.length > 0 && <div className="sf-result bad">{pluginErrors.join("；")}</div>}
          <div className="sf-actions">
            <button
              type="button"
              className="sf-btn"
              onClick={() =>
                void window.lynn.rpc("plugins.rollback", {}).then((r) => {
                  setMsg({ ok: r.ok, text: r.ok ? t("plugins.rollbackOk") : r.detail });
                  if (r.ok) void refreshPlugins();
                })
              }
            >
              {t("plugins.rollback")}
            </button>
          </div>
        </div>
      </div>

      {/* 从插件包装（P9-4）：补上"只有 RPC、界面点不到"的缺口。
          放在插件列表下方：用户先看到已装的，再决定要不要装新的。 */}
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("pluginImport.title")}</b>
          <small>{t("pluginImport.hint")}</small>
        </div>
        <PluginImportPanel onImported={() => void refreshPlugins()} />
      </div>

      <PresetGroup kind="plugin" />

      {/* 插件工坊：风铃/用户开的草稿在这里过审入库；L1/L2 必须由用户点启用 */}
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("workshop.title")}</b>
          <small>{t("workshop.hint")}</small>
        </div>
        {drafts.length === 0 ? (
          <p className="sf-empty">{t("workshop.empty")}</p>
        ) : (
          <div className="sf-list">
            {drafts.map((d) => (
              <div className="sf-row" key={d.draftId}>
                <div className="sf-row-main">
                  <b>
                    {d.title}
                    <span className={`sf-badge ${d.status === "reviewed" || d.status === "enabled" ? "ok" : ""}`}>
                      {d.status === "draft"
                        ? t("workshop.statusDraft")
                        : d.status === "reviewed"
                          ? t("workshop.statusReviewed")
                          : t("workshop.statusEnabled")}
                    </span>
                  </b>
                  <small className="mono">
                    {d.draftId} · {d.kind} · {fmtTime(d.createdAt)}
                  </small>
                </div>
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() =>
                    void window.lynn.rpc("workshop.promote", { draftId: d.draftId, byUser: true }).then((r) => {
                      if (r.ok) {
                        setMsg({ ok: true, text: t("workshop.promoteOk", { id: r.id }) });
                        void refreshPlugins();
                        void refreshPresets();
                        void refreshWorkshop();
                      } else {
                        setMsg({ ok: false, text: (r as { error?: string }).error ?? t("workshop.promoteFail") });
                      }
                    })
                  }
                >
                  {t("workshop.promote")}
                </button>
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() =>
                    void window.lynn.rpc("workshop.discard", { draftId: d.draftId }).then(() => {
                      setMsg({ ok: true, text: t("workshop.discardOk") });
                      void refreshWorkshop();
                    })
                  }
                >
                  {t("workshop.discard")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 界面扩展：主题一键应用 + U 档卡槽 */}
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("plugins.uiExtTitle")}</b>
          <small>{t("plugins.uiExtHint")}</small>
        </div>
        <div className="sf-group-body">
          {themePlugins.length > 0 && (
            <div className="sf-sub" style={{ padding: "6px 0" }}>
              <span className="sf-label">{t("plugins.themePlugins")}</span>
              <div className="sf-inline">
                {themePlugins.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className="sf-btn"
                    onClick={() => {
                      onApplyThemeTokens(p.theme?.[mode] ?? p.theme?.dark ?? p.theme?.light);
                      onApplyPluginStyle?.(p.id, p.style);
                    }}
                  >
                    {p.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() => {
                    onApplyThemeTokens(undefined);
                    onApplyPluginStyle?.(null);
                  }}
                >
                  {t("plugins.restoreTheme")}
                </button>
              </div>
            </div>
          )}
          <div className="sf-sub" style={{ padding: "6px 0" }}>
            <span className="sf-label">{t("plugins.uiSlots", { n: slotOnly.length })}</span>
            {slotOnly.length === 0 ? (
              <p className="sf-empty">{t("plugins.uiEmpty")}</p>
            ) : (
              <div className="sf-list">
                {slotOnly.map((p) => (
                  <div className="sf-row" key={p.id}>
                    <div className="sf-row-main">
                      <b>{p.name}</b>
                      <small className="mono">
                        {p.id} · {p.slots.join(" / ")}
                      </small>
                    </div>
                    <Switch
                      on={!uiDisabled.includes(p.id)}
                      title={uiDisabled.includes(p.id) ? t("common.enable") : t("plugins.disable")}
                      onToggle={() => toggleUi(p.id)}
                    />
                  </div>
                ))}
              </div>
            )}
            {uiErrors.length > 0 && <div className="sf-result bad">{uiErrors.join("；")}</div>}
          </div>
        </div>
      </div>
    </>
  );

  // ---------- MCP ----------
  const mcpPane = (
    <>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.mcpTitle")}</b>
          <small>
            {t("mcp.hint")} <span className="mono">{mcp?.globalFile ?? "~/.lynn/mcp.json"}</span>
            {" · "}
            {t("cap.mcpHint")}
          </small>
        </div>
        <div className="sf-actions">
          <button
            type="button"
            className="sf-btn"
            disabled={busy === "mcp:reload"}
            onClick={() => {
              setBusy("mcp:reload");
              void window.lynn.rpc("mcp.reload").then(() => {
                setBusy("");
                setMsg({ ok: true, text: t("mcp.reload") });
                void refreshMcp();
              });
            }}
          >
            {busy === "mcp:reload" ? t("mcp.reloading") : t("cap.reload")}
          </button>
        </div>
        {!mcp && <p className="sf-empty">{t("mcp.loading")}</p>}
        {mcp && mcp.servers.length === 0 && <p className="sf-empty">{t("mcp.empty")}</p>}
        {mcp && mcp.servers.length > 0 && (
          <div className="sf-list">
            {mcp.servers.map((s) => (
              <div className="sf-row" key={s.id}>
                <div className="sf-row-main">
                  <b>
                    {s.id}
                    <span className={`sf-badge ${s.connected ? "ok" : s.enabled ? "warn" : ""}`}>
                      {s.connected
                        ? t("mcp.connected")
                        : s.lazy
                          ? t("mcp.lazy")
                          : s.enabled
                            ? t("mcp.offline")
                            : t("mcp.disabled")}
                    </span>
                  </b>
                  <small className="mono">{s.command}</small>
                  <small>
                    {t("mcp.toolCount", { n: s.tools })}
                    {s.error ? ` · ${s.error}` : ""}
                  </small>
                </div>
                <Switch
                  on={s.enabled}
                  title={s.enabled ? t("plugins.disable") : t("common.enable")}
                  onToggle={() =>
                    void window.lynn.rpc("mcp.toggle", { id: s.id, enabled: !s.enabled }).then((r) => {
                      if (!r.ok) setMsg({ ok: false, text: r.error ?? "切换失败" });
                      else setMsg({ ok: true, text: `${s.id} · ${!s.enabled ? t("common.enable") : t("plugins.disable")}` });
                      void refreshMcp();
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}
        {mcp && (
          <small className="sf-hint">
            {t("mcp.projectFile")} <span className="mono">{mcp.projectFile}</span>
            {mcp.projectTrusted ? t("mcp.trusted") : t("mcp.untrusted")}
          </small>
        )}
        {mcp?.errors?.length ? <div className="sf-result bad">{mcp.errors.join("；")}</div> : null}
      </div>

      <PresetGroup kind="mcp" />
    </>
  );

  // ---------- 技能 ----------
  const skillsPane = (
    <>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.skillsTitle")}</b>
          <small>{t("cap.skillsHint")}</small>
        </div>
        {skills.length === 0 ? (
          <p className="sf-empty">{t("skills.empty")}</p>
        ) : (
          <div className="sf-list">
            {skills.map((s) => (
              <div className="sf-row" key={`${s.level}:${s.name}`}>
                <div className="sf-row-main">
                  <b>
                    {s.name}
                    <span className="sf-badge">{LEVEL_LABEL[s.level] ? t(LEVEL_LABEL[s.level]) : s.level}</span>
                    {s.disabled && <span className="sf-badge warn">{t("skills.off")}</span>}
                  </b>
                  {/* 描述是主体，白名单只是"激活后收窄到哪"（2026-11-16）：
                      一长串工具名单独占一行时会被读成正文，把技能名彻底压住。
                      这里只报件数，完整清单在悬停里。 */}
                  <div className="sk-meta">
                    <small className="sk-desc" title={s.dir}>
                      {s.description || t("skills.noDesc")}
                    </small>
                    <span
                      className="sk-tools"
                      title={s.allowedTools.length ? s.allowedTools.join("、") : t("skills.noTools")}
                    >
                      {s.allowedTools.length ? t("skills.toolCount", { n: s.allowedTools.length }) : t("skills.noTools")}
                    </span>
                  </div>
                </div>
                <Switch
                  on={!s.disabled}
                  title={s.disabled ? t("skills.onHint") : t("skills.offHint")}
                  onToggle={() =>
                    void window.lynn.rpc("skills.toggle", { name: s.name, enabled: s.disabled }).then(() => refreshSkills())
                  }
                />
              </div>
            ))}
          </div>
        )}
        {skillErrors.length > 0 && <div className="sf-result bad">{skillErrors.join("；")}</div>}
      </div>

      <PresetGroup kind="skill" />
    </>
  );

  // ---------- 自动化 ----------
  const autoPane = (
    <>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.autoTitle")}</b>
          <small>{t("cap.autoHint")}</small>
        </div>
        {schedules.length === 0 ? (
          <p className="sf-empty">{t("auto.listHint")}</p>
        ) : (
          <div className="sf-list">
            {schedules.map((r) => (
              <div className="sf-row" key={r.id}>
                <div className="sf-row-main">
                  <b>
                    {r.name}
                    <span className={`sf-badge ${r.enabled ? "ok" : "warn"}`}>{r.enabled ? t("auto.on") : t("auto.off")}</span>
                    {r.lastStatus && <span className="sf-badge warn">{r.lastStatus}</span>}
                  </b>
                  <small>
                    {t("auto.next")} {r.nextRun ? fmtTime(r.nextRun) : "—"}
                    {" · "}
                    {t("auto.last")} {r.lastRun ? fmtTime(r.lastRun) : "—"}
                  </small>
                </div>
                <button
                  type="button"
                  className="sf-btn"
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: t("auto.removeAsk", { name: r.name }),
                      danger: true,
                      confirmLabel: t("auto.remove"),
                    });
                    if (!ok) return;
                    await window.lynn.rpc("schedule.remove", { id: r.id });
                    await refreshAuto();
                  }}
                >
                  {t("auto.remove")}
                </button>
                <Switch
                  on={r.enabled}
                  title={r.enabled ? t("auto.disable") : t("auto.enable")}
                  onToggle={() => void window.lynn.rpc("schedule.toggle", { id: r.id }).then(() => refreshAuto())}
                />
              </div>
            ))}
          </div>
        )}
        {onOpenAuto && (
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={onOpenAuto}>
              {t("cap.addSchedule")}
            </button>
          </div>
        )}
      </div>

      <PresetGroup kind="schedule" />
    </>
  );

  // ---------- 外部应用 ----------
  const connItem = (id: string): ConnItem | undefined => conn?.items.find((i) => i.id === id);

  const openConfig = (spec: ConnSpec, item?: ConnItem) => {
    if (openApp === spec.id) {
      setOpenApp(null);
      return;
    }
    setOpenApp(spec.id);
    setPlaintextAck(false);
    const next: Record<string, string> = {};
    for (const f of spec.fields) {
      if (!f.secret) next[f.key] = item?.values[f.key] ?? "";
    }
    setForm(next);
  };

  const saveApp = async (spec: ConnSpec) => {
    setBusy(`save:${spec.id}`);
    try {
      const r = await window.lynn.rpc("connectors.save", {
        id: spec.id,
        values: form,
        plaintextOk: plaintextAck,
        enable: true,
      });
      setMsg({ ok: r.ok, text: r.ok ? `${pick(lang, spec.name)} · ${t("cap.configured")}` : r.error ?? "保存失败" });
      if (r.ok) {
        setForm({});
        await Promise.all([refreshConn(), refreshSkills()]);
      }
    } finally {
      setBusy("");
    }
  };

  const testApp = async (spec: ConnSpec) => {
    setBusy(`test:${spec.id}`);
    try {
      const r = await window.lynn.rpc("connectors.test", { id: spec.id });
      setMsg({ ok: r.ok, text: r.detail });
      await refreshConn();
    } finally {
      setBusy("");
    }
  };

  const appCard = (spec: ConnSpec, item?: ConnItem) => {
    const enabled = item?.enabled ?? false;
    const configured = item?.configured ?? false;
    const open = openApp === spec.id;
    return (
      <div className="cap-app" key={spec.id}>
        <div className="cap-app-head">
          <CapGlyph icon={spec.icon} />
          <b>{pick(lang, spec.name)}</b>
          <span className="cap-cat">{CAT_LABEL[spec.category] ? t(CAT_LABEL[spec.category]) : spec.category}</span>
          <span className={`sf-badge ${enabled ? "ok" : ""}`}>
            {enabled ? t("cap.connected") : configured ? t("cap.configured") : t("cap.notConfigured")}
          </span>
          <Switch
            on={enabled}
            title={t("cap.appSwitchHint")}
            onToggle={() =>
              void window.lynn.rpc("connectors.toggle", { id: spec.id, enabled: !enabled }).then((r) => {
                if (!r.ok) setMsg({ ok: false, text: r.error ?? "切换失败" });
                void refreshConn();
              })
            }
          />
        </div>
        <small>{pick(lang, spec.summary)}</small>
        {open && (
          <>
            <small className="sf-hint">{pick(lang, spec.detail)}</small>
            <div className="cap-form">
              {spec.fields.map((f) => (
                <label className="cap-field" key={f.key}>
                  <span className="sf-label">
                    {pick(lang, f.label)}
                    {f.required ? " *" : ""}
                  </span>
                  <input
                    className="sf-input"
                    type={f.secret ? "password" : "text"}
                    value={form[f.key] ?? ""}
                    placeholder={f.secret ? (item?.hasSecret[f.key] ? t("cap.secretSet") : t("cap.secretEmpty")) : f.placeholder}
                    onChange={(ev) => setForm((prev) => ({ ...prev, [f.key]: ev.target.value }))}
                  />
                  {f.hint && <small className="sf-hint">{pick(lang, f.hint)}</small>}
                </label>
              ))}
            </div>
            {conn && !conn.canEncrypt && (
              <label className="sf-row" style={{ cursor: "pointer", padding: "6px 0", background: "transparent" }}>
                <input type="checkbox" checked={plaintextAck} onChange={(e) => setPlaintextAck(e.target.checked)} />
                <span className="sf-row-main">
                  <small>{t("cap.noEncrypt")}</small>
                  <b>{t("cap.plaintextAck")}</b>
                </span>
              </label>
            )}
            {conn?.canEncrypt && <small className="sf-hint">{t("cap.canEncrypt")}</small>}
            {item?.checkDetail && (
              <small className={item.checkOk ? "sf-hint" : "sf-hint"}>
                {t("cap.checked")} · {item.checkDetail}
              </small>
            )}
          </>
        )}
        <div className="cap-app-acts">
          <button type="button" className="sf-btn" onClick={() => openConfig(spec, item)}>
            {open ? t("cap.collapse") : t("cap.configure")}
          </button>
          {open && (
            <>
              <button type="button" className="sf-btn primary" disabled={busy === `save:${spec.id}`} onClick={() => void saveApp(spec)}>
                {busy === `save:${spec.id}` ? "…" : t("cap.save")}
              </button>
              <button type="button" className="sf-btn" disabled={busy === `test:${spec.id}`} onClick={() => void testApp(spec)}>
                {busy === `test:${spec.id}` ? t("cap.testing") : t("cap.test")}
              </button>
            </>
          )}
          <a className="sf-btn" href={spec.docUrl} target="_blank" rel="noreferrer">
            {t("cap.appDoc")}
          </a>
          {configured && (
            <button
              type="button"
              className="sf-btn"
              onClick={async () => {
                const ok = await askConfirm({
                  title: t("cap.forgetAsk", { name: pick(lang, spec.name) }),
                  danger: true,
                  confirmLabel: t("cap.forget"),
                });
                if (!ok) return;
                await window.lynn.rpc("connectors.forget", { id: spec.id });
                await refreshConn();
              }}
            >
              {t("cap.forget")}
            </button>
          )}
        </div>
      </div>
    );
  };

  const appsPane = (
    <>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.appsTitle")}</b>
          <small>{t("cap.appsHint")}</small>
        </div>
        <div className="sf-group-body">
          <div className="sf-market cap-apps">
            {(conn?.catalog ?? []).filter((s) => connItem(s.id)?.configured).map((s) => appCard(s, connItem(s.id)))}
          </div>
          {(conn?.catalog ?? []).filter((s) => connItem(s.id)?.configured).length === 0 && (
            <p className="sf-empty">{t("cap.appsAvailableHint")}</p>
          )}
        </div>
      </div>
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("cap.appsAvailable")}</b>
          <small>{t("cap.appsAvailableHint")}</small>
        </div>
        <div className="sf-group-body">
          <div className="sf-market cap-apps">
            {(conn?.catalog ?? []).filter((s) => !connItem(s.id)?.configured).map((s) => appCard(s, connItem(s.id)))}
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="sf-pane">
      <h3>{t("cap.title")}</h3>
      <p className="sf-lede">{t("cap.lede")}</p>

      {/* 计数并进标签（2026-11-16）：原来标签与计数各占一排、同序同位，
          等于把同一句话说了两遍，而 lede 已经交代过这里有什么。 */}
      <div className="cap-seg" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.k}
            type="button"
            role="tab"
            aria-selected={section === s.k}
            className={`cap-seg-btn${section === s.k ? " on" : ""}`}
            onClick={() => onSection(s.k)}
          >
            {t(s.labelKey)}
            <span className="n">{countOf(s.k)}</span>
          </button>
        ))}
      </div>

      {section === "plugins" && pluginsPane}
      {section === "mcp" && mcpPane}
      {section === "skills" && skillsPane}
      {section === "auto" && autoPane}
      {section === "apps" && appsPane}

      {msg && <div className={`sf-result ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
    </div>
  );
}
