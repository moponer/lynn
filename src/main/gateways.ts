import { discoverModels } from "./endpoint";

/**
 * 常见的本地 / 免费模型网关预设（2026-11-11）。
 * 只在「设置 → 模型」页打开时探测本机端口，不向公网发请求，也不自动启动第三方进程。
 * 用户点「连接」后才会把端点填进表单并拉模型列表；免费池的条款/隐私风险由用户显式确认。
 */
export interface GatewayPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** 需要该网关自己的本地 Key（例如 OFM 会在本机生成一个） */
  needsKey: boolean;
  docsUrl: string;
  note: string;
}

export interface GatewayStatus extends GatewayPreset {
  status: "running" | "down" | "needs_key";
  latencyMs?: number;
  modelCount?: number;
  error?: string;
}

export const GATEWAY_PRESETS: GatewayPreset[] = [
  {
    id: "ofm",
    name: "OFM 免费模型网关",
    baseUrl: "http://127.0.0.1:18900/v1",
    needsKey: true,
    docsUrl: "https://github.com/Ebony-Vinyl/dsh-our-free-model",
    note: "第三方免费池：prompt 可能被上游记录，随时限流/下线；只建议非敏感数据。",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    needsKey: false,
    docsUrl: "https://ollama.com/download",
    note: "本地模型，不联网；需要先 ollama serve。",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    needsKey: false,
    docsUrl: "https://lmstudio.ai",
    note: "本地模型；在 LM Studio 里开启 Local Server。",
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    needsKey: false,
    docsUrl: "https://github.com/ggml-org/llama.cpp",
    note: "本地模型；llama-server 默认 8080。",
  },
  {
    id: "vllm",
    name: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    needsKey: false,
    docsUrl: "https://docs.vllm.ai",
    note: "本地/内网模型；OpenAI 兼容模式默认 8000。",
  },
];

/** 探测本机网关：只 GET /models，1.2s 超时，不发 Key（需要 Key 的网关会报 needs_key） */
export async function probeGateways(presets: GatewayPreset[] = GATEWAY_PRESETS, timeoutMs = 1200): Promise<GatewayStatus[]> {
  return Promise.all(
    presets.map(async (g) => {
      try {
        const r = await discoverModels(g.baseUrl, "", timeoutMs);
        return { ...g, status: "running" as const, latencyMs: r.latencyMs, modelCount: r.models.length };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const needsKey = g.needsKey && /HTTP\s*(401|403)|unauthorized|api.?key/i.test(message);
        return {
          ...g,
          status: needsKey ? ("needs_key" as const) : ("down" as const),
          error: message.slice(0, 160),
        };
      }
    }),
  );
}
