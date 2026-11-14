import { useEffect, useMemo, useRef, useState } from "react";
import type { GatewayView, ModelConfigView, ModelEntryView, TeamAdminView, UsageView } from "../../shared/contract";
import { THEMES, type ThemeId, type ThemeMode } from "../desk/theme";
import { fmtTime } from "../desk/model";
import { buildPack, checkPack, describePack, downloadPack, type LynnPack } from "../desk/lynnpack";
import { useUiPlugins } from "../desk/ui-host";
import { AvatarStage } from "../desk/AvatarStage";
import { endpointRiskLevel } from "../../shared/endpoint-risk";
import type { AvatarState } from "../../shared/avatar";
import { AMBIENT_MODE_LABEL, type AmbientMode } from "../../shared/ambient";
import { AVATARS, avatarById, avatarFor } from "../../shared/avatars";
import { MemberAvatar } from "../desk/MemberAvatar";
import { useT } from "../i18n";
import type { I18nKey } from "../../shared/i18n-strings";
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

type Tab = "overview" | "model" | "persona" | "memory" | "team" | "auto" | "skills" | "plugins" | "safety" | "look" | "data";

/** 定时任务（M2-02）：界面只回读调度器的真实状态 */
type ScheduleRow = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  nextRun?: string;
  lastRun?: string;
  lastStatus?: string;
};

/** MCP 服务器实况（mcp.status） */
type McpRow = {
  id: string;
  command: string;
  enabled: boolean;
  lazy: boolean;
  connected: boolean;
  tools: number;
  error?: string;
};

