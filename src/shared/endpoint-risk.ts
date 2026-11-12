/**
 * 自定义端点的风险分级（主进程与渲染层共用，避免两边判断不一致）。
 * local = 本机/局域网；insecure = 非 HTTPS；remote = 普通 HTTPS 远程。
 */
export type EndpointRisk = "local" | "insecure" | "remote";

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export function endpointRiskLevel(baseUrl: string): EndpointRisk {
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "insecure";
    if (isPrivateHost(u.hostname)) return "local";
    if (u.protocol !== "https:") return "insecure";
    return "remote";
  } catch {
    return "insecure";
  }
}
