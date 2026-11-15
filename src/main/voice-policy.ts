import type { FeedCard } from "../shared/contract";

/**
 * 风铃的「嘴」——只负责决定**该不该说、说什么**，不负责怎么合成与播放。
 *
 * 设计红线（用户 2026-11-13）：所有播出去的内容都是给用户听的，必须有效、有意义。
 *
 * 关于「值台 / 控制台」：两者共用同一份内核 feed、同一份快照、同一份 settings.json
 * 偏好；区别只在呈现层（值台是 feed 全字段投影，控制台是易失的事件增量归约，
 * 切走即清空、丢字段）。播报在内核落卡时判定，App 根只订阅一次 onVoice，
 * 所以**档位与视图无关**：切视图不会重播、漏播，也不该按视图分叉。
 * 下面说的「留在界面」= 值台与控制台都能看到文字，只是不念出来。
 *
 * 两档：
 *  - brief（简洁，默认）：结论 / 进度节点 / 需要行动 / 提醒 / 异常。
 *  - detail（详细）：brief 全部 + 过程卡的中文短句（组队/派单/工具/出站/
 *    放行/拦截/记忆/停止/心跳）+ 她正文的分析结论；过程卡一律不念原始 body，
 *    不念工单 ID、命令、路径、思考块、Markdown 证据。
 */

export type VoiceScope = "brief" | "detail";

export interface VoicePrefs {
  /** 总开关：关掉后一条都不合成，也不发网络请求 */
  voiceEnabled: boolean;
  /** Edge 神经音色 ID，默认 zh-CN-XiaoxiaoNeural（晓晓） */
  voiceId: string;
  /** 语速：Edge prosody 格式，如 "+0%" / "+10%" */
  voiceRate: string;
  /** 音量：Edge prosody 格式，如 "+0%" / "-20%" */
  voiceVolume: string;
  /** 播报档位：brief=简洁（默认） / detail=详细（多念过程短句与她的分析） */
  voiceScope: VoiceScope;
  /** 单条播报最大字数：超了截到句子边界，不硬念长文 */
  voiceMaxChars: number;
  /** 主窗口不可见时是否仍播（默认否：人不在就不念） */
  voiceWhenHidden: boolean;
  /** 可选 HTTP 代理（node-edge-tts 原生支持），空串=直连 */
  voiceProxy: string;
}

export const DEFAULT_VOICE_ID = "zh-CN-XiaoxiaoNeural";

export const VOICE_DEFAULT_PREFS: VoicePrefs = {
  voiceEnabled: true,
  voiceId: DEFAULT_VOICE_ID,
  voiceRate: "+0%",
  voiceVolume: "+0%",
  voiceScope: "brief",
  voiceMaxChars: 120,
  voiceWhenHidden: false,
  voiceProxy: "",
};

export interface VoiceOption {
  id: string;
  label: string;
  locale: string;
}

