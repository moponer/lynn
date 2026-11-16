/**
 * 自定义 OpenAI 兼容端点（2026-11-11）：
 * 风险分级、/v1/models 发现、健康检查。只做只读探测，不在这里发对话请求。
 */

export { endpointRiskLevel } from "../shared/endpoint-risk";
export type { EndpointRisk } from "../shared/endpoint-risk";
import { endpointRiskLevel } from "../shared/endpoint-risk";
// 统一打码规则（2026-11-16）：本模块内继续用这个名字，对外仍从 endpoint 导出，
// 老调用点（llm.ts / kernel.ts / 测试）不用改。
import { redactSecrets } from "../shared/redact";
export { redactSecrets };

/**
 * 端点错误响应体脱敏（2026-11-13 审计 #16）：非 2xx 响应体原文会进错误消息 → feed 卡、
 * agent.log、系统通知。部分网关的 4xx 会回显请求内容（含 Authorization 头或 key 片段）。
 * 截断只是限长不是脱敏——统一规则在 src/shared/redact.ts（2026-11-16 与 memory 合并，
 * 此前两处各写一份、覆盖的令牌形态不同）；上面已 import + re-export。
 */

/**
 * 携带 API Key 的出站探测统一风险闸（2026-11-13 审计 #6）：
 * 本机/局域网/非 HTTPS 端点必须显式 riskAccepted，否则返回结构化拒绝文案。
 * 此前只有 kernel.modelDiscover 有这道闸，壳层 providers.discover 分支没走
 * ——两条路径两套标准，明文 HTTP 端点也能拿到用户 Key。现在都走这一个函数。
 */
export function endpointRiskError(baseUrl: string, riskAccepted?: boolean, action = "继续"): string | null {
  const risk = endpointRiskLevel(baseUrl);
  if (risk === "remote" || riskAccepted === true) return null;
  return risk === "local"
    ? `这是本机/局域网网关：探测会把 Key 发给该端点，且可能复用第三方免费额度。请勾选风险确认后再${action}。`
    : `这个端点不是 HTTPS：探测会把 Key 明文发出去。请勾选风险确认后再${action}。`;
}

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
        lastError = `HTTP ${res.status}${text ? `：${redactSecrets(text).slice(0, 180)}` : ""}`;
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
