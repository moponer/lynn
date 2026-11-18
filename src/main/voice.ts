import { EdgeTTS } from "node-edge-tts";
import type { VoicePlayEvent } from "../shared/contract";
import {
  gateSpeech,
  normalizeVoicePrefs,
  pickCardSpeech,
  pickReplySpeech,
  cleanSpeechText,
  VOICE_GATE_INITIAL,
  VOICE_OPTIONS,
  type SpeechCandidate,
  type SpeechCard,
  type VoiceGateState,
  type VoicePrefs,
} from "./voice-policy";

/**
 * 语音服务（壳层）：Edge Read Aloud 在线合成 → MP3 → data URL → 渲染层播放。
 *
 * 依赖 node-edge-tts（MIT，同源 Edge TTS 协议，内置 Sec-MS-GEC v2 认证）。
 * 与 rany2/edge-tts 用的是同一服务端与同一套音色 ID，但不要求用户装 Python。
 *
 * 纪律：合成失败只记日志、如实返回错误，不阻塞任何业务链路，也不假装播过。
 */

export interface VoiceServiceOptions {
  getPrefs: () => VoicePrefs;
  emit: (ev: VoicePlayEvent) => void;
  isVisible: () => boolean;
  /** 合成实现（默认走 EdgeTTS）；测试可注入假实现，验证退避/熔断/缓存 */
  synthFn?: (text: string, prefs: VoicePrefs) => Promise<string>;
  /** 合成失败回调（内核写 agent.log；不要往界面刷屏） */
  onSynthesizeError?: (message: string, reason: string) => void;
}

/**
 * Edge Read Aloud 是**非官方接口**，没有 SLA（2026-11-16 按实测与社区经验设的护栏）：
 *  - 需要 Sec-MS-GEC 时间戳签名，本机时钟偏差过大直接 403；
 *  - 短时间高频请求会 429 / 403（"No audio was received"），并发建议 1；
 *  - 长文本会被服务端截断或直接失败。
 * 所以这里做四件事：串行 + 最小间隔、同文本缓存、失败指数退避、连续失败熔断。
 */
export const MIN_SYNTH_GAP_MS = 800;
export const VOICE_COOLDOWN_STEPS = [30_000, 120_000, 300_000];
const VOICE_CACHE_TTL_MS = 5 * 60_000;
const VOICE_CACHE_MAX = 30;
const MAX_SYNTH_CHARS = 200;

/** 连续失败 n 次后的冷却时长（n=0 表示没失败） */
export function voiceCooldownMs(failures: number): number {
  if (failures <= 0) return 0;
  const idx = Math.min(failures, VOICE_COOLDOWN_STEPS.length) - 1;
  return VOICE_COOLDOWN_STEPS[idx];
}

export interface VoiceStatus {
  enabled: boolean;
  queued: number;
  lastError: string | null;
}

interface PreviewArgs {
  text: string;
  voiceId?: string;
  rate?: string;
  volume?: string;
  proxy?: string;
}

const SYNTH_TIMEOUT_MS = 15_000;
const MIN_MP3_BYTES = 512;

export class VoiceService {
  private queue: SpeechCandidate[] = [];
  private running = false;
  private generation = 0;
  private gate: VoiceGateState = { ...VOICE_GATE_INITIAL };
  private seq = 0;
  private lastError: string | null = null;
  /** 连续合成失败次数（成功一次清零）→ 决定冷却时长 */
  private failures = 0;
  /** 冷却截止时间：期间不再发请求（别在限流时继续撞接口） */
  private cooldownUntil = 0;
  /** 同文本缓存：同一句话 5 分钟内不重复合成（TTS 是最贵的一步） */
  private cache = new Map<string, { at: number; audio: string }>();
  private lastSynthAt = 0;
  /** 降级提示只提示一次，避免每张卡都刷 */
  private degradedNoted = false;

  constructor(private readonly opts: VoiceServiceOptions) {}

  /** 内核落卡时调用：先判白名单，再判去重/节流，最后才排队合成。 */
  sayCard(card: SpeechCard): void {
    const prefs = normalizeVoicePrefs(this.opts.getPrefs());
    const candidate = pickCardSpeech(card, prefs);
    if (candidate) this.enqueue(candidate, prefs);
  }

  /** 内核收轮时调用：只有 scope=all 且是用户回合才会产出候选。 */
  sayReply(text: string, internal: boolean): void {
    const prefs = normalizeVoicePrefs(this.opts.getPrefs());
    const candidate = pickReplySpeech(text, prefs, internal);
    if (candidate) this.enqueue(candidate, prefs);
  }

