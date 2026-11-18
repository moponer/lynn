/**
 * OpenAI 兼容流式客户端（DeepSeek / GLM / Kimi / Qwen / MiniMax / Ollama…）。
 * 只依赖全局 fetch（Node ≥ 18）；解析 SSE 的 chat.completion.chunk。
 * 内核外不存在第二个 HTTP 出口（§4.7 出站白名单）。
 */
import { redactSecrets } from "./endpoint";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamChatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** 多久没有任何 chunk 就断开（默认 90s）；慢端点排队/长上下文可调大 */
  idleTimeoutMs?: number;
  /** 单次调用的总上限（默认 300s）；必须 ≥ idleTimeoutMs */
  totalTimeoutMs?: number;
}

/** 默认超时：idle 抓"卡死"，total 只做兜底 */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** usage 可能在最后一块；取不到就是 0，不造假数 */
  promptTokens: number;
  completionTokens: number;
  /** 命中缓存的前缀 token（DeepSeek: prompt_cache_hit_tokens；Anthropic 兼容: cache_read_input_tokens；OpenAI: prompt_tokens_details.cached_tokens） */
  cacheRead: number;
  /** 仅指「新写入缓存」的 token（Anthropic: cache_creation_input_tokens），不含 DeepSeek 的 miss —— miss 已在 prompt_tokens 里 */
  cacheWrite: number;
  /** DeepSeek 的未命中输入 token：只用于日志，不与 sessionIn 重复记账 */
  cacheMiss: number;
  /**
   * 端点这次**有没有回报**缓存字段（2026-11-14）。
   * 用于区分「真的没命中」与「端点压根没报」——否则 cacheRead=0 的命中率不可判读。
   */
  cacheFieldsReported: boolean;
}

interface SseChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek：命中缓存的前缀 token */
    prompt_cache_hit_tokens?: number;
    /** DeepSeek：未命中的输入 token */
    prompt_cache_miss_tokens?: number;
    /** Anthropic 兼容端点 */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** OpenAI 兼容端点 */
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 429/503 常带 Retry-After；交给退避策略，不写死等待 */
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

export type StreamTimeoutKind = "idle" | "total";

/**
 * 流式调用超时（2026-11-16 日志复盘）。
 *
 * 原来只有一个 120s 的**整轮硬超时**：成员读了几十个文件、上下文长到十几万 token 后，
 * 单次模型调用很容易超过 120s，被砍断 → 整单作废 → 风铃重派 → 从零再读一遍。
 * 实测同一张单跑了 6 次，43% 的成员 token 花在这种重复执行上。
 * 现在拆成两种：
 *  - idle：一段时间没有任何 chunk（端点排队 / 卡死）——这才是真该断的；
 *  - total：兜底上限，默认放宽到 5 分钟，让"慢但一直在产出"的一轮跑完。
 */
export class StreamTimeoutError extends Error {
  constructor(
    readonly kind: StreamTimeoutKind,
    readonly timeoutMs: number,
  ) {
    super(
      kind === "idle"
        ? `模型 ${Math.round(timeoutMs / 1000)}s 没有任何输出（idle 超时），已断开；这通常是端点排队或上下文过大`
        : `模型 ${Math.round(timeoutMs / 1000)}s 未跑完（总超时），已断开`,
    );
    this.name = "StreamTimeoutError";
  }
}

/**
 * 额度类 429（用尽 / 欠费 / 套餐上限）是**终态**：退避重试没有意义，只会把请求配额也烧掉。
 * 与"瞬时限流"（同一句话再等一会儿就能过）必须分开——前者要熔断，后者要退避。
 */
const QUOTA_HINTS =
  /用量上限|额度不足|额度已用|配额已用|余额不足|购买积分|请充值|请升级|token plan|insufficient_quota|exceeded your current quota|quota exceeded/i;

/** 文案判定（供只有字符串、没有 err 对象的路径用：Pi 事件里的 errorMessage、成员回报等） */
export function isQuotaMessage(text: string): boolean {
  return QUOTA_HINTS.test(String(text ?? ""));
}

export function isQuotaError(err: unknown): boolean {
  const status = err instanceof LlmError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (status === 402) return true;
  return status === 429 && isQuotaMessage(msg);
}

/**
 * 流式对话一轮：返回最终 content 与 toolCalls。
 * `input.signal`（用户停止）与 120s 超时合成同一个 AbortSignal：
 * 任一方触发都会立刻断开 fetch 与 SSE body，不再等整段流跑完。
 */
