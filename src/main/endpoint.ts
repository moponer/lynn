/**
 * 自定义 OpenAI 兼容端点（2026-11-11）：
 * 风险分级、/v1/models 发现、健康检查。只做只读探测，不在这里发对话请求。
 */

export { endpointRiskLevel } from "../shared/endpoint-risk";
export type { EndpointRisk } from "../shared/endpoint-risk";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
  created?: number;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 同一个 baseUrl 可能带不带 /v1，候选按常见顺序试 */
export function modelsEndpointCandidates(baseUrl: string): string[] {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return [];
  const out: string[] = [];
  if (/\/models$/i.test(b)) out.push(b);
  else if (/\/v1$/i.test(b)) out.push(`${b}/models`);
  else out.push(`${b}/v1/models`, `${b}/models`);
  return [...new Set(out)];
}

/**
 * GET /v1/models。只接受 data[] / models[]；返回空列表视为失败，避免 UI 显示"成功但 0 个"。
 * 所有候选都失败时抛出最后一条真实错误（带 HTTP 状态，便于用户改 Base URL）。
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<{ models: DiscoveredModel[]; latencyMs: number; url: string }> {
  const t0 = Date.now();
  let lastError = "没有可用的 /models 端点";
  for (const url of modelsEndpointCandidates(baseUrl)) {
    try {
      const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        lastError = `HTTP ${res.status}${text ? `：${text.slice(0, 180)}` : ""}`;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastError = `返回不是 JSON：${text.slice(0, 120)}`;
        continue;
      }
      const obj = parsed as { data?: unknown; models?: unknown };
      const arr = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : [];
      const models: DiscoveredModel[] = [];
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as { id?: unknown; name?: unknown; owned_by?: unknown; ownedBy?: unknown; created?: unknown };
        const id = String(m.id ?? m.name ?? "").trim();
        if (!id) continue;
        models.push({
          id,
          ...(typeof (m.owned_by ?? m.ownedBy) === "string" ? { ownedBy: String(m.owned_by ?? m.ownedBy) } : {}),
          ...(typeof m.created === "number" ? { created: m.created } : {}),
        });
      }
      if (models.length === 0) {
        lastError = "端点返回了空模型列表";
        continue;
      }
      return { models, latencyMs: Date.now() - t0, url };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}