  /** 用户点了停止：立刻静音，在途合成的结果全部作废。 */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.opts.emit({ type: "stop" });
  }

  /** 设置页试听：用户主动触发，绕过白名单与节流，但结果仍如实回传。 */
  async preview(args: PreviewArgs): Promise<{ ok: boolean; error?: string }> {
    const prefs = normalizeVoicePrefs(this.opts.getPrefs());
    const text = cleanSpeechText(String(args.text ?? ""), 80) || "你好，我是风铃。有进展我会及时告诉你。";
    const chosen = normalizeVoicePrefs({
      ...prefs,
      voiceId: args.voiceId ?? prefs.voiceId,
      voiceRate: args.rate ?? prefs.voiceRate,
      voiceVolume: args.volume ?? prefs.voiceVolume,
      voiceProxy: args.proxy ?? prefs.voiceProxy,
    });
    const gen = this.generation;
    try {
      const audio = await this.synthesize(text, chosen);
      if (gen !== this.generation) return { ok: true };
      this.opts.emit({
        type: "play",
        id: `v-${++this.seq}`,
        audio,
        text,
        priority: "high",
        voice: chosen.voiceId,
      });
      this.lastError = null;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }

  voices(): typeof VOICE_OPTIONS {
    return VOICE_OPTIONS;
  }

  status(): VoiceStatus {
    return {
      enabled: normalizeVoicePrefs(this.opts.getPrefs()).voiceEnabled,
      queued: this.queue.length,
      lastError: this.lastError,
    };
  }

  private enqueue(candidate: SpeechCandidate, prefs: VoicePrefs): void {
    // 人不在就不念：留卡片与系统通知，窗口恢复后也不补播过期内容
    if (!prefs.voiceWhenHidden && !this.opts.isVisible()) return;
    const decision = gateSpeech(candidate, this.gate, Date.now(), this.queue.length);
    this.gate = decision.next;
    if (!decision.ok) return;
    if (decision.interrupt) {
      this.generation += 1;
      this.queue = this.queue.filter((q) => q.priority === "high");
      this.opts.emit({ type: "stop" });
    }
    this.queue.push(candidate);
    void this.drain(prefs);
  }

  private async drain(prefs: VoicePrefs): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const gen = this.generation;
        // 退避/熔断中：直接丢弃。播过期内容没意义，继续撞接口只会被限得更久。
        const now = Date.now();
        if (now < this.cooldownUntil) {
          if (!this.degradedNoted) {
            this.degradedNoted = true;
            this.opts.onSynthesizeError?.(
              `语音服务限流或不可用，暂停约 ${Math.ceil((this.cooldownUntil - now) / 1000)} 秒不再请求`,
              "cooldown",
            );
          }
          continue;
        }
        // 同文本缓存：同一句话 5 分钟内不重复合成（TTS 是最慢、也最容易被限的一步）
        const cached = this.cachedAudio(item.text, prefs);
        if (cached) {
          if (gen === this.generation) this.play(cached, item, prefs);
          continue;
        }
        // 串行 + 最小间隔：Edge 接口对并发与突发很敏感
        const wait = this.lastSynthAt + MIN_SYNTH_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          const audio = await this.synthesize(item.text, prefs);
          this.lastSynthAt = Date.now();
          this.failures = 0;
          this.degradedNoted = false;
          this.lastError = null;
          this.setCache(item.text, prefs, audio);
          if (gen !== this.generation) continue;
          this.play(audio, item, prefs);
        } catch (err) {
          this.lastSynthAt = Date.now();
          const message = err instanceof Error ? err.message : String(err);
          this.failures += 1;
          this.lastError = message;
          this.cooldownUntil = Date.now() + voiceCooldownMs(this.failures);
          this.opts.onSynthesizeError?.(message, item.reason);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private play(audio: string, item: SpeechCandidate, prefs: VoicePrefs): void {
    this.opts.emit({
      type: "play",
      id: `v-${++this.seq}`,
      audio,
      text: item.text,
      priority: item.priority,
      voice: prefs.voiceId,
    });
  }

  private cacheKey(text: string, prefs: VoicePrefs): string {
    return `${prefs.voiceId}|${prefs.voiceRate}|${text}`;
  }

  private cachedAudio(text: string, prefs: VoicePrefs): string | null {
    const k = this.cacheKey(text, prefs);
    const hit = this.cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > VOICE_CACHE_TTL_MS) {
      this.cache.delete(k);
      return null;
    }
    return hit.audio;
  }

  private setCache(text: string, prefs: VoicePrefs, audio: string): void {
    if (this.cache.size >= VOICE_CACHE_MAX) {
      // 先进先出即可：缓存只为省重复请求，不需要 LRU 精度
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(this.cacheKey(text, prefs), { at: Date.now(), audio });
  }

  private async synthesize(text: string, prefs: VoicePrefs): Promise<string> {
    // 长文本会被服务端截断或直接失败：合成前硬截（默认档本身已限到 120 字）
    const spoken = String(text ?? "").slice(0, MAX_SYNTH_CHARS);
    if (this.opts.synthFn) return this.opts.synthFn(spoken, prefs);
    const tts = new EdgeTTS({
      voice: prefs.voiceId,
      lang: prefs.voiceId.split("-").slice(0, 2).join("-") || "zh-CN",
      rate: prefs.voiceRate,
      volume: prefs.voiceVolume,
      timeout: SYNTH_TIMEOUT_MS,
      ...(prefs.voiceProxy ? { proxy: prefs.voiceProxy } : {}),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of tts.streamAudio(spoken)) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    }
    const mp3 = Buffer.concat(chunks);
    if (mp3.length < MIN_MP3_BYTES) throw new Error("语音服务没有返回音频（可能网络受限或音色不可用）");
    return `data:audio/mpeg;base64,${mp3.toString("base64")}`;
  }
}