/** 常用中文神经音色；服务端音色会变，所以 UI 仍允许手填任意 ID。 */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声", locale: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 活泼女声", locale: "zh-CN" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 少年男声", locale: "zh-CN" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 沉稳男声", locale: "zh-CN" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 播报男声", locale: "zh-CN" },
  { id: "zh-CN-YunxiaNeural", label: "云夏 · 轻快男声", locale: "zh-CN" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 东北女声", locale: "zh-CN" },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 陕西女声", locale: "zh-CN" },
  { id: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾女声", locale: "zh-TW" },
  { id: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语女声", locale: "zh-HK" },
];

export const VOICE_RATES = ["-10%", "+0%", "+10%", "+20%"] as const;
export const VOICE_VOLUMES = ["-30%", "+0%", "+20%"] as const;
export const VOICE_SCOPES: VoiceScope[] = ["brief", "detail"];

/** 上一版有 key / all / alerts 三档，读旧 settings.json 时统一回落到简洁。 */
const LEGACY_SCOPES: Record<string, VoiceScope> = { key: "brief", all: "brief", alerts: "brief" };

export function normalizeScope(v: unknown): VoiceScope {
  if (v === "brief" || v === "detail") return v;
  if (typeof v === "string" && LEGACY_SCOPES[v]) return LEGACY_SCOPES[v];
  return VOICE_DEFAULT_PREFS.voiceScope;
}

/** 只允许安全字符，避免用户手填的音色 ID 被拼进 SSML 或 URL。 */
export function isValidVoiceId(id: string): boolean {
  return /^[A-Za-z0-9-]{4,64}$/.test(id);
}

export function isProsody(v: string): boolean {
  return /^[+-]\d{1,3}%$/.test(v);
}

/** 从配置（可能来自旧版本 settings.json 或前端）收敛出完整、合法的语音偏好。 */
export function normalizeVoicePrefs(raw: Partial<VoicePrefs> | undefined): VoicePrefs {
  const p = raw ?? {};
  return {
    voiceEnabled: p.voiceEnabled === undefined ? VOICE_DEFAULT_PREFS.voiceEnabled : Boolean(p.voiceEnabled),
    voiceId: isValidVoiceId(String(p.voiceId ?? "")) ? String(p.voiceId) : DEFAULT_VOICE_ID,
    voiceRate: isProsody(String(p.voiceRate ?? "")) ? String(p.voiceRate) : VOICE_DEFAULT_PREFS.voiceRate,
    voiceVolume: isProsody(String(p.voiceVolume ?? "")) ? String(p.voiceVolume) : VOICE_DEFAULT_PREFS.voiceVolume,
    voiceScope: normalizeScope(p.voiceScope),
    voiceMaxChars: Math.max(30, Math.min(300, Number(p.voiceMaxChars) || VOICE_DEFAULT_PREFS.voiceMaxChars)),
    voiceWhenHidden: Boolean(p.voiceWhenHidden),
    voiceProxy: typeof p.voiceProxy === "string" ? p.voiceProxy.trim().slice(0, 200) : "",
  };
}

export type SpeechCard = Pick<FeedCard, "kind"> & Partial<Omit<FeedCard, "kind">>;

export interface SpeechCandidate {
  text: string;
  /** low = 详细模式的过程短句：不排队、不打断、强节流，防止工具流把耳朵淹没 */
  priority: "high" | "normal" | "low";
  /** 来源标签：用于同轮去重与日志，不播给用户 */
  reason:
    | "report" | "decision" | "reminder" | "delivery" | "progress" | "review" | "problem" | "reply" | "preview"
    | "team" | "dispatch" | "tool" | "outbound" | "allow" | "block" | "memory" | "stopped" | "heartbeat";
}

/**
 * 播报是风铃本人在对用户说话：模板里的自述一律第一人称「我」，
 * 不出现「她 / 风铃」这种旁白口吻。模型自己写的汇报结论与正文保持原样，不篡改她的措辞。
 */
export const SELF = "我";

const FILLER_RE = /^(?:好的|收到|明白|了解|嗯|是的|已完成|已处理|已呈上|已转呈|汇报已呈给用户|问题已转呈用户|等待回答|已记录|已完成汇报|这张单已处理|没有产出文字)[。.!！,，\s]*$/;

/** 至少要有能听懂的实词；纯符号、纯 ID、工具回执一律不播。 */
export function isMeaningfulSpeech(text: string): boolean {
  const s = String(text ?? "").trim();
  if (s.length < 4) return false;
  if (FILLER_RE.test(s)) return false;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  // 注意：JS 的 \W 把汉字也算「非单词字符」，不能用它判「纯符号」
  if (cjk < 2 && latin < 4) return false;
  return true;
}

/**
 * Markdown → 能听的话：去代码块 / 链接 / 表格 / 段标签 / 路径与 ID，
 * 把换行变停顿，最后截到句子边界（不硬切半个词，也不追加"详见…"之类的废话）。
 */
export function cleanSpeechText(raw: string, maxChars = 120): string {
  let s = String(raw ?? "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  s = s.replace(/^\s*\|[-:\s|]+\|\s*$/gm, " ");
  s = s.replace(/^\s*[>\-*+]\s+/gm, "");
  s = s.replace(/\*\*|__|~~/g, "");
  s = s.replace(/^\s*(?:结论|证据|未完成|待你拍板|等你拍板|产物|交付物|材料|简报)[：:]\s*/gm, "");
  s = s.replace(/[A-Za-z]:[\\/][^\s，。；、）)]+/g, " ");
  s = s.replace(/\b[\w./\\-]+\.(?:md|json|csv|tsx?|jsx?|mjs|cjs|docx|xlsx|pptx|pdf|png|jpe?g|log)\b/gi, " ");
  // 工单/任务内部编号（task-20261115-a1b2c3）：念出来是噪音，用户不记这些
  s = s.replace(/\b[\w]*-\d{6,}[\w-]*/g, " ");
  s = s.replace(/\b(?:[0-9a-f]{8,}|[0-9a-f-]{16,})\b/gi, " ");
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, "。");
  s = s.replace(/\n/g, "，");
  s = s.replace(/([，。；、！？])\1+/g, "$1");
  // Markdown 块被抹掉后常留下「， ，」这种空停顿，念出来像结巴
  s = s.replace(/([，。；、！？])(?:\s*[，。；、！？])+/g, "$1");
  s = s.replace(/^[，。；、\s]+/, "").trim();
  const limit = Math.max(10, maxChars);
  if (s.length > limit) {
    const cut = s.slice(0, limit);
    const stops = [cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("；")];
    const last = Math.max(...stops);
    s = last >= Math.floor(limit * 0.5) ? cut.slice(0, last + 1) : cut;
  }
  return s.trim().replace(/[，、；\s]+$/, "");
}

