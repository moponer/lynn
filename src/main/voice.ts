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
        try {
          const audio = await this.synthesize(item.text, prefs);
          if (gen !== this.generation) continue;
          this.opts.emit({
            type: "play",
            id: `v-${++this.seq}`,
            audio,
            text: item.text,
            priority: item.priority,
            voice: prefs.voiceId,
          });
          this.lastError = null;
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          console.warn(`[voice] 合成失败（${item.reason}）：${this.lastError}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async synthesize(text: string, prefs: VoicePrefs): Promise<string> {
    const tts = new EdgeTTS({
      voice: prefs.voiceId,
      lang: prefs.voiceId.split("-").slice(0, 2).join("-") || "zh-CN",
      rate: prefs.voiceRate,
      volume: prefs.voiceVolume,
      timeout: SYNTH_TIMEOUT_MS,
      ...(prefs.voiceProxy ? { proxy: prefs.voiceProxy } : {}),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of tts.streamAudio(text)) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    }
    const mp3 = Buffer.concat(chunks);
    if (mp3.length < MIN_MP3_BYTES) throw new Error("语音服务没有返回音频（可能网络受限或音色不可用）");
    return `data:audio/mpeg;base64,${mp3.toString("base64")}`;
  }
}
