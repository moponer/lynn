/**
 * OpenAI 兼容流式客户端（DeepSeek / GLM / Kimi / Qwen / MiniMax / Ollama…）。
 * 只依赖全局 fetch（Node ≥ 18）；解析 SSE 的 chat.completion.chunk。
 * 内核外不存在第二个 HTTP 出口（§4.7 出站白名单）。
 */

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
}

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
  /** 写入缓存 / 未命中的输入（Anthropic: cache_creation_input_tokens；DeepSeek: prompt_cache_miss_tokens） */
  cacheWrite: number;
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
  ) {
    super(message);
  }
}

/** 流式对话一轮：返回最终 content 与 toolCalls（如 finish_reason=tool_calls） */
export async function streamChat(input: StreamChatInput): Promise<StreamChatResult> {
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
    signal: input.signal ?? AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `模型请求失败 HTTP ${res.status}${text ? `：${text.slice(0, 300)}` : ""}`,
      res.status,
    );
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const toolAcc = new Map<number, ToolCall>();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleChunk = (json: SseChunk) => {
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens ?? promptTokens;
      completionTokens = json.usage.completion_tokens ?? completionTokens;
      // 各家字段名不同：按优先级取，取不到保持 0（不造假命中率）
      const u = json.usage;
      cacheRead = u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? cacheRead;
      cacheWrite = u.cache_creation_input_tokens ?? u.prompt_cache_miss_tokens ?? cacheWrite;
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
  };
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
      return { ok: false, error: `HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}` };
    }
    await res.json();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