function firstSentence(text: string): string {
  const line = String(text ?? "").split(/\n/).find((l) => l.trim()) ?? "";
  const m = line.match(/^[^。！？.!?]{1,200}[。！？.!?]?/);
  return m ? m[0] : line;
}

function labeledLines(body: string, labels: string[]): string {
  const picked: string[] = [];
  for (const line of String(body ?? "").split(/\n/)) {
    const m = line.match(/^\s*(结论|待你拍板|等你拍板)[：:]\s*(.+)$/);
    if (m && labels.includes(m[1]) && m[2].trim()) picked.push(m[2].trim());
  }
  return picked.join("。");
}

function memberOf(title: string | undefined): string {
  const head = String(title ?? "").split(/[·|]/)[0].trim().replace(/(?:回报|已停止|开工|没交出回报|执行崩溃)$/, "").trim();
  return head.length > 0 && head.length <= 12 && !/^[A-Za-z0-9-]{8,}$/.test(head) ? head : "";
}

function candidate(text: string, priority: SpeechCandidate["priority"], reason: SpeechCandidate["reason"]): SpeechCandidate | null {
  const s = text.trim();
  return isMeaningfulSpeech(s) ? { text: s, priority, reason } : null;
}

/**
 * 详细模式专属：把过程卡改写成**固定中文短句**。
 *
 * 依据是全仓过程卡字段盘点：title 里只有成员名 / 中文岗位 / 中文任务名可安全念，
 * body 里是命令、工作区路径、只读根、工具清单、原始 err.message、步骤明细，
 * 一律不取。thinking（内部推理）更是从来不播。
 */
function detailSpeech(card: SpeechCard, badge: string): SpeechCandidate | null {
  const who = memberOf(card.title);
  switch (badge) {
    case "组队": {
      const m = String(card.title ?? "").match(/^招募\s*(.+?)\s*[·|]\s*(.+)$/);
      return candidate(
        m ? `${SELF}已组建小组，${cleanSpeechText(m[1], 12)}负责${cleanSpeechText(m[2], 20)}。` : `${SELF}已组建执行小组。`,
        "low", "team",
      );
    }
    case "工具": {
      // 只念有中文语义的工具卡（技能激活 / 预算提示 / 已退出安全模式）；
      // 纯英文工具名、插件 ID、失败堆栈一律跳过
      const title = cleanSpeechText(card.title ?? "", 50).replace(/\s*·\s*/g, "，");
      const cjk = (title.match(/[\u4e00-\u9fff]/g) ?? []).length;
      if (cjk < 4 || /失败|错误|堆栈|[A-Za-z]{3,}\.[A-Za-z]/.test(title)) return null;
      return candidate(`${title}。`, "low", "tool");
    }
    case "出站":
      return candidate("有一次外部请求已审计。", "low", "outbound");
    case "放行":
      return candidate("低风险操作已自动放行。", "low", "allow");
    case "已拦截":
      return candidate("有一条命令被拦下，详情看卡片。", "normal", "block");
    case "记忆":
      return candidate(`${SELF}记下了一件事。`, "low", "memory");
    case "已停止":
      return candidate(who ? `${who}已停止。` : "有成员已停止。", "low", "stopped");
    case "心跳": {
      const m = String(card.text ?? "").match(/(\d+)\s*张单/);
      return candidate(m ? `巡检发现 ${m[1]} 张单待处理，${SELF}已开始跟进。` : `巡检发现有待处理的工单，${SELF}已开始跟进。`, "low", "heartbeat");
    }
    default:
      return null;
  }
}