/** 设置导航：三组（她本人 / 干活能力 / 权限与扩展），组帽让"哪页管什么"一眼可查 */
const NAV_GROUPS: { capKey: I18nKey; items: { k: Tab; labelKey: I18nKey; icon: IconName }[] }[] = [
  {
    capKey: "nav.capHer",
    items: [
      { k: "overview", labelKey: "nav.overview", icon: "home" },
      { k: "persona", labelKey: "nav.persona", icon: "user" },
      { k: "memory", labelKey: "nav.memory", icon: "brain" },
    ],
  },
  {
    capKey: "nav.capWork",
    items: [
      { k: "model", labelKey: "nav.model", icon: "cpu" },
      { k: "team", labelKey: "nav.team", icon: "users" },
      { k: "auto", labelKey: "nav.auto", icon: "clock" },
      { k: "skills", labelKey: "nav.skills", icon: "pkg" },
    ],
  },
  {
    capKey: "nav.capSystem",
    items: [
      { k: "plugins", labelKey: "nav.plugins", icon: "layers" },
      { k: "safety", labelKey: "nav.safety", icon: "shield" },
      { k: "look", labelKey: "nav.look", icon: "pen" },
      { k: "data", labelKey: "nav.data", icon: "folder" },
    ],
  },
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
  voiceEnabled,
  voiceId,
  voiceRate,
  voiceVolume,
  voiceScope,
  voiceMaxChars,
  voiceWhenHidden,
  voiceProxy,
  project,
  usage,
  onPrefs,
  onTheme,
  onAvatar,
  onPack,
  onAmbient,
  onApplyThemeTokens,
  onApplyPluginStyle,
  onAutoStart,
  onTrust,
  onClose,
  onSaved,
  initialTab,
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
  /** 语音播报偏好（2026-11-13）：全部由快照传入，旧内核缺字段时 App 已兜底 */
  voiceEnabled: boolean;
  voiceId: string;
  voiceRate: string;
  voiceVolume: string;
  voiceScope: "brief" | "detail";
  voiceMaxChars: number;
  voiceWhenHidden: boolean;
  voiceProxy: string;
  project?: { root: string; trusted: boolean; hasMcp: boolean; gated?: { mcp: boolean; skills: boolean } };
  usage: UsageView;
  onPrefs: (p: {
    trayOnClose: boolean;
    notify: boolean;
    lang?: "zh" | "en";
    captureHotkey?: string;
    voiceEnabled?: boolean;
    voiceId?: string;
    voiceRate?: string;
    voiceVolume?: string;
    voiceScope?: "brief" | "detail";
    voiceMaxChars?: number;
    voiceWhenHidden?: boolean;
    voiceProxy?: string;
  }) => void;
  onTheme: (id: ThemeId, mode: ThemeMode) => void;
  onAvatar: (on: boolean) => void;
  onPack: (p: LynnPack) => void;
  onAmbient: (m: AmbientMode) => void;
  onApplyThemeTokens: (tokens?: Record<string, string>) => void;
  /** L0 形态层：id + CSS 原文；传 null 卸载。缺省时只换 Token */
  onApplyPluginStyle?: (id: string | null, css?: string) => void;
  onAutoStart: (v: boolean) => void;
  onTrust?: (trusted: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
  /** 从编制表「管理」直达团队页（默认概览） */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");
  const [provider, setProvider] = useState(current.provider || "DeepSeek");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl || "https://api.deepseek.com/v1");
  const [model, setModel] = useState(current.model || "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  /** 模型库：null = 只看列表；"new" = 新增；其它 = 正在编辑的模型 id */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelEntryView[]>([]);
  const [modelMeta, setModelMeta] = useState<{
    defaultModelId: string | null;
    threadModelId: string | null;
    activeModelId: string | null;
    threadTitle: string;
    canEncrypt: boolean;
  }>({ defaultModelId: null, threadModelId: null, activeModelId: null, threadTitle: "新群", canEncrypt: true });
  /** 自定义端点风险确认：本机/局域网/非 HTTPS 保存或探测前必须勾选 */
  const [riskAck, setRiskAck] = useState(false);
  /** 明文存储确认（审计 #9）：safeStorage 不可用时，保存 Key 必须显式勾选 */
  const [plaintextAck, setPlaintextAck] = useState(false);
  /** 从 /v1/models 发现模型（批量导入） */
  const [discover, setDiscover] = useState<{
    open: boolean;
    busy: boolean;
    models: { id: string; ownedBy?: string }[];
    selected: Set<string>;
    error?: string;
  }>({ open: false, busy: false, models: [], selected: new Set() });
  /** 每条模型的健康检查结果 */
  const [health, setHealth] = useState<Record<string, { state: "checking" | "ok" | "bad"; text: string }>>({});
  /** 本机免费/本地网关：打开模型页时探测一次，不自动启动进程 */
  const [gateways, setGateways] = useState<GatewayView[]>([]);
  const [gwBusy, setGwBusy] = useState(false);
  const [gwRiskAck, setGwRiskAck] = useState(false);
  const [avState, setAvState] = useState<AvatarState>("waiting_confirm");
  const [busy, setBusy] = useState<"" | "save" | "test" | "list">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [packMsg, setPackMsg] = useState<string>("");
  const [preview, setPreview] = useState<{ pack: LynnPack; lines: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const { all: uiPlugins, disabled: uiDisabled, errors: uiErrors, toggle: toggleUi } = useUiPlugins();

  // persona.md（M1-17）：编辑 + 版本化回滚
  const [personaText, setPersonaText] = useState<string | null>(null);
  const [personaVersions, setPersonaVersions] = useState<{ id: string; savedAt: string; chars: number }[]>([]);
  const [personaMsg, setPersonaMsg] = useState("");

  // 编制管理（用户手动）：团队 + 岗位档案；null = 还没读
  const [teams, setTeams] = useState<TeamAdminView[] | null>(null);
  const [teamMsg, setTeamMsg] = useState("");
  /** 后台是旧版本（不认识 team.* 接口）：给一个"重启应用"，别让用户以为功能坏了 */
  const [teamStale, setTeamStale] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [editingMember, setEditingMember] = useState<{
    teamId: string;
    name: string;
    role: string;
    goal: string;
    body: string;
  } | null>(null);
  /** 二次确认键：remove:<team>:<member> / dissolve:<team>（不弹系统 confirm，就地确认） */
  const [teamPending, setTeamPending] = useState("");
  /** 正在给哪个成员挑头像：`teamId:name`；展开的是就地的一排头像，不另开弹窗 */
  const [avatarPick, setAvatarPick] = useState<string | null>(null);

  /** 后台旧版本会把 team.* 当成未知方法抛出来：翻成"重启应用"，不把裸错误甩给用户 */
  const teamErrorText = (raw: string): string => {
    if (/unknown rpc method/i.test(raw)) {
      setTeamStale(true);
      return `后台还是旧版本，不认识编制接口（${raw}）。重启应用后生效。`;
    }
    setTeamStale(false);
    return raw;
  };

  const refreshTeams = async () => {
    try {
      const r = await window.lynn.rpc("team.list");
      setTeams(Array.isArray(r.teams) ? r.teams : []);
      if (r.error) setTeamMsg(`读编制失败：${teamErrorText(r.error)}`);
    } catch (err) {
      setTeams([]);
      setTeamMsg(`读编制失败：${teamErrorText(err instanceof Error ? err.message : String(err))}`);
    }
  };

  useEffect(() => {
    if (tab === "team") void refreshTeams();
    // 只按 tab 变化拉取；refreshTeams 每次都重建，进依赖会无限拉
  }, [tab]);

  const saveMember = async () => {
    if (!editingMember) return;
    setTeamBusy(true);
    try {
      const r = await window.lynn.rpc("team.member.save", {
        teamId: editingMember.teamId,
        name: editingMember.name,
        role: editingMember.role,
        goal: editingMember.goal,
        body: editingMember.body,
      });
      if (!r.ok) {
        setTeamMsg(teamErrorText(r.error));
        return;
      }
      setTeamStale(false);
      setTeamMsg(`已保存「${editingMember.name}」的岗位：下一单按新说明执行。`);
      setEditingMember(null);
      await refreshTeams();
      onSaved();
    } finally {
      setTeamBusy(false);
    }
  };

  /** 换头像只改 avatarId，不碰岗位正文；选中即落盘，用户马上能看到全应用同步 */
  const chooseAvatar = async (teamId: string, name: string, avatarId: string) => {
    setTeamBusy(true);
    try {
      const r = await window.lynn.rpc("team.member.save", { teamId, name, avatarId });
      if (!r.ok) {
        setTeamMsg(teamErrorText(r.error));
        return;
      }
      setAvatarPick(null);
      setTeamMsg(`「${name}」的头像底色已换。`);
      await refreshTeams();
      onSaved();
    } finally {
      setTeamBusy(false);
    }
  };

  const removeMember = async (teamId: string, name: string) => {
    setTeamBusy(true);
    try {
      const r = await window.lynn.rpc("team.member.remove", { teamId, name });
      if (r.ok) setTeamStale(false);
      setTeamMsg(r.ok ? `已把「${name}」移出编制（历史派单记录保留）。` : teamErrorText(r.error));
      if (r.ok) {
        await refreshTeams();
        onSaved();
      }
    } finally {
      setTeamBusy(false);
      setTeamPending("");
    }
  };

  const dissolveTeam = async (teamId: string, name: string) => {
    setTeamBusy(true);
    try {
      const r = await window.lynn.rpc("team.dissolve", { teamId });
      if (r.ok) setTeamStale(false);
      setTeamMsg(r.ok ? `已解散「${name}」：档案保留，不能再派活。` : teamErrorText(r.error));
      if (r.ok) {
        await refreshTeams();
        onSaved();
      }
    } finally {
      setTeamBusy(false);
      setTeamPending("");
    }
  };
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

  // 工作区（2026-11-10）：默认主根 + 常用只读根（L0），保存后对新会话与成员生效
  const [wsDefault, setWsDefault] = useState("");
  const [wsRoots, setWsRoots] = useState<string[]>([]);
  const [wsMsg, setWsMsg] = useState("");
  const [dataUsage, setDataUsage] = useState<{
    totalBytes: number;
    tasksBytes: number;
    scratchBytes: number;
    artifactsBytes: number;
    sandboxBytes: number;
    logsBytes: number;
    checkpointsBytes: number;
  } | null>(null);
  const [dataMsg, setDataMsg] = useState("");
  const refreshUsage = () => {
    void window.lynn
      .rpc("data.usage")
      .then((r) => setDataUsage(r.usage))
      .catch(() => undefined);
  };
  useEffect(() => {
    if (tab === "data") refreshUsage();
  }, [tab]);
  const fmtBytes = (n: number) =>
    n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  useEffect(() => {
    if (tab !== "data") return;
    let dead = false;
    void window.lynn
      .rpc("workspace.prefs")
      .then((r) => {
        if (dead) return;
        setWsDefault(r.defaultWorkspace ?? "");
        setWsRoots(r.knownReadRoots ?? []);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [tab]);
  const saveWorkspacePrefs = async (next: { defaultWorkspace?: string | null; knownReadRoots?: string[] }) => {
    setWsMsg("");
    const r = await window.lynn.rpc("workspace.savePrefs", next);
    if (!r.ok) {
      setWsMsg(r.error ?? "保存失败");
      return false;
    }
    setWsDefault(r.defaultWorkspace ?? "");
    setWsRoots(r.knownReadRoots ?? []);
    setWsMsg("已保存");
    return true;
  };

  // 截图能力：引擎是否可用 / 全局键是否真的注册上，都从壳层实况读，不写死"已启用"
  const [captureHotkey, setCaptureHotkey] = useState("Alt+Shift+S");
  const [captureState, setCaptureState] = useState<{ engine: boolean; registered: boolean; note: string } | null>(null);
  const [captureMsg, setCaptureMsg] = useState("");
  useEffect(() => {
    if (tab !== "look") return;
    let dead = false;
    void window.lynn
      .rpc("capture.status")
      .then((s) => {
        if (dead) return;
        setCaptureHotkey(s.hotkey || "Alt+Shift+S");
        setCaptureState({ engine: s.engine, registered: s.registered, note: s.note });
      })
      .catch(() => {
        /* 旧内核没有这个 RPC：输入框仍可用，不假装成功 */
      });
    return () => {
      dead = true;
    };
  }, [tab]);

  /** 改键走 config.prefs（内核落盘 + 壳层重注册）；稍后核对实况，占用时如实说「已保持原键」 */
  const applyCaptureHotkey = () => {
    const combo = captureHotkey.trim();
    onPrefs({ trayOnClose, notify, lang, captureHotkey: combo });
    setCaptureMsg(t("look.captureChecking"));
    setTimeout(() => {
      void window.lynn
        .rpc("capture.status")
        .then((s) => {
          setCaptureHotkey(s.hotkey || combo);
          setCaptureState({ engine: s.engine, registered: s.registered, note: s.note });
          setCaptureMsg(s.hotkey !== combo || !s.registered ? t("look.captureKept") : t("look.captureSaved"));
        })
        .catch(() => setCaptureMsg(t("look.captureUnknown")));
    }, 300);
  };

  const refreshPersona = async () => {
    try {
      const [g, v] = await Promise.all([
        window.lynn.rpc("persona.get"),
        window.lynn.rpc("persona.versions"),
      ]);
      setPersonaText(g.text ?? "");
      setPersonaVersions(Array.isArray(v.versions) ? v.versions : []);
    } catch {
      setPersonaMsg("读不到 persona（内核未连接？）");
    }
  };

  /** 语音播报（2026-11-13）：音色清单由主进程给，读不到就只留默认音色 + 自定义输入 */
  const [voiceOptions, setVoiceOptions] = useState<{ id: string; label: string; locale: string }[]>([
    { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声", locale: "zh-CN" },
  ]);
  const [customVoiceId, setCustomVoiceId] = useState("");
  const [proxyDraft, setProxyDraft] = useState(voiceProxy);
  const [voiceMsg, setVoiceMsg] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  type VoicePatch = Omit<Parameters<typeof onPrefs>[0], "trayOnClose" | "notify">;
  const refreshVoices = async () => {
    try {
      const r = await window.lynn.rpc("voice.voices");
      if (Array.isArray(r.voices) && r.voices.length) setVoiceOptions(r.voices);
    } catch {
      /* 旧内核没有这个 RPC：保留默认音色与自定义输入，不假装有很多可选 */
    }
  };
  const saveVoice = (patch: VoicePatch) => {
    onPrefs({ trayOnClose, notify, lang, ...patch });
    if (patch.voiceEnabled === false) void window.lynn.rpc("voice.stop");
  };
  const previewVoice = async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    setVoiceMsg(t("voice.previewing"));
    try {
      const r = await window.lynn.rpc("voice.preview", {
        text: t("voice.previewText"),
        voiceId,
        rate: voiceRate,
        volume: voiceVolume,
        proxy: proxyDraft,
      });
      setVoiceMsg(r.ok ? t("voice.previewOk") : `${t("voice.previewFailed")}${r.error ?? ""}`);
    } catch (err) {
      setVoiceMsg(`${t("voice.previewFailed")}${String(err)}`);
    } finally {
      setVoiceBusy(false);
    }
  };

  useEffect(() => {
    if (tab === "persona" && personaText === null) void refreshPersona();
    if (tab === "memory" && memText === null) void refreshMemory(memKind);
    if (tab === "skills") void refreshSkills();
    if (tab === "safety" && heartbeat === null) void refreshHeartbeat();
    if (tab === "look") void refreshVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [plugins, setPlugins] = useState<
    { id: string; name: string; version: string; tier: string; enabled: boolean; loadable: boolean; description?: string; slots?: string[]; view?: string }[]
  >([]);
  const [drafts, setDrafts] = useState<
    { draftId: string; title: string; kind: string; createdAt: string; status: string }[]
  >([]);
  /** 心跳巡检开关（M3-01）：null = 还没读到；开关走 config.prefs 即时生效 */
  const [heartbeat, setHeartbeat] = useState<boolean | null>(null);
  /** 顾问审阅开关（2026-11-14）：成员交回报后另一个模型独立审一遍 */
  const [advisor, setAdvisor] = useState<boolean | null>(null);
  const refreshHeartbeat = async () => {
    try {
      const r = await window.lynn.rpc("config.prefs", { autoStart });
      setHeartbeat(r.heartbeat);
      // 同一次调用顺带读顾问开关（都是 prefs，不用多打一次 RPC）
      setAdvisor(r.advisorEnabled ?? true);
    } catch {
      setHeartbeat(null);
    }
  };
  const toggleAdvisor = () => {
    const next = !(advisor ?? true);
    void window.lynn.rpc("config.prefs", { autoStart, advisorEnabled: next }).then((r) => {
      setAdvisor(r.advisorEnabled);
      setResult({ ok: true, text: r.advisorEnabled ? t("safety.advisorOn") : t("safety.advisorOff") });
    });
  };
  const toggleHeartbeat = () => {
    const next = !(heartbeat ?? true);
    void window.lynn.rpc("config.prefs", { autoStart, heartbeat: next }).then((r) => {
      setHeartbeat(r.heartbeat);
      setResult({ ok: true, text: r.heartbeat ? t("safety.heartbeatOn") : t("safety.heartbeatOff") });
    });
  };
  /** 技能管理（M2-10）：发现列表 + 启停（禁用落 prefs.disabledSkills） */
  const [skillRows, setSkillRows] = useState<
    { name: string; description: string; allowedTools: string[]; level: string; dir: string; disabled: boolean; warnings: string[] }[]
  >([]);
  const [skillErrors, setSkillErrors] = useState<string[]>([]);
  const refreshSkills = async () => {
    try {
      const r = await window.lynn.rpc("skills.list");
      setSkillRows(Array.isArray(r?.skills) ? r.skills : []);
      setSkillErrors(Array.isArray(r?.errors) ? r.errors : []);
    } catch {
      /* 无内核时忽略 */
    }
  };
  /** 会话记忆（M2-05）：两层（助理记忆可回滚 / 用户记忆永远保留），照 persona 页模式 */
  const [memKind, setMemKind] = useState<"memory" | "user">("memory");
  const [memText, setMemText] = useState<string | null>(null);
  const [memVersions, setMemVersions] = useState<{ id: string; savedAt: string; chars: number }[]>([]);
  const [memMsg, setMemMsg] = useState("");
  const refreshMemory = async (kind: "memory" | "user") => {
    try {
      const [g, v] = await Promise.all([
        window.lynn.rpc("memory.get", { kind }),
        window.lynn.rpc("memory.versions", { kind }),
      ]);
      setMemText(g.text ?? "");
      setMemVersions(Array.isArray(v.versions) ? v.versions : []);
      setMemMsg("");
    } catch {
      setMemText(null);
      setMemMsg("读不到记忆（内核未连接？）");
    }
  };
  const switchMemKind = (kind: "memory" | "user") => {
    setMemKind(kind);
    setMemText(null);
    void refreshMemory(kind);
  };
  const [themePlugins, setThemePlugins] = useState<
    {
      id: string;
      name: string;
      theme?: { dark?: Record<string, string>; light?: Record<string, string> };
      style?: string;
    }[]
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
      setPlugins(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          tier: p.tier,
          enabled: p.enabled,
          loadable: p.loadable,
          description: p.description,
          slots: p.slots,
          view: p.view,
        })),
      );
      setThemePlugins(list.filter((p) => p.theme).map((p) => ({ id: p.id, name: p.name, theme: p.theme, style: p.style })));
    } catch {
      /* 无内核时忽略 */
    }
    try {
      const w = await window.lynn.rpc("workshop.list");
      setDrafts(Array.isArray(w?.drafts) ? w.drafts : []);
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

  const refreshModels = async () => {
    try {
      const r = await window.lynn.rpc("model.list");
      setModels(r.models);
      setModelMeta({
        defaultModelId: r.defaultModelId,
        threadModelId: r.threadModelId,
        activeModelId: r.activeModelId,
        threadTitle: r.threadTitle,
        canEncrypt: r.canEncrypt !== false,
      });
    } catch (err) {
      setResult({ ok: false, text: `读取模型列表失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const refreshGateways = async () => {
    setGwBusy(true);
    try {
      const r = await window.lynn.rpc("gateway.list");
      setGateways(r.gateways);
    } catch {
      setGateways([]);
    } finally {
      setGwBusy(false);
    }
  };

  /** 打开模型页时拉一次列表（含当前对话的模型覆盖）+ 探测本机网关 */
  useEffect(() => {
    if (tab === "model") {
      void refreshModels();
      void refreshGateways();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const startEdit = (m?: ModelEntryView) => {
    setEditingId(m?.id ?? "new");
    setLabel(m?.label ?? "");
    setProvider(m?.provider ?? "DeepSeek");
    setBaseUrl(m?.baseUrl ?? "https://api.deepseek.com/v1");
    setModel(m?.model ?? "deepseek-chat");
    setApiKey("");
    setRiskAck(Boolean(m?.riskAccepted));
    setPlaintextAck(false);
    setDiscover({ open: false, busy: false, models: [], selected: new Set() });
    setResult(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setApiKey("");
    setRiskAck(false);
    setPlaintextAck(false);
    setDiscover({ open: false, busy: false, models: [], selected: new Set() });
    setResult(null);
  };

  const save = async () => {
    if (!provider.trim() || !baseUrl.trim() || !model.trim()) {
      setResult({ ok: false, text: "服务商、Base URL、模型都要填。" });
      return;
    }
    const isEdit = !!editingId && editingId !== "new";
    const target = isEdit ? models.find((m) => m.id === editingId) : undefined;
    if (!apiKey.trim() && !isEdit) {
      setResult({ ok: false, text: "新增模型必须填写这个端点的 API Key。" });
      return;
    }
    // 换端点还留空 Key = 把旧服务商的 Key 发到新端点（实机 401 Invalid token 的根因）
    const sameEndpoint =
      !!target && target.baseUrl.replace(/\/+$/, "").toLowerCase() === baseUrl.trim().replace(/\/+$/, "").toLowerCase();
    if (!apiKey.trim() && target && !sameEndpoint) {
      setResult({ ok: false, text: "换了 Base URL，请重新填写这个端点的 API Key（旧 Key 不会带到新服务商）。" });
      return;
    }
    const risk = endpointRiskLevel(baseUrl);
    const ack = riskAck || (sameEndpoint && Boolean(target?.riskAccepted));
    if (risk !== "remote" && !ack) {
      setResult({
        ok: false,
        text:
          risk === "local"
            ? "这是本机/局域网网关：可能复用第三方免费额度，prompt 可能被上游记录，且随时限流。请先勾选风险确认。"
            : "这个端点不是 HTTPS：Key 与内容会明文传输。请先勾选风险确认。",
      });
      return;
    }
    // 审计 #9：safeStorage 不可用时，明文落盘必须显式确认（内核同样会拦，这里先给友好提示）
    if (apiKey.trim() && !modelMeta.canEncrypt && !plaintextAck) {
      setResult({ ok: false, text: "本机不支持安全加密存储（系统密钥环不可用），API Key 将以明文写入磁盘。请先勾选「明文存储，我知晓风险」。" });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      const r = await window.lynn.rpc("model.save", {
        ...(isEdit ? { id: editingId! } : {}),
        label: label.trim() || provider.trim(),
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        ...(ack ? { riskAccepted: true } : {}),
        ...(plaintextAck ? { plaintextOk: true } : {}),
      });
      if (!r.ok) {
        setResult({ ok: false, text: r.error });
        return;
      }
      setResult({ ok: true, text: isEdit ? "已更新这条模型配置；下一条消息生效。" : "已添加模型，并设为新对话默认。" });
      setEditingId(null);
      setApiKey("");
      setRiskAck(false);
      await refreshModels();
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  /** 拉 /v1/models：不消耗 token；本机/非 HTTPS 必须先勾风险确认 */
  const runDiscover = async (override?: { baseUrl?: string; apiKey?: string; riskAccepted?: boolean; editingId?: string }) => {
    const url = (override?.baseUrl ?? baseUrl).trim();
    const key = (override?.apiKey ?? apiKey).trim();
    const ack = override?.riskAccepted ?? riskAck;
    const id = override?.editingId ?? editingId;
    if (!url) {
      setResult({ ok: false, text: "先填 Base URL。" });
      return;
    }
    const risk = endpointRiskLevel(url);
    if (risk !== "remote" && !ack) {
      setResult({
        ok: false,
        text:
          risk === "local"
            ? "这是本机/局域网网关：探测会把 Key 发给该端点，且可能复用第三方免费额度。请先勾选风险确认。"
            : "这个端点不是 HTTPS：探测会把 Key 明文发出去。请先勾选风险确认。",
      });
      return;
    }
    setDiscover({ open: true, busy: true, models: [], selected: new Set() });
    setResult(null);
    try {
      const r = await window.lynn.rpc("model.discover", {
        ...(id && id !== "new" ? { id } : {}),
        baseUrl: url,
        ...(key ? { apiKey: key } : {}),
        riskAccepted: ack,
      });
      if (!r.ok) {
        setDiscover({ open: true, busy: false, models: [], selected: new Set(), error: r.error });
        return;
      }
      setDiscover({
        open: true,
        busy: false,
        models: r.models.map((m) => ({ id: m.id, ownedBy: m.ownedBy })),
        selected: new Set(r.models.map((m) => m.id)),
      });
      setResult({ ok: true, text: `发现 ${r.models.length} 个模型，耗时 ${r.latencyMs}ms` });
    } catch (err) {
      setDiscover({
        open: true,
        busy: false,
        models: [],
        selected: new Set(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** 连接本机网关：填端点 +（无需 Key 的）占位 Key，并立刻发现模型；不启动第三方进程 */
  const connectGateway = async (g: GatewayView) => {
    const prevKey = apiKey.trim() === "local" ? "" : apiKey.trim();
    setEditingId("new");
    setLabel(g.name);
    setProvider(g.name);
    setBaseUrl(g.baseUrl);
    setModel("");
    setApiKey(g.needsKey ? prevKey : "local");
    setRiskAck(gwRiskAck);
    setDiscover({ open: false, busy: false, models: [], selected: new Set() });
    setResult(null);
    if (!gwRiskAck) {
      setResult({ ok: false, text: "本地/局域网网关可能复用第三方免费额度或记录 prompt；先勾选上面的风险确认。" });
      return;
    }
    if (g.needsKey) {
      if (prevKey) {
        await runDiscover({ baseUrl: g.baseUrl, apiKey: prevKey, riskAccepted: true, editingId: "new" });
        return;
      }
      setResult({
        ok: false,
        text: `端点已自动填入。把 ${g.name} 的本地 Key 粘到下方 API Key，再点一次「连接」就会自动发现模型（lynn 不读取其它应用的凭据文件）。`,
      });
      setTimeout(() => apiKeyRef.current?.focus(), 80);
      return;
    }
    await runDiscover({ baseUrl: g.baseUrl, apiKey: "local", riskAccepted: true, editingId: "new" });
  };

  const importDiscovered = async () => {
    const picked = discover.models.filter((m) => discover.selected.has(m.id));
    if (!picked.length) {
      setResult({ ok: false, text: "先选至少一个模型。" });
      return;
    }
    if (!apiKey.trim()) {
      setResult({ ok: false, text: "批量导入需要重新输入这个端点的 API Key（Key 不会跨条目复用）。" });
      return;
    }
    const risk = endpointRiskLevel(baseUrl);
    if (risk !== "remote" && !riskAck) {
      setResult({ ok: false, text: "本机/非 HTTPS 端点批量导入前要先勾选风险确认。" });
      return;
    }
    // 审计 #9：批量导入同样受明文确认约束
    if (apiKey.trim() && !modelMeta.canEncrypt && !plaintextAck) {
      setResult({ ok: false, text: "本机不支持安全加密存储（系统密钥环不可用），API Key 将以明文写入磁盘。请先勾选「明文存储，我知晓风险」。" });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      const host = (() => {
        try {
          return new URL(baseUrl).hostname;
        } catch {
          return provider.trim() || "自定义端点";
        }
      })();
      let n = 0;
      for (const m of picked) {
        const r = await window.lynn.rpc("model.save", {
          label: `${label.trim() || host} · ${m.id}`.slice(0, 40),
          provider: provider.trim() || host,
          baseUrl: baseUrl.trim(),
          model: m.id,
          apiKey: apiKey.trim(),
          riskAccepted: risk !== "remote" ? true : undefined,
          ...(plaintextAck ? { plaintextOk: true } : {}),
        });
        if (!r.ok) {
          setResult({ ok: false, text: `导入 ${m.id} 失败：${r.error}` });
          return;
        }
        n += 1;
      }
      setResult({ ok: true, text: `已导入 ${n} 个模型；新对话默认仍是原来那条。` });
      setDiscover({ open: false, busy: false, models: [], selected: new Set() });
      setEditingId(null);
      setApiKey("");
      setRiskAck(false);
      await refreshModels();
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const checkModelHealth = async (m: ModelEntryView) => {
    setHealth((h) => ({ ...h, [m.id]: { state: "checking", text: "检测中…" } }));
    try {
      const r = await window.lynn.rpc("model.health", { id: m.id });
      setHealth((h) => ({
        ...h,
        [m.id]: r.ok
          ? { state: "ok", text: `正常 ${r.latencyMs}ms${r.modelCount ? ` · ${r.modelCount} 模型` : ""}` }
          : { state: "bad", text: `失败：${r.error}` },
      }));
    } catch (err) {
      setHealth((h) => ({ ...h, [m.id]: { state: "bad", text: `失败：${err instanceof Error ? err.message : String(err)}` } }));
    }
  };

  const testConn = async () => {
    setBusy("test");
    setResult(null);
    try {
      const r = await window.lynn.rpc("model.test", {
        ...(editingId && editingId !== "new" ? { id: editingId } : {}),
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

  const actOnModel = async (action: "remove" | "setDefault" | "setThread", id: string | null) => {
    if (action === "remove" && !window.confirm("确定删除这条模型配置？本机保存的 Key 也会一起移除。")) return;
    setBusy("list");
    try {
      let r: { ok: boolean; error?: string };
      if (action === "remove") r = await window.lynn.rpc("model.remove", { id: id! });
      else if (action === "setDefault") r = await window.lynn.rpc("model.setDefault", { id: id! });
      else r = await window.lynn.rpc("model.setThread", { id });
      if (!r.ok) {
        setResult({ ok: false, text: r.error ?? "操作失败" });
        return;
      }
      const text = action === "remove" ? "已删除这条模型配置。"
        : action === "setDefault" ? "已设为新对话默认模型。"
          : id ? "已设为当前对话专用模型；下一条消息生效。" : "当前对话已改回跟随全局默认。";
      setResult({ ok: true, text });
      await refreshModels();
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
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

  // 自动化（定时任务）：列表/开关/删除都回读调度器，不在前端记假状态
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [autoMsg, setAutoMsg] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoName, setAutoName] = useState("");
  const [autoPrompt, setAutoPrompt] = useState("");
  const [autoKind, setAutoKind] = useState<"once" | "daily" | "interval">("daily");
  const [autoAt, setAutoAt] = useState("");
  const [autoTime, setAutoTime] = useState("09:00");
  const [autoEvery, setAutoEvery] = useState("60");

  // MCP 实况：配置里写了什么 + 实际连上没连上（可手动重连，改配置也会自动重连）
  const [mcp, setMcp] = useState<{ servers: McpRow[]; globalFile: string; projectFile: string; projectTrusted: boolean; errors?: string[] } | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  const applyMcpStatus = (r: { servers: McpRow[]; globalFile: string; projectFile: string; projectTrusted: boolean; errors?: string[] }) => {
    setMcp({ servers: r.servers, globalFile: r.globalFile, projectFile: r.projectFile, projectTrusted: r.projectTrusted, errors: r.errors });
  };

  const reloadMcp = async () => {
    setMcpBusy(true);
    try {
      // 重连要拉起子进程，是异步的：先拿回执，再轮询几次让面板跟上真实状态
      const r = await window.lynn.rpc("mcp.reload");
      applyMcpStatus(r);
      for (let i = 0; i < 8; i += 1) {
        await new Promise((res) => setTimeout(res, 700));
        const s = await window.lynn.rpc("mcp.status");
        applyMcpStatus(s);
        const settled = s.servers.every((x) => !x.enabled || x.connected || x.lazy);
        if (settled) break;
      }
    } catch (err) {
      setResult({ ok: false, text: `重连失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setMcpBusy(false);
    }
  };

  const refreshSchedules = async () => {
    try {
      const r = await window.lynn.rpc("schedule.list");
      setSchedules(r.tasks);
    } catch (err) {
      setSchedules([]);
      setAutoMsg(`读不到定时任务：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    if (tab === "auto") void refreshSchedules();
  }, [tab]);

  useEffect(() => {
    if (tab !== "plugins") return;
    let dead = false;
    void window.lynn
      .rpc("mcp.status")
      .then((r) => {
        if (!dead) setMcp(r);
      })
      .catch(() => {
        /* 旧内核没有这个接口：不假装有 */
      });
    return () => {
      dead = true;
    };
  }, [tab]);

  const addSchedule = async () => {
    if (!autoName.trim() || !autoPrompt.trim()) {
      setAutoMsg("名称和提示词都要填：提示词就是到点发给风铃的那句话。");
      return;
    }
    setAutoBusy(true);
    try {
      const base = { name: autoName.trim(), prompt: autoPrompt.trim() };
      const r =
        autoKind === "once"
          ? autoAt
            ? await window.lynn.rpc("schedule.add", { ...base, kind: "once", at: new Date(autoAt).toISOString() })
            : null
          : autoKind === "daily"
            ? await window.lynn.rpc("schedule.add", { ...base, kind: "daily", time: autoTime })
            : await window.lynn.rpc("schedule.add", {
                ...base,
                kind: "interval",
                intervalMin: Math.max(1, Number(autoEvery) || 60),
              });
      if (!r) {
        setAutoMsg("一次性任务要选一个执行时间。");
        return;
      }
      if (!r.ok) {
        setAutoMsg(r.error);
        return;
      }
      setAutoMsg(`已添加「${r.task.name}」，下次 ${r.task.nextRun ? fmtTime(r.task.nextRun) : "待调度"}`);
      setAutoName("");
      setAutoPrompt("");
      await refreshSchedules();
    } finally {
      setAutoBusy(false);
    }
  };

  const toggleSchedule = async (id: string) => {
    setAutoBusy(true);
    try {
      const r = await window.lynn.rpc("schedule.toggle", { id });
      setAutoMsg(r.ok ? (r.enabled ? "已启用。" : "已停用。") : r.error ?? "改不了状态");
      await refreshSchedules();
    } finally {
      setAutoBusy(false);
    }
  };

  const removeSchedule = async (id: string, name: string) => {
    setAutoBusy(true);
    try {
      const r = await window.lynn.rpc("schedule.remove", { id });
      setAutoMsg(r.ok ? `已删除「${name}」。` : "删除失败");
      await refreshSchedules();
    } finally {
      setAutoBusy(false);
    }
  };

  const page = useMemo(() => {
    if (tab === "auto") {
      const rows = schedules ?? [];
      const kindLabel = (k: string) => (k === "once" ? "一次性" : k === "daily" ? "每天" : "间隔");
      return (
        <div className="sf-pane">
          <h3>{t("auto.title")}</h3>
          <p className="sf-lede">{t("auto.lede")}</p>
          {autoMsg && <div className="sf-result ok">{autoMsg}</div>}
          {schedules === null && <p className="sf-empty">{t("auto.loading")}</p>}
          {schedules !== null && rows.length === 0 && <p className="sf-empty">{t("auto.empty")}</p>}
          {rows.length > 0 && (
            <div className="sf-group">
              <div className="sf-group-head">
                <b>{t("auto.listTitle")}</b>
                <small>{t("auto.listHint")}</small>
              </div>
              <div className="sf-list">
                {rows.map((s) => (
                  <div className="sf-row" key={s.id}>
                    <div className="sf-row-main">
                      <b>
                        {s.name}
                        <span className={`sf-badge ${s.enabled ? "ok" : "warn"}`}>
                          {s.enabled ? t("auto.on") : t("auto.off")}
                        </span>
                      </b>
                      <small>
                        {kindLabel(s.kind)}
                        {" · "}
                        {t("auto.next")} {s.nextRun ? fmtTime(s.nextRun) : "—"}
                      </small>
                      <small>
                        {t("auto.last")} {s.lastRun ? fmtTime(s.lastRun) : "—"}
                        {s.lastStatus ? ` · ${s.lastStatus}` : ""}
                      </small>
                    </div>
                    <div className="sf-inline">
                      <button type="button" className="sf-btn" disabled={autoBusy} onClick={() => void toggleSchedule(s.id)}>
                        {s.enabled ? t("auto.disable") : t("auto.enable")}
                      </button>
                      <button type="button" className="sf-btn" disabled={autoBusy} onClick={() => void removeSchedule(s.id, s.name)}>
                        {t("auto.remove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("auto.add")}</b>
              <small>{t("auto.addHint")}</small>
            </div>
            <label className="sf-field">
              <span className="sf-label">{t("auto.name")}</span>
              <input className="sf-input" value={autoName} onChange={(e) => setAutoName(e.target.value)} placeholder={t("auto.namePh")} />
            </label>
            <label className="sf-field">
              <span className="sf-label">{t("auto.prompt")}</span>
              <textarea
                className="sf-persona"
                style={{ minHeight: 110 }}
                value={autoPrompt}
                onChange={(e) => setAutoPrompt(e.target.value)}
                placeholder={t("auto.promptPh")}
              />
            </label>
            <div className="sf-inline">
              <select className="sf-input" value={autoKind} onChange={(e) => setAutoKind(e.target.value as typeof autoKind)}>
                <option value="daily">{t("auto.kindDaily")}</option>
                <option value="interval">{t("auto.kindInterval")}</option>
                <option value="once">{t("auto.kindOnce")}</option>
              </select>
              {autoKind === "daily" && (
                <input className="sf-input" type="time" value={autoTime} onChange={(e) => setAutoTime(e.target.value)} />
              )}
              {autoKind === "interval" && (
                <input
                  className="sf-input"
                  type="number"
                  min={1}
                  value={autoEvery}
                  onChange={(e) => setAutoEvery(e.target.value)}
                  placeholder="60"
                  style={{ width: 100 }}
                />
              )}
              {autoKind === "once" && (
                <input className="sf-input" type="datetime-local" value={autoAt} onChange={(e) => setAutoAt(e.target.value)} />
              )}
              <button type="button" className="sf-btn primary" disabled={autoBusy} onClick={() => void addSchedule()}>
                {t("auto.submit")}
              </button>
            </div>
            <small className="sf-hint">{t("auto.kindHint")}</small>
          </div>
        </div>
      );
    }

    if (tab === "team") {
      const list = teams ?? [];
      const bad = /失败|不能|先|空/.test(teamMsg);
      return (
        <div className="sf-pane">
          <h3>{t("team.title")}</h3>
          <p className="sf-lede">{t("team.lede")}</p>
          {teamMsg && <div className={`sf-result ${bad ? "bad" : "ok"}`}>{teamMsg}</div>}
          {teamStale && (
            <div className="sf-actions">
              <button type="button" className="sf-btn primary" onClick={() => void window.lynn.rpc("app.restart")}>
                {t("team.restart")}
              </button>
            </div>
          )}
          {teams === null && <p className="sf-empty">{t("team.loading")}</p>}
          {teams !== null && list.length === 0 && <p className="sf-empty">{t("team.empty")}</p>}

          {list.map((tm) => (
            <div className="sf-group team-block" key={tm.id}>
              <div className="team-h">
                <b>{tm.name}</b>
                <span className={`sf-badge ${tm.status === "active" ? "ok" : "warn"}`}>
                  {tm.status === "active" ? t("team.active") : t("team.dissolved")}
                </span>
                <span className="team-id mono">{tm.id}</span>
                {tm.status === "active" && (
                  <button
                    type="button"
                    className="sf-btn"
                    disabled={teamBusy}
                    onClick={() => {
                      const key = `dissolve:${tm.id}`;
                      if (teamPending !== key) {
                        setTeamPending(key);
                        setTeamMsg(t("team.dissolveConfirm"));
                        return;
                      }
                      void dissolveTeam(tm.id, tm.name);
                    }}
                  >
                    {teamPending === `dissolve:${tm.id}` ? t("team.confirm") : t("team.dissolve")}
                  </button>
                )}
              </div>

              {tm.members.length === 0 && <p className="sf-empty">{t("team.noMembers")}</p>}

              {tm.members.map((m) => {
                const editing = editingMember && editingMember.teamId === tm.id && editingMember.name === m.name;
                if (editing && editingMember) {
                  return (
                    <div className="team-edit" key={m.name}>
                      <div className="sf-grid2">
                        <label className="sf-field">
                          <span className="sf-label">{t("team.role")}</span>
                          <input
                            className="sf-input"
                            value={editingMember.role}
                            onChange={(e) => setEditingMember({ ...editingMember, role: e.target.value })}
                          />
                        </label>
                        <label className="sf-field">
                          <span className="sf-label">{t("team.goal")}</span>
                          <input
                            className="sf-input"
                            value={editingMember.goal}
                            onChange={(e) => setEditingMember({ ...editingMember, goal: e.target.value })}
                          />
                        </label>
                      </div>
                      <label className="sf-field">
                        <span className="sf-label">{t("team.prompt")}</span>
                        <textarea
                          className="sf-persona team-prompt"
                          value={editingMember.body}
                          onChange={(e) => setEditingMember({ ...editingMember, body: e.target.value })}
                        />
                        <small className="sf-hint">{t("team.promptHint")}</small>
                      </label>
                      <div className="sf-actions">
                        <button type="button" className="sf-btn primary" disabled={teamBusy} onClick={() => void saveMember()}>
                          {t("common.save")}
                        </button>
                        <button type="button" className="sf-btn" onClick={() => setEditingMember(null)}>
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  );
                }
                const key = `remove:${tm.id}:${m.name}`;
                const avKey = `${tm.id}:${m.name}`;
                const currentAvatar = (avatarById(m.avatarId) ?? avatarFor(m.name)).id;
                return (
                  <div className="team-member" key={m.name}>
                    <div className="sf-row">
                      <button
                        type="button"
                        className="team-av-btn"
                        title="换头像底色"
                        disabled={teamBusy || tm.status !== "active"}
                        onClick={() => setAvatarPick(avatarPick === avKey ? null : avKey)}
                      >
                        <MemberAvatar name={m.name} avatarId={m.avatarId} size={34} />
                      </button>
                      <div className="sf-row-main">
                        <b>
                          {m.name}
                          <span className="sf-badge ok">{m.role}</span>
                        </b>
                        <small>{m.goal}</small>
                        <small className="mono">{m.tools.length ? m.tools.join(" · ") : t("team.noTools")}</small>
                      </div>
                      <div className="sf-inline">
                        <button
                          type="button"
                          className="sf-btn"
                          disabled={teamBusy || tm.status !== "active"}
                          onClick={() => {
                            setTeamMsg("");
                            setTeamPending("");
                            setEditingMember({ teamId: tm.id, name: m.name, role: m.role, goal: m.goal, body: m.body });
                          }}
                        >
                          {t("team.edit")}
                        </button>
                        <button
                          type="button"
                          className="sf-btn"
                          disabled={teamBusy || tm.status !== "active"}
                          onClick={() => {
                            if (teamPending !== key) {
                              setTeamPending(key);
                              setTeamMsg(t("team.removeConfirm"));
                              return;
                            }
                            void removeMember(tm.id, m.name);
                          }}
                        >
                          {teamPending === key ? t("team.confirm") : t("team.remove")}
                        </button>
                      </div>
                    </div>
                    {avatarPick === avKey && (
                      <div className="team-av-pick" role="group" aria-label={`${m.name} 的头像`}>
                        {/* 12 个槽位各是一款画风（2026-11-13）：选的是"哪张脸"，不是底色 */}
                        {AVATARS.map((a) => (
                          <button
                            type="button"
                            key={a.id}
                            className={`team-av-opt${a.id === currentAvatar ? " on" : ""}`}
                            title={`${a.label}（${a.style} 画风）`}
                            disabled={teamBusy}
                            onClick={() => void chooseAvatar(tm.id, m.name, a.id)}
                          >
                            <MemberAvatar name={m.name} avatarId={a.id} size={40} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      );
    }

    if (tab === "model") {
      const active = models.find((m) => m.id === modelMeta.activeModelId);
      const risk = endpointRiskLevel(baseUrl);
      const riskNeedsAck = risk !== "remote";
      return (
        <div className="sf-pane">
          <h3>{t("model.title")}</h3>
          <p className="sf-lede">{t("model.lede")}</p>
          <div className="sf-hint">
            当前对话「{modelMeta.threadTitle}」使用：<b>{active?.label ?? "未配置模型"}</b>
            （{modelMeta.threadModelId ? "本对话指定" : "跟随全局默认"}）
          </div>

          <div className="sf-group">
            <div className="sf-group-head">
              <b>本地 / 免费模型</b>
              <small>只探测本机端口，不自动启动第三方进程；点「连接」自动填端点并拉模型列表</small>
            </div>
            <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={gwRiskAck} onChange={(e) => setGwRiskAck(e.target.checked)} style={{ marginTop: 3 }} />
              <span className="sf-hint">
                我了解：本机/局域网网关可能复用第三方免费额度、prompt 可能被上游记录，且随时限流或下线；只会在非敏感数据上使用。
              </span>
            </label>
            <div className="sf-list">
              {gateways.length === 0 && (
                <p className="sf-empty">{gwBusy ? "正在探测本机网关…" : "没有探测到本机网关；启动 Ollama / LM Studio / OFM 后点「重新检测」。"}</p>
              )}
              {gateways.map((g) => (
                <div className="sf-row" key={g.id}>
                  <div className="sf-row-main">
                    <b>{g.name}</b>
                    <small className="mono">{g.baseUrl}</small>
                    <small>
                      {g.status === "running"
                        ? `运行中 · ${g.modelCount ?? 0} 个模型 · ${g.latencyMs ?? 0}ms`
                        : g.status === "needs_key"
                          ? "运行中 · 需要该网关的本地 Key"
                          : `未检测到${g.error ? ` · ${g.error.slice(0, 80)}` : ""}`}
                    </small>
                    <small>{g.note}</small>
                  </div>
                  <div className="sf-inline">
                    <button type="button" className="sf-btn" onClick={() => void refreshGateways()} disabled={gwBusy}>
                      重新检测
                    </button>
                    <button type="button" className="sf-btn primary" onClick={() => void connectGateway(g)} disabled={gwBusy || g.status === "down"}>
                      连接
                    </button>
                    <button
                      type="button"
                      className="sf-btn"
                      onClick={() => void window.lynn.rpc("app.openExternal", { url: g.docsUrl })}
                    >
                      说明
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {gwBusy && <p className="sf-hint">正在探测本机常见端口（127.0.0.1），不会发外网请求。</p>}
          </div>

          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("model.libTitle")}</b>
              <small>{t("model.libHint")}</small>
            </div>
            {models.length === 0 ? (
              <p className="sf-empty">还没有配置模型。点「新增模型」填一条；每条的 Key 都单独加密存本机。</p>
            ) : (
              <div className="sf-list">
                {models.map((m) => (
                  <div className="sf-row" key={m.id}>
                    <div className="sf-row-main">
                      <b>{m.label}</b>
                      <small className="mono">{m.provider} · {m.model}</small>
                      <small>{m.baseUrl}</small>
                      <small>
                        {m.isDefault ? "新对话默认" : ""}
                        {m.isDefault && m.isThreadModel ? " · " : ""}
                        {m.isThreadModel ? "本对话专用" : ""}
                        {!m.apiKeySet ? " · 未设置 Key" : ""}
                        {m.riskLevel === "local" ? " · 本机/局域网" : m.riskLevel === "insecure" ? " · 非 HTTPS" : " · 远程"}
                        {m.riskLevel !== "remote" && !m.riskAccepted ? " · 未确认风险" : ""}
                      </small>
                      {health[m.id] && (
                        <small style={{ color: health[m.id].state === "ok" ? "var(--blue)" : health[m.id].state === "bad" ? "var(--red)" : "var(--ink-4)" }}>
                          {health[m.id].text}
                        </small>
                      )}
                    </div>
                    <div className="sf-inline">
                      <button type="button" className="sf-btn" onClick={() => void checkModelHealth(m)} disabled={busy !== ""}>
                        检测
                      </button>
                      <button type="button" className="sf-btn" onClick={() => startEdit(m)} disabled={busy !== ""}>编辑</button>
                      <button type="button" className="sf-btn" onClick={() => void actOnModel("setDefault", m.id)} disabled={busy !== "" || m.isDefault}>
                        设为默认
                      </button>
                      <button type="button" className="sf-btn" onClick={() => void actOnModel("setThread", m.isThreadModel ? null : m.id)} disabled={busy !== ""}>
                        {m.isThreadModel ? "取消本对话专用" : "用于本对话"}
                      </button>
                      <button type="button" className="sf-btn" onClick={() => void actOnModel("remove", m.id)} disabled={busy !== ""}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {editingId === null && (
              <div className="sf-actions">
                <button type="button" className="sf-btn primary" onClick={() => startEdit()}>新增模型</button>
                {modelMeta.threadModelId && (
                  <button type="button" className="sf-btn" onClick={() => void actOnModel("setThread", null)} disabled={busy !== ""}>
                    本对话改回跟随全局默认
                  </button>
                )}
              </div>
            )}
          </div>

          {editingId !== null && (
            <div className="sf-group">
              <div className="sf-group-head">
                <b>{editingId === "new" ? "新增模型" : "编辑模型"}</b>
                <small>{t("model.editHint")}</small>
              </div>
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
                  <span className="sf-label">名称（自己认得就行）</span>
                  <input className="sf-input" value={label} placeholder={provider || "我的模型"} onChange={(e) => setLabel(e.target.value)} />
                </label>
                <label className="sf-field">
                  <span className="sf-label">{t("model.provider")}</span>
                  <input className="sf-input" value={provider} onChange={(e) => setProvider(e.target.value)} />
                </label>
              </div>
              <div className="sf-grid2">
                <label className="sf-field">
                  <span className="sf-label">Base URL</span>
                  <input className="sf-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </label>
                <label className="sf-field">
                  <span className="sf-label">{t("model.model")}</span>
                  <input className="sf-input" value={model} onChange={(e) => setModel(e.target.value)} />
                </label>
              </div>
              <label className="sf-field">
                <span className="sf-label">API Key</span>
                <input
                  ref={apiKeyRef}
                  className="sf-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editingId === "new" ? "sk-…" : t("model.keySaved")}
                />
                <small className="sf-hint">{t("model.keyHint")}；换 Base URL 必须重填。</small>
              </label>
              {riskNeedsAck && (
                <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={riskAck}
                    onChange={(e) => setRiskAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span className="sf-hint">
                    {risk === "local"
                      ? "我了解：这是本机/局域网网关，可能复用第三方免费额度，prompt 可能被上游记录，且随时限流或下线；只会在非敏感数据上使用。"
                      : "我了解：这个端点不是 HTTPS，API Key 与内容会明文传输；只会在可信网络里使用。"}
                  </span>
                </label>
              )}
              {/* 审计 #9：safeStorage 不可用（系统密钥环缺失）时，明文落盘必须显式确认 */}
              {!modelMeta.canEncrypt && (
                <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={plaintextAck}
                    onChange={(e) => setPlaintextAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span className="sf-hint">
                    明文存储，我知晓风险：本机不支持安全加密存储（系统密钥环不可用），API Key 将以**明文**写入 settings.json。
                  </span>
                </label>
              )}
              <div className="sf-actions">
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() => void runDiscover()}
                  disabled={busy !== "" || !baseUrl.trim() || (riskNeedsAck && !riskAck)}
                >
                  {discover.busy ? "发现中…" : "发现模型"}
                </button>
                <button
                  type="button"
                  className="sf-btn"
                  onClick={() => void testConn()}
                  disabled={busy !== "" || (editingId === "new" && !apiKey.trim())}
                >
                  {busy === "test" ? t("model.testing") : t("model.test")}
                </button>
                <button type="button" className="sf-btn primary" onClick={() => void save()} disabled={busy !== ""}>
                  {busy === "save" ? t("model.saving") : t("common.save")}
                </button>
                <button type="button" className="sf-btn" onClick={cancelEdit} disabled={busy !== ""}>取消</button>
              </div>
            </div>
          )}
          {discover.open && (
            <div className="sf-group">
              <div className="sf-group-head">
                <b>发现模型</b>
                <small>GET /v1/models，不消耗 token；勾选后批量导入，Key 只加密存本机</small>
              </div>
              {discover.busy && <p className="sf-empty">正在读取模型列表…</p>}
              {discover.error && (
                <p className="sf-hint" style={{ color: "var(--red)", margin: "4px 0" }}>
                  {discover.error}
                </p>
              )}
              {!discover.busy && discover.models.length > 0 && (
                <>
                  <div className="sf-actions">
                    <button
                      type="button"
                      className="sf-btn"
                      onClick={() => setDiscover((d) => ({ ...d, selected: new Set(d.models.map((m) => m.id)) }))}
                    >
                      全选
                    </button>
                    <button type="button" className="sf-btn" onClick={() => setDiscover((d) => ({ ...d, selected: new Set() }))}>
                      清空
                    </button>
                    <span className="sf-note">
                      已选 {discover.selected.size} / {discover.models.length}
                    </span>
                  </div>
                  <div className="sf-list" style={{ maxHeight: 220, overflowY: "auto" }}>
                    {discover.models.map((m) => (
                      <label className="sf-row" key={m.id} style={{ cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={discover.selected.has(m.id)}
                          onChange={(e) => {
                            const on = e.target.checked;
                            setDiscover((d) => {
                              const s = new Set(d.selected);
                              if (on) s.add(m.id);
                              else s.delete(m.id);
                              return { ...d, selected: s };
                            });
                          }}
                        />
                        <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {m.id}
                        </span>
                        {m.ownedBy && <small>{m.ownedBy}</small>}
                      </label>
                    ))}
                  </div>
                  <div className="sf-actions">
                    <button type="button" className="sf-btn primary" onClick={() => void importDiscovered()} disabled={busy !== ""}>
                      导入选中
                    </button>
                    <button type="button" className="sf-btn" onClick={() => setDiscover((d) => ({ ...d, open: false }))}>
                      关闭
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
        </div>
      );
    }

    if (tab === "persona") {
      return (
        <div className="sf-pane">
          <h3>{t("persona.title")}</h3>
          <p className="sf-lede">{t("persona.lede")}</p>
          {personaText === null ? (
            <p className="sf-empty">{personaMsg || t("persona.loading")}</p>
          ) : (
            <>
              <div className="sf-group">
                <div className="sf-group-head">
                  <b>{t("persona.editTitle")}</b>
                  <small>{t("persona.hint")}</small>
                </div>
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
              </div>
              {personaVersions.length > 0 && (
                <div className="sf-group">
                  <div className="sf-group-head">
                    <b>{t("persona.versions")}</b>
                    <small>{t("persona.verHint")}</small>
                  </div>
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
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    if (tab === "memory") {
      return (
        <div className="sf-pane">
          <h3>{t("memory.title")}</h3>
          <p className="sf-lede">{t("memory.lede")}</p>
          {memText === null ? (
            <p className="sf-empty">{memMsg || t("persona.loading")}</p>
          ) : (
            <>
              <div className="sf-group">
                <div className="sf-group-head">
                  <b>{t("memory.editTitle")}</b>
                  <small>{t("memory.hint")}</small>
                </div>
                <div className="sf-inline">
                  <button type="button" className={`sf-btn${memKind === "memory" ? " primary" : ""}`} onClick={() => switchMemKind("memory")}>
                    {t("memory.kindMemory")}
                  </button>
                  <button type="button" className={`sf-btn${memKind === "user" ? " primary" : ""}`} onClick={() => switchMemKind("user")}>
                    {t("memory.kindUser")}
                  </button>
                </div>
                <textarea
                  className="sf-persona"
                  rows={14}
                  value={memText}
                  onChange={(e) => setMemText(e.target.value)}
                  spellCheck={false}
                />
                <div className="sf-actions">
                  <button
                    type="button"
                    className="sf-btn primary"
                    onClick={() => {
                      void window.lynn.rpc("memory.save", { kind: memKind, text: memText }).then((r) => {
                        setMemMsg(r.hot ? t("persona.savedHot") : t("persona.savedNext"));
                        void window.lynn.rpc("memory.versions", { kind: memKind }).then((v) => setMemVersions(Array.isArray(v.versions) ? v.versions : []));
                      });
                    }}
                  >
                    {t("persona.save")}
                  </button>
                  <button
                    type="button"
                    className="sf-btn"
                    onClick={() => void refreshMemory(memKind)}
                  >
                    {t("persona.discard")}
                  </button>
                </div>
                {memMsg && <div className="sf-hint">{memMsg}</div>}
              </div>
              {memVersions.length > 0 && (
                <div className="sf-group">
                  <div className="sf-group-head">
                    <b>{t("persona.versions")}</b>
                    <small>{t("memory.verHint")}</small>
                  </div>
                  <div className="sf-list">
                    {memVersions.map((v) => (
                      <div className="sf-row" key={v.id}>
                        <div className="sf-row-main">
                          <span className="mono">{new Date(v.savedAt).toLocaleString()}</span>
                          <span className="sf-row-sub">{t("persona.chars", { n: v.chars })}</span>
                        </div>
                        <button
                          type="button"
                          className="sf-btn"
                          onClick={() => {
                            void window.lynn.rpc("memory.rollback", { kind: memKind, versionId: v.id }).then((r) => {
                              setMemText(r.text);
                              setMemMsg(r.hot ? t("persona.rollbackHot") : t("persona.rollbackNext"));
                            });
                          }}
                        >
                          {t("persona.rollback")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    if (tab === "skills") {
      return (
        <div className="sf-pane">
          <h3>{t("skills.title")}</h3>
          <p className="sf-lede">{t("skills.lede")}</p>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("skills.listTitle")}</b>
              <small>{t("skills.listHint")}</small>
            </div>
            {skillRows.length === 0 ? (
              <p className="sf-empty">{t("skills.empty")}</p>
            ) : (
              <div className="sf-list">
                {skillRows.map((s) => (
                  <div className="sf-row" key={`${s.level}:${s.name}`}>
                    <div className="sf-row-main">
                      <b>
                        {s.name}
                        {s.disabled && <span className="sf-badge warn">{t("skills.off")}</span>}
                      </b>
                      <small title={s.dir}>{s.description || t("skills.noDesc")}</small>
                      <small className="mono">
                        {s.allowedTools.length ? s.allowedTools.join("、") : t("skills.noTools")}
                      </small>
                    </div>
                    <button
                      type="button"
                      className={`sf-btn${s.disabled ? "" : " primary"}`}
                      title={s.disabled ? t("skills.onHint") : t("skills.offHint")}
                      onClick={() =>
                        void window.lynn.rpc("skills.toggle", { name: s.name, enabled: s.disabled }).then(() => refreshSkills())
                      }
                    >
                      {s.disabled ? t("common.enable") : t("plugins.disable")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {skillErrors.length > 0 && <div className="sf-result bad">{skillErrors.join("；")}</div>}
          </div>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
        </div>
      );
    }

    if (tab === "plugins") {
      // 徽章用人能读的词：贡献了什么就是什么（主题/界面/工具/外接命令），tier 原码进悬停提示
      const kindOf = (p: { theme?: unknown; style?: string; slots?: string[]; view?: string; tier: string }): { label: string; title: string } => {
        if (p.theme || p.style) return { label: t("plugins.kindTheme"), title: `L0 · ${p.tier}` };
        if ((p.slots?.length ?? 0) > 0 || p.view) return { label: t("plugins.kindView"), title: `L0 · ${p.tier}` };
        if (p.tier === "L1") return { label: t("plugins.kindTool"), title: "L1" };
        if (p.tier === "L2") return { label: t("plugins.kindCmd"), title: "L2" };
        return { label: t("plugins.kindDeclarative"), title: p.tier };
      };
      // 界面卡槽区去重：已在「已安装」列表里的不再重复出现（此前同一插件以同一名字出现三处）
      const slotOnly = uiPlugins.filter((u) => !plugins.some((p) => p.id === u.id));
      return (
        <div className="sf-pane">
          <h3>{t("plugins.title")}</h3>
          <p className="sf-lede">{t("plugins.lede")}</p>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("plugins.installedTitle")}</b>
              <small>
                {t("plugins.marketHint")}
                {" · "}
                {t("plugins.fingerprint")} <span className="mono">{setStatus?.fingerprint.slice(0, 12) ?? "—"}</span> ·{" "}
                {t("plugins.count", { n: setStatus?.count ?? 0 })}
                {setStatus?.safeMode ? ` · ${t("plugins.safeMode", { reason: setStatus.safeModeReason ?? "…" })}` : ""}
              </small>
            </div>
            {setStatus?.safeMode && (
              <div className="sf-actions" style={{ padding: "0 0 8px" }}>
                <button
                  type="button"
                  className="sf-btn"
                  title={t("plugins.exitSafeMode")}
                  onClick={() =>
                    void window.lynn
                      .rpc("plugins.safeMode", { on: false })
                      .then(() => refreshPlugins())
                      .then(() => setResult({ ok: true, text: t("plugins.exitSafeModeOk") }))
                  }
                >
                  {t("plugins.exitSafeMode")}
                </button>
              </div>
            )}
            <div className="sf-group-body">
              {/* 类型徽章：把 L0/L1/L2 翻译成人能读的词（主题/界面/工具/外接命令），tier 原码进悬停 */}
          {plugins.length === 0 ? (
            <p className="sf-empty">{t("plugins.empty")}</p>
          ) : (
            <div className="sf-market">
              {plugins.map((p) => {
                const kind = kindOf(p);
                return (
                <div className="sf-market-card" key={p.id}>
                  <div className="sf-market-head">
                    <b title={p.id}>{p.name}</b>
                    <span className="sf-badge" title={kind.title}>{kind.label}</span>
                  </div>
                  <small title={p.description || p.id}>{p.description || p.id}</small>
                  <small className="mono">
                    {p.id} · v{p.version}
                    {p.slots?.includes("stage.console") ? ` · ${t("plugins.slotConsole")}` : ""}
                  </small>
                  <div className="sf-market-actions">
                    <button
                      type="button"
                      className={`sf-btn${p.enabled ? " primary" : ""}`}
                      onClick={() =>
                        void window.lynn
                          .rpc("plugins.toggle", { id: p.id, enabled: !p.enabled })
                          .then(() => {
                            refreshPlugins();
                            // 卡槽（含 stage.console）跟着启停变化走同一条广播
                            window.dispatchEvent(new Event("lynn:ui-plugins"));
                          })
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
                </div>
                );
              })}
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
            </div>
          </div>
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
                          {d.status === "draft" ? t("workshop.statusDraft") : d.status === "reviewed" ? t("workshop.statusReviewed") : t("workshop.statusEnabled")}
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
                            setResult({ ok: true, text: t("workshop.promoteOk", { id: r.id }) });
                            void refreshPlugins();
                          } else {
                            setResult({ ok: false, text: (r as { error?: string }).error ?? t("workshop.promoteFail") });
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
                          setResult({ ok: true, text: t("workshop.discardOk") });
                          void refreshPlugins();
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
          {/* MCP：配置文件里写了几台、实际连上几台，都在这里看；改完保存即重连 */}
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("mcp.title")}</b>
              <small>
                {t("mcp.hint")} <span className="mono">{mcp?.globalFile ?? "~/.lynn/mcp.json"}</span>
                {" · "}
                {t("mcp.liveHint")}
              </small>
            </div>
            <div className="sf-actions">
              <button type="button" className="sf-btn" disabled={mcpBusy} onClick={() => void reloadMcp()}>
                {mcpBusy ? t("mcp.reloading") : t("mcp.reload")}
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

          {/* 界面扩展：主题插件一键应用 + U 档卡槽（第三方 iframe 沙箱） */}
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("plugins.uiExtTitle")}</b>
              <small>{t("plugins.uiExtHint")}</small>
            </div>
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
                    <button type="button" className={`sf-btn${uiDisabled.includes(p.id) ? "" : " primary"}`} onClick={() => toggleUi(p.id)}>
                      {uiDisabled.includes(p.id) ? t("common.enable") : t("plugins.disable")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {uiErrors.length > 0 && <div className="sf-result bad">{uiErrors.join("；")}</div>}
            </div>
          </div>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
        </div>
      );
    }

    if (tab === "safety") {
      return (
        <div className="sf-pane">
          <h3>{t("safety.title")}</h3>
          <p className="sf-lede">{t("safety.lede")}</p>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("safety.execTitle")}</b>
              <small>{t("safety.execHint")}</small>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("safety.contractTitle")}</b>
                <small>{t("safety.contractHint")}</small>
              </div>
              <div className="sf-inline">
                <button type="button" className={`sf-btn${autoStart ? "" : " primary"}`} onClick={() => onAutoStart(false)}>
                  {t("safety.alwaysAsk")}
                </button>
                <button type="button" className={`sf-btn${autoStart ? " primary" : ""}`} onClick={() => onAutoStart(true)}>
                  {t("safety.autoStart")}
                </button>
              </div>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("safety.heartbeatTitle")}</b>
                <small>{t("safety.heartbeatHint")}</small>
              </div>
              <button type="button" className={`sf-btn${heartbeat === false ? "" : " primary"}`} onClick={toggleHeartbeat}>
                {heartbeat === false ? t("common.enable") : t("plugins.disable")}
              </button>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("safety.advisorTitle")}</b>
                <small>{t("safety.advisorHint")}</small>
              </div>
              <button type="button" className={`sf-btn${advisor === false ? "" : " primary"}`} onClick={toggleAdvisor}>
                {advisor === false ? t("common.enable") : t("plugins.disable")}
              </button>
            </div>
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("safety.trustTitle")}</b>
              <small>{t("safety.permHint")}</small>
            </div>
            {/* 2026-11-13：只有目录里真有"被信任才生效"的东西，信任才是件需要决定的事 */}
            {(() => {
              const gated = !!(project?.gated?.mcp || project?.gated?.skills);
              return (
            <div className="sf-row">
              <div className="sf-row-main">
                <b>
                  {t("safety.project")}
                  <span className={`sf-badge ${project?.trusted || !gated ? "ok" : "warn"}`}>
                    {project?.trusted ? t("safety.trusted") : gated ? t("safety.untrusted") : t("safety.trustNoop")}
                  </span>
                </b>
                <small className="mono">{project?.root ?? "—"}</small>
                <small>{project?.hasMcp ? t("safety.hasMcp") : t("safety.noMcp")}</small>
              </div>
              {gated ? (
                <button type="button" className="sf-btn" onClick={() => onTrust?.(!project?.trusted)}>
                  {project?.trusted ? t("safety.untrust") : t("safety.trust")}
                </button>
              ) : (
                <span className="sf-badge ok">{t("safety.trustNoop")}</span>
              )}
            </div>
              );
            })()}
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("safety.boundaryTitle")}</b>
              <small>{t("safety.isolationHint")}</small>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("safety.dataLabel")}</b>
                <small>{t("safety.dataHint")}</small>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (tab === "look") {
      return (
        <div className="sf-pane">
          <h3>{t("look.title")}</h3>
          <p className="sf-lede">{t("look.lede")}</p>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("look.groupTheme")}</b>
              <small>{t("look.languageHint")}</small>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("look.language")}</b>
              </div>
              <div className="sf-inline">
                <button type="button" className={`sf-btn${lang === "zh" ? " primary" : ""}`} onClick={() => onPrefs({ trayOnClose, notify, lang: "zh" })}>
                  {t("lang.zh")}
                </button>
                <button type="button" className={`sf-btn${lang === "en" ? " primary" : ""}`} onClick={() => onPrefs({ trayOnClose, notify, lang: "en" })}>
                  {t("lang.en")}
                </button>
              </div>
            </div>
            <div className="sf-sub" style={{ padding: "10px 0 6px" }}>
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
              <div className="sf-inline" style={{ padding: "8px 0 6px" }}>
                <button type="button" className={`sf-btn${mode === "dark" ? " primary" : ""}`} onClick={() => onTheme(theme, "dark")}>
                  {t("look.modeDark")}
                </button>
                <button type="button" className={`sf-btn${mode === "light" ? " primary" : ""}`} onClick={() => onTheme(theme, "light")}>
                  {t("look.modeLight")}
                </button>
              </div>
            </div>
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("look.groupAvatar")}</b>
              <small>{t("look.groupAvatarHint")}</small>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("look.ambient")}</b>
              </div>
              <div className="sf-inline">
                {(["full", "low", "off"] as AmbientMode[]).map((m) => (
                  <button type="button" key={m} className={`sf-btn${ambientMode === m ? " primary" : ""}`} onClick={() => onAmbient(m)}>
                    {AMBIENT_MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
            <div className="sf-sub" style={{ padding: "10px 0 6px" }}>
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
            </div>
            {avatar && <AvatarStage state={avState} onState={setAvState} bubble={BUBBLE[avState]} height={200} />}
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("look.presence")}</b>
              <small>{t("look.presenceHint")}</small>
            </div>
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
          <div className="sf-row">
            <div className="sf-row-main">
              <b>{t("look.captureTitle")}</b>
              <small>{t("look.captureHint")}</small>
              <small className="mono">{captureState ? captureState.note : t("look.captureUnknown")}</small>
            </div>
            <div className="sf-inline">
              <input
                className="sf-input"
                style={{ width: 150 }}
                value={captureHotkey}
                aria-label={t("look.captureTitle")}
                onChange={(e) => setCaptureHotkey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCaptureHotkey();
                }}
              />
              <button type="button" className="sf-btn" onClick={applyCaptureHotkey}>
                {t("look.captureApply")}
              </button>
            </div>
          </div>
          {captureMsg && <p className="sf-result">{captureMsg}</p>}
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("look.voice")}</b>
              <small>{t("look.voiceHint")}</small>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.enabled")}</b>
                <small>{t("voice.enabledHint")}</small>
              </div>
              <button
                type="button"
                className={`sf-btn${voiceEnabled ? " primary" : ""}`}
                onClick={() => saveVoice({ voiceEnabled: !voiceEnabled })}
              >
                {voiceEnabled ? t("common.on") : t("common.off")}
              </button>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.timbre")}</b>
                <small className="mono">{voiceId}</small>
              </div>
              <select
                className="sf-input"
                style={{ width: 200 }}
                aria-label={t("voice.timbre")}
                value={voiceOptions.some((v) => v.id === voiceId) ? voiceId : "__custom__"}
                onChange={(e) => {
                  if (e.target.value === "__custom__") setCustomVoiceId(voiceId);
                  else saveVoice({ voiceId: e.target.value });
                }}
              >
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
                <option value="__custom__">{t("voice.custom")}</option>
              </select>
            </div>
            {!voiceOptions.some((v) => v.id === voiceId) && (
              <div className="sf-row">
                <div className="sf-row-main"><b>{t("voice.custom")}</b></div>
                <div className="sf-inline">
                  <input
                    className="sf-input"
                    style={{ width: 200 }}
                    aria-label={t("voice.custom")}
                    value={customVoiceId}
                    onChange={(e) => setCustomVoiceId(e.target.value)}
                  />
                  <button type="button" className="sf-btn" onClick={() => saveVoice({ voiceId: customVoiceId.trim() })}>
                    {t("voice.customApply")}
                  </button>
                </div>
              </div>
            )}
            <div className="sf-sub" style={{ padding: "10px 0 6px" }}>
              <span className="sf-label">{t("voice.prosody")}</span>
              <div className="sf-inline">
                <select className="sf-input" aria-label={t("voice.rate")} value={voiceRate} onChange={(e) => saveVoice({ voiceRate: e.target.value })}>
                  <option value="-10%">{t("voice.rateSlow")}</option>
                  <option value="+0%">{t("voice.rateNormal")}</option>
                  <option value="+10%">{t("voice.rateFast")}</option>
                  <option value="+20%">{t("voice.rateFaster")}</option>
                </select>
                <select className="sf-input" aria-label={t("voice.volume")} value={voiceVolume} onChange={(e) => saveVoice({ voiceVolume: e.target.value })}>
                  <option value="-30%">{t("voice.volumeLow")}</option>
                  <option value="+0%">{t("voice.volumeNormal")}</option>
                  <option value="+20%">{t("voice.volumeHigh")}</option>
                </select>
                <input
                  className="sf-input"
                  style={{ width: 80 }}
                  type="number"
                  min={30}
                  max={300}
                  aria-label={t("voice.maxChars")}
                  title={t("voice.maxChars")}
                  value={voiceMaxChars}
                  onChange={(e) => saveVoice({ voiceMaxChars: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.scope")}</b>
                <small>{t("voice.scopeHint")}</small>
              </div>
              <select className="sf-input" aria-label={t("voice.scope")} value={voiceScope} onChange={(e) => saveVoice({ voiceScope: e.target.value as "brief" | "detail" })}>
                <option value="brief">{t("voice.scopeBrief")}</option>
                <option value="detail">{t("voice.scopeDetail")}</option>
              </select>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.hidden")}</b>
                <small>{t("voice.hiddenHint")}</small>
              </div>
              <button
                type="button"
                className={`sf-btn${voiceWhenHidden ? " primary" : ""}`}
                onClick={() => saveVoice({ voiceWhenHidden: !voiceWhenHidden })}
              >
                {voiceWhenHidden ? t("common.on") : t("common.off")}
              </button>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.proxy")}</b>
                <small>{t("voice.proxyHint")}</small>
              </div>
              <div className="sf-inline">
                <input
                  className="sf-input"
                  style={{ width: 160 }}
                  aria-label={t("voice.proxy")}
                  placeholder="http://127.0.0.1:7890"
                  value={proxyDraft}
                  onChange={(e) => setProxyDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveVoice({ voiceProxy: proxyDraft.trim() }); }}
                />
                <button type="button" className="sf-btn" onClick={() => saveVoice({ voiceProxy: proxyDraft.trim() })}>
                  {t("voice.proxyApply")}
                </button>
              </div>
            </div>
            <div className="sf-row">
              <div className="sf-row-main">
                <b>{t("voice.preview")}</b>
                <small>{t("voice.privacy")}</small>
              </div>
              <button type="button" className="sf-btn" disabled={voiceBusy} onClick={() => void previewVoice()}>
                {voiceBusy ? t("voice.previewing") : t("voice.preview")}
              </button>
            </div>
            {voiceMsg && <p className="sf-result">{voiceMsg}</p>}
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
          <p className="sf-lede">{t("data.lede")}</p>

          {/* 工作区（2026-11-10）：默认主根 + 常用只读根；只读根对所有成员长期开放 */}
          <div className="sf-group">
            <div className="sf-group-head">
              <b>工作区</b>
              <small>新会话与无会话发消息的落点；常用只读根对成员长期开放（只读，写仍限任务工作区）</small>
            </div>
            <div className="sf-row">
              <label className="sf-field" style={{ flex: 1 }}>
                <span className="sf-label">默认工作区</span>
                <input
                  className="sf-input"
                  value={wsDefault}
                  placeholder="留空 = 自动（~/LynnWorkspace）"
                  onChange={(e) => setWsDefault(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="sf-btn"
                onClick={() => {
                  void window.lynn.rpc("app.pickDir", { title: "选择默认工作区" }).then((r) => {
                    if (r.path) setWsDefault(r.path);
                  });
                }}
              >
                选目录…
              </button>
              <button type="button" className="sf-btn" onClick={() => setWsDefault("")}>
                清除
              </button>
            </div>

            <div className="sf-row">
              <span className="sf-label" style={{ flex: 1 }}>
                常用只读根（{wsRoots.length}）
              </span>
              <button
                type="button"
                className="sf-btn"
                onClick={() => {
                  void window.lynn
                    .rpc("app.pickDirs", { title: "选择常用只读目录（可多选）" })
                    .then((r) => {
                      const paths = r.paths ?? [];
                      if (!paths.length) return;
                      const isDrive = (p: string) => /^[a-zA-Z]:[\\/]?$/.test(p);
                      const drives = paths.filter(isDrive);
                      if (drives.length && !window.confirm(`将把整个磁盘作为只读根：${drives.join("、")}。继续？`)) return;
                      setWsRoots((prev) => [...new Set([...prev, ...paths])]);
                    });
                }}
              >
                添加目录…
              </button>
            </div>
            {wsRoots.length === 0 && <div className="sf-note" style={{ padding: "2px 0 6px" }}>还没有常用只读根。</div>}
            {wsRoots.map((p) => (
              <div className="sf-row" key={p}>
                <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={p}>
                  {p}
                </span>
                <button type="button" className="sf-btn" onClick={() => setWsRoots((prev) => prev.filter((x) => x !== p))}>
                  移除
                </button>
              </div>
            ))}
            <div className="sf-actions">
              <button
                type="button"
                className="sf-btn primary"
                onClick={() => void saveWorkspacePrefs({ defaultWorkspace: wsDefault.trim() || null, knownReadRoots: wsRoots })}
              >
                保存工作区设置
              </button>
              {wsMsg && <span className="sf-note">{wsMsg}</span>}
            </div>
          </div>

          <div className="sf-group">
            <div className="sf-group-head">
              <b>存储与清理</b>
              <small>只清过程文件（scratch / 检查点 / 旧日志）；交付物永久保留</small>
            </div>
            {dataUsage ? (
              <>
                <div className="sf-row">
                  <span className="sf-label" style={{ flex: 1 }}>
                    总占用
                  </span>
                  <span className="mono">{fmtBytes(dataUsage.totalBytes)}</span>
                </div>
                <div className="sf-row">
                  <span className="sf-label" style={{ flex: 1 }}>
                    任务（过程 / 证据 / 沙箱）
                  </span>
                  <span className="mono">
                    {fmtBytes(dataUsage.scratchBytes)} / {fmtBytes(dataUsage.artifactsBytes)} /{" "}
                    {fmtBytes(dataUsage.sandboxBytes)}
                  </span>
                </div>
                <div className="sf-row">
                  <span className="sf-label" style={{ flex: 1 }}>
                    日志 / 检查点
                  </span>
                  <span className="mono">
                    {fmtBytes(dataUsage.logsBytes)} / {fmtBytes(dataUsage.checkpointsBytes)}
                  </span>
                </div>
              </>
            ) : (
              <div className="sf-note" style={{ padding: "2px 0 6px" }}>
                正在统计…
              </div>
            )}
            <div className="sf-actions">
              <button
                type="button"
                className="sf-btn"
                onClick={() => {
                  setDataMsg("");
                  void window.lynn
                    .rpc("data.cleanup", {})
                    .then((r) => {
                      setDataMsg(`已清理 ${r.removed} 项，释放 ${fmtBytes(r.freedBytes)}`);
                      refreshUsage();
                    })
                    .catch(() => setDataMsg("清理失败"));
                }}
              >
                清理过程文件
              </button>
              <span className="sf-note">沙箱工作区（完整代码树）不自动删，避免误删产物；需要时在工单里手动删除。</span>
              {dataMsg && <span className="sf-note">{dataMsg}</span>}
            </div>
          </div>

          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("data.groupVersion")}</b>
              <small>{t("data.groupVersionHint")}</small>
            </div>
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
          </div>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("data.pack")}</b>
              <small>{t("data.packHint")}</small>
            </div>
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
        <p className="sf-lede">{t("overview.lede")}</p>
        <div className="sf-group">
          <div className="sf-group-head">
            <b>{t("overview.todoTitle")}</b>
            <small>{t("overview.todoHint")}</small>
          </div>
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
        </div>
        <div className="sf-group">
          <div className="sf-group-head">
            <b>{t("overview.crewTitle")}</b>
            <small>{t("overview.crewHint")}</small>
          </div>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>{t("overview.crew", { n: members.length })}</b>
              <small>{members.length === 0 ? t("overview.crewEmpty") : members.map((m) => m.name).join("、")}</small>
            </div>
          </div>
        </div>
      </div>
    );
  }, [
    tab,
    teams,
    teamMsg,
    teamBusy,
    teamStale,
    editingMember,
    teamPending,
    schedules,
    autoMsg,
    autoBusy,
    autoName,
    autoPrompt,
    autoKind,
    autoAt,
    autoTime,
    autoEvery,
    mcp,
    mcpBusy,
    provider,
    baseUrl,
    model,
    apiKey,
    label,
    editingId,
    models,
    modelMeta,
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
    onApplyPluginStyle,
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
            {NAV_GROUPS.map((g) => (
              <div key={g.capKey}>
                <div className="sf-nav-cap">{t(g.capKey)}</div>
                {g.items.map((n) => (
                  <button type="button" key={n.k} className={`sf-nav-item${tab === n.k ? " on" : ""}`} onClick={() => setTab(n.k)}>
                    <Icon name={n.icon} size="sm" />
                    {t(n.labelKey)}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sf-body">{page}</div>
        </div>
      </div>
    </div>
  );
}