export async function streamChat(input: StreamChatInput): Promise<StreamChatResult> {
  const idleTimeoutMs = Math.max(500, input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const totalTimeoutMs = Math.max(idleTimeoutMs, input.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const controller = new AbortController();
  /** 记下超时种类：AbortError 本身分不清"用户停"与"超时"，判定必须靠这里 */
  let timeoutKind: StreamTimeoutKind | null = null;
  const totalTimer = setTimeout(() => {
    timeoutKind = "total";
    controller.abort();
  }, totalTimeoutMs);
  (totalTimer as NodeJS.Timeout & { unref?: () => void }).unref?.();
  // idle 定时器在每个 chunk 到达时 refresh：有产出就不算卡死
  const idleTimer = setTimeout(() => {
    timeoutKind = "idle";
    controller.abort();
  }, idleTimeoutMs);
  (idleTimer as NodeJS.Timeout & { unref?: () => void }).unref?.();
  const onExternalAbort = () => controller.abort();
  if (input.signal?.aborted) onExternalAbort();
  else input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        // usage 跟在最后一个 chunk（主流国内端点均支持；不支持则 usage 缺省为 0）
        stream_options: { include_usage: true },
        ...(input.tools && input.tools.length ? { tools: input.tools } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      // 先脱敏再截断（审计 #16）：部分网关的 4xx 会回显 Authorization/key 片段
      throw new LlmError(
        `模型请求失败 HTTP ${res.status}${text ? `：${redactSecrets(text).slice(0, 300)}` : ""}`,
        res.status,
        res.headers.get("retry-after"),
      );
    }

    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cacheMiss = 0;
    let cacheFieldsReported = false;
    const toolAcc = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleChunk = (json: SseChunk) => {
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens;
        completionTokens = json.usage.completion_tokens ?? completionTokens;
        // 各家字段名不同：按优先级取，取不到保持 0（不造假命中率）
        const u = json.usage;
        // 只要 usage 里出现过任一缓存字段（哪怕值为 0）就算"端点报了"。
        // 这与 cacheRead 的数值无关：报了 0 才说明真的没命中。
        cacheFieldsReported =
          cacheFieldsReported ||
          u.prompt_cache_hit_tokens !== undefined ||
          u.prompt_cache_miss_tokens !== undefined ||
          u.cache_read_input_tokens !== undefined ||
          u.cache_creation_input_tokens !== undefined ||
          u.prompt_tokens_details?.cached_tokens !== undefined;
        cacheRead = u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? cacheRead;
        // DeepSeek 的 miss 已经算在 prompt_tokens 里，不能再当 cacheWrite 记一次；
        // cacheWrite 只表示 Anthropic 那种「额外写入缓存」的 token。
        cacheWrite = u.cache_creation_input_tokens ?? 0;
        cacheMiss = u.prompt_cache_miss_tokens ?? 0;
      }
      for (const choice of json.choices ?? []) {
        const d = choice.delta;
        if (d?.content) {
          content += d.content;
          input.onDelta(d.content);
        }
        for (const tc of d?.tool_calls ?? []) {
          const acc = toolAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          toolAcc.set(tc.index, acc);
        }
      }
    };

    // SSE 按「空行分隔的块」解析，块内取 data: 行
    for await (const bytes of res.body) {
      idleTimer.refresh();
      buffer += decoder.decode(bytes as Uint8Array, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const line of block.split(/\r?\n/)) {
          const m = /^data:\s*(.*)$/.exec(line.trim());
          if (!m) continue;
          const payload = m[1];
          if (payload === "[DONE]") continue;
          try {
            handleChunk(JSON.parse(payload) as SseChunk);
          } catch {
            // 忽略无法解析的行（部分网关会夹带心跳/注释行）
          }
        }
      }
    }

    return {
      content,
      toolCalls: [...toolAcc.values()].filter((t) => t.name),
      promptTokens,
      completionTokens,
      cacheRead,
      cacheWrite,
      cacheMiss,
      cacheFieldsReported,
    };
  } catch (err) {
    // 超时与用户停止必须分开：前者可续跑/可重试，后者要立刻安静收口
    if (timeoutKind && !input.signal?.aborted) {
      throw new StreamTimeoutError(timeoutKind, timeoutKind === "idle" ? idleTimeoutMs : totalTimeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface RetryInfo {
  attempt: number;
  status?: number;
  delayMs: number;
}

/** 429 / 5xx / 连接类失败的等待：优先读 Retry-After，否则指数退避 + 抖动 */
function retryDelay(err: unknown, attempt: number): number {
  const header = err instanceof LlmError ? err.retryAfter : null;
  let base = 0;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) base = seconds * 1000;
    else {
      const at = Date.parse(header);
      if (!Number.isNaN(at)) base = Math.max(0, at - Date.now());
    }
  }
  if (!base) base = (err instanceof LlmError && err.status === 429 ? 800 : 300) * 2 ** (attempt - 1);
  return Math.min(8000, Math.max(100, base + Math.floor(Math.random() * 150)));
}

/**
 * 带退避的流式调用。只重试「还没吐出任何正文」的失败，避免把半截回复重放一遍。
 * 用户主动停止（signal 已 abort）时不重试。
 */
export async function streamChatWithRetry(
  input: StreamChatInput,
  opts: { maxAttempts?: number; onRetry?: (info: RetryInfo) => void } = {},
): Promise<StreamChatResult & { attempts: number }> {
  const max = Math.max(1, opts.maxAttempts ?? 3);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    let streamed = false;
    try {
      const result = await streamChat({
        ...input,
        onDelta: (t) => {
          streamed = true;
          input.onDelta(t);
        },
      });
      return { ...result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (input.signal?.aborted) throw err;
      const status = err instanceof LlmError ? err.status : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      const network = !status && /fetch failed|network|ECONNREFUSED|ETIMEDOUT|socket hang up|EAI_AGAIN|ENOTFOUND/i.test(msg);
      // 额度用尽（429 + 套餐/余额语义）是终态：重试只会把请求配额一起烧掉，必须交给上层熔断
      const timeout = err instanceof StreamTimeoutError;
      const retryable =
        !streamed && !isQuotaError(err) && (status === 429 || (typeof status === "number" && status >= 500) || network || timeout);
      if (!retryable || attempt >= max) throw err;
      const delayMs = retryDelay(err, attempt);
      opts.onRetry?.({ attempt, status, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error("retry exhausted");
}

/** 非流式快速探测：配置界面的「测试连接」用 */
export async function probeEndpoint(cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}${text ? `：${redactSecrets(text).slice(0, 200)}` : ""}` };
    }
    await res.json();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