/**
 * 卡片 → 播报候选。返回 null 表示「只在界面上留下文字，不播」。
 *
 * 两档都播：汇报（只结论+待拍板）、需要你拍板、提醒、成员回报、进度里程碑、
 *           审查结论、未完成 / 崩溃。
 * 仅详细档播：过程卡短句（见 detailSpeech）。
 * 永不播：user 卡、流式 lynn 卡、thinking、系统内务（压缩/额度/重建/随附/
 *         历史回放）、命令、路径、工单 ID、Markdown 证据清单。
 */
export function pickCardSpeech(card: SpeechCard, prefs: VoicePrefs): SpeechCandidate | null {
  if (!prefs.voiceEnabled) return null;
  const badge = card.badge ?? "";
  const limit = prefs.voiceMaxChars;
  /** 这张卡的主体是谁（成员名）：`阿明 开工 · task-x` → 阿明；取不到就是空 */
  const who = memberOf(card.title);

  if (card.kind === "user" || card.kind === "lynn") return null;

  if (badge === "提醒") {
    const raw = [card.title, card.meta, card.text].filter(Boolean).join("，");
    return candidate(cleanSpeechText(raw, Math.min(limit, 80)), "normal", "reminder");
  }

  // system 卡绝大多数是内务状态，只放行拍板、异常与**进度**。
  // 「进度」必须进来（2026-11-15）：卡住 / 无交付物关单这三张卡都是 system+进度，
  // 此前被这一行整类拦掉——开着语音也听不到任务停了，这是"进度播报"最大的一个洞。
  const systemAllowed = ["需要你拍板", "崩溃", "未完成", "进度"];
  if (prefs.voiceScope === "detail") systemAllowed.push("心跳");
  if (card.kind === "system" && !systemAllowed.includes(badge)) return null;

  switch (badge) {
    case "汇报": {
      const r = card.report;
      let raw = r ? [r.conclusion, r.decision].filter((x) => x && x.trim()).join("。") : "";
      if (!raw && card.body) raw = labeledLines(card.body, ["结论", "待你拍板", "等你拍板"]);
      if (!raw) raw = firstSentence(card.body ?? card.title ?? "");
      return candidate(cleanSpeechText(raw, limit), "high", "report");
    }
    case "需要你拍板": {
      let title = cleanSpeechText(card.title ?? "", 60);
      // 任务契约卡的标题只有工单 ID，念 ID 没有意义，改成人话
      if (!isMeaningfulSpeech(title) || title.length < 6 || /^待你确认/.test(card.title ?? "")) {
        title = "有一件事等你拍板，详情看卡片";
      }
      const extra = card.body ? cleanSpeechText(firstSentence(card.body), Math.max(20, limit - title.length - 1)) : "";
      const text = extra && extra !== title ? `${title}。${extra}` : title;
      return candidate(text, "high", "decision");
    }
    case "回报": {
      const member = memberOf(card.title);
      return candidate(member ? `${member}交回了结果，等${SELF}验收。` : `成员交回了结果，等${SELF}验收。`, "normal", "delivery");
    }
    case "派单":
      // 开工本身就是第一个进度节点：默认档就要听见"派给谁了"，
      // 否则耳朵里的第一条进度永远是"交回了结果"，中间发生了什么一无所知。
      return candidate(who ? `${SELF}已把任务派给${who}，开始处理。` : `${SELF}已派单，开始处理。`, "normal", "dispatch");
    case "进度": {
      const raw = cleanSpeechText(card.title || card.text || "", Math.min(limit, 80));
      // 里程碑卡：`阿计 第 3 步 · task-x` → `阿计已推进到第 3 步。`
      const m = raw.match(/^(.+?)\s*第\s*(\d+)\s*步/);
      if (m) return candidate(`${m[1].trim()}已推进到第 ${m[2]} 步。`, "normal", "progress");
      // 系统进度卡（卡住 / 没有交付物关单）：正文是给眼睛看的长句，这里只念一句结论
      const note = String(card.text ?? card.title ?? "");
      if (/卡住/.test(note)) return candidate("有一张单卡住了，我先判断是重做还是收尾。", "normal", "progress");
      if (/没有任何交付物|未完成|已关单/.test(note)) {
        return candidate("有一张单没交出交付物，我先收尾了。", "normal", "progress");
      }
      return candidate(raw, "normal", "progress");
    }
    case "审查": {
      const raw = cleanSpeechText([card.title, firstSentence(card.body ?? "")].filter(Boolean).join("，"), Math.min(limit, 60));
      return candidate(raw, "normal", "review");
    }
    case "未完成":
    case "崩溃": {
      const raw = cleanSpeechText([card.title, card.text].filter(Boolean).join("，"), Math.min(limit, 60));
      return candidate(raw, "high", "problem");
    }
    default:
      return prefs.voiceScope === "detail" ? detailSpeech(card, badge) : null;
  }
}

/** 去掉「好的，」「我来分析一下。」这类开场引导句，避免详细模式念一句废话。 */
function dropPreamble(text: string): string {
  return String(text ?? "").replace(
    /^\s*(?:好的|收到|明白|嗯|我来|我先|让我|接下来|首先)[，,、]?\s*[^。！？\n]{0,30}[。！？\n]\s*/,
    "",
  );
}

/**
 * 收轮时的助手正文（她写在卡片上的分析/结论）：只有详细档、且是用户回合才播。
 * 取 `FeedCard.text`，**不取 `thinking`**（内部推理、默认折叠、可能极长且复读）。
 */
export function pickReplySpeech(text: string, prefs: VoicePrefs, internal: boolean): SpeechCandidate | null {
  if (!prefs.voiceEnabled || internal || prefs.voiceScope !== "detail") return null;
  const cleaned = cleanSpeechText(dropPreamble(text), Math.min(prefs.voiceMaxChars, 100));
  if (!isMeaningfulSpeech(cleaned)) return null;
  return { text: cleaned, priority: "normal", reason: "reply" };
}

export interface VoiceGateState {
  lastText: string;
  lastAt: number;
  lastReportAt: number;
  lastLowReason: string;
  lastLowAt: number;
}

export const VOICE_GATE_INITIAL: VoiceGateState = {
  lastText: "", lastAt: 0, lastReportAt: 0, lastLowReason: "", lastLowAt: 0,
};

const MIN_GAP_MS = 4_000;
const DEDUPE_MS = 60_000;
const SAME_TURN_MS = 20_000;
const MAX_QUEUE = 3;
/** 过程短句：最小 8 秒一条、同类 25 秒一条、永不排队补播 */
const LOW_GAP_MS = 8_000;
const LOW_SAME_REASON_MS = 25_000;

export interface GateResult {
  ok: boolean;
  interrupt: boolean;
  why?: string;
  next: VoiceGateState;
}

/** 去重 / 节流 / 同轮抑制 / 队列上限：宁可少播，不补播过期内容。 */
export function gateSpeech(c: SpeechCandidate, state: VoiceGateState, now: number, queued: number): GateResult {
  const next = { ...state };
  const deny = (why: string): GateResult => ({ ok: false, interrupt: false, why, next });
  // 同一轮里汇报卡已经把结论说了，别再念一遍她的收尾白话
  if (c.reason === "reply" && now - state.lastReportAt < SAME_TURN_MS) return deny("same-turn-report");
  if (c.text === state.lastText && now - state.lastAt < DEDUPE_MS) return deny("duplicate");
  if (c.priority === "low") {
    if (queued > 0) return deny("low-no-queue");
    if (now - state.lastAt < LOW_GAP_MS) return deny("low-throttled");
    if (c.reason === state.lastLowReason && now - state.lastLowAt < LOW_SAME_REASON_MS) return deny("low-same-reason");
    next.lastLowReason = c.reason;
    next.lastLowAt = now;
  }
  if (queued >= MAX_QUEUE && c.priority !== "high") return deny("queue-full");
  const gap = now - state.lastAt;
  if (gap < MIN_GAP_MS) {
    if (c.priority !== "high") return deny("throttled");
    next.lastText = c.text;
    next.lastAt = now;
    if (c.reason === "report") next.lastReportAt = now;
    return { ok: true, interrupt: true, next };
  }
  next.lastText = c.text;
  next.lastAt = now;
  if (c.reason === "report" || c.reason === "decision") next.lastReportAt = now;
  return { ok: true, interrupt: false, next };
}

/** 内核只认这个端口，不认具体 TTS 实现（与 setNotifier 同款注入）。 */
export interface VoicePort {
  sayCard(card: SpeechCard): void;
  sayReply(text: string, internal: boolean): void;
  stop(): void;
}
