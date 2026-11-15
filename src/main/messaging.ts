// M2-16：消息平台适配（§3.4 L303；风险 R8：**先落合规路径再写代码**）。
//  合规红线（写死在代码与配置里，不靠自觉）：
//  1. 只用官方 API：飞书开放平台（open.feishu.cn）/ QQ 机器人开放平台（bots.qq.com）；
//  2. 应用由**用户自建**：appId/appSecret 必须是用户在官方平台创建的自建应用凭据，
//     lynn 不代注册、不逆向协议、不接非官方网关；
//  3. 凭据加密落盘（与 API Key 同一纪律），明文永不下发渲染层；
//  4. 未配置/未开通权限时如实报错并给官方指引，不假装连上。
//  接收侧（WS 长连接）需要官方 SDK，本轮未接——如实标注"收消息未实现"，只落发送与配置。
import * as fs from "node:fs";
import * as path from "node:path";

export const COMPLIANCE_NOTE = [
  "消息平台合规口径（R8）：",
  "1. 只用官方 API：飞书开放平台 / QQ 机器人开放平台；",
  "2. 应用由用户自建（在官方平台创建并开通权限），lynn 不代注册、不逆向、不用非官方协议；",
  "3. 凭据加密落盘，明文永不下发渲染层；",
  "4. 收消息（长连接）未实现——当前只有配置与发送；官方 SDK 接入时会如实更新此说明。",
].join("\n");

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// ---------- 飞书（官方 API） ----------

export interface TokenCache {
  token?: string;
  expiresAt?: number;
}

/** 飞书 tenant_access_token（自建应用） */
export async function feishuToken(
  appId: string,
  appSecret: string,
  fetchFn: FetchFn,
  cache: TokenCache = {},
): Promise<string> {
  if (cache.token && cache.expiresAt && Date.now() < cache.expiresAt - 60_000) return cache.token;
  const res = await fetchFn("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (!res.ok || j.code !== 0 || !j.tenant_access_token) {
    throw new Error(`飞书凭据无效或权限未开通（code=${j.code}，msg=${j.msg ?? res.status}）。请在飞书开放平台检查自建应用与凭据。`);
  }
  cache.token = j.tenant_access_token;
  cache.expiresAt = Date.now() + (j.expire ?? 3600) * 1000;
  return j.tenant_access_token;
}

/** 飞书发文本消息（im/v1，receive_id_type=chat_id） */
export async function feishuSend(
  cfg: { appId: string; appSecret: string },
  chatId: string,
  text: string,
  fetchFn: FetchFn,
  cache: TokenCache = {},
): Promise<{ ok: boolean; error?: string }> {
  const token = await feishuToken(cfg.appId, cfg.appSecret, fetchFn, cache);
  const res = await fetchFn("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const j = (await res.json()) as { code?: number; msg?: string };
  if (!res.ok || (j.code !== 0 && j.code !== undefined)) {
    return { ok: false, error: `飞书发送失败（code=${j.code}，msg=${j.msg ?? res.status}）` };
  }
  return { ok: true };
}

// ---------- QQ 机器人开放平台（官方 API） ----------

export async function qqToken(
  appId: string,
  appSecret: string,
  fetchFn: FetchFn,
  cache: TokenCache = {},
): Promise<string> {
  if (cache.token && cache.expiresAt && Date.now() < cache.expiresAt - 60_000) return cache.token;
  const res = await fetchFn("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: string; message?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`QQ 凭据无效或机器人未上架（${j.message ?? res.status}）。请在 q.qq.com 检查机器人与应用凭据。`);
  }
  cache.token = j.access_token;
  cache.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return j.access_token;
}

export async function qqSend(
  cfg: { appId: string; appSecret: string },
  openid: string,
  text: string,
  fetchFn: FetchFn,
  cache: TokenCache = {},
): Promise<{ ok: boolean; error?: string }> {
  const token = await qqToken(cfg.appId, cfg.appSecret, fetchFn, cache);
  const res = await fetchFn(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: text, msg_type: 0, msg_id: `lynn-${Date.now()}`, msg_seq: 1 }),
  });
  if (!res.ok) return { ok: false, error: `QQ 发送失败（HTTP ${res.status}）` };
  return { ok: true };
}

// ---------- 渠道配置存取（凭据加密，同 API Key 纪律） ----------

export interface ChannelConfig {
  appId: string;
  /** 加密后的 secret（encrypted 标记与 API Key 一致） */
  secret: { encrypted: boolean; data: string };
  enabled: boolean;
  updatedAt: string;
}

export interface MessagingConfig {
  feishu?: ChannelConfig;
  qq?: ChannelConfig;
}

export function loadMessaging(dataRoot: string): MessagingConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, "messaging.json"), "utf-8")) as MessagingConfig;
  } catch {
    return {};
  }
}

export function saveMessaging(dataRoot: string, cfg: MessagingConfig): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = path.join(dataRoot, "messaging.json");
  // 与 settings.json 同一纪律：新文件 0600，旧文件即便此前权限过宽也尽力收紧。
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows / 只读介质：尽力而为，不挡配置保存 */
  }
}

/** 配置渠道（纯函数，M2-16）：不碰盘不碰 electron，加密函数注入以便测试 */
export function configureChannel(
  cfg: MessagingConfig,
  channel: "feishu" | "qq",
  input: { appId: string; appSecret?: string; enable?: boolean },
  encrypt: (plain: string) => ChannelConfig["secret"],
): { ok: boolean; error?: string; next: MessagingConfig } {
  if (channel !== "feishu" && channel !== "qq") {
    return { ok: false, error: `未知渠道：${channel}`, next: cfg };
  }
  const prev = cfg[channel];
  if (!input.appSecret?.trim() && !prev) {
    return { ok: false, error: "首次配置必须填 App Secret（在官方平台自建应用后获取）", next: cfg };
  }
  const secret = input.appSecret?.trim()
    ? encrypt(input.appSecret.trim())
    : (prev?.secret ?? { encrypted: false, data: "" });
  const next: MessagingConfig = {
    ...cfg,
    [channel]: {
      appId: String(input.appId).trim(),
      secret,
      enabled: input.enable ?? prev?.enabled ?? true,
      updatedAt: new Date().toISOString(),
    },
  };
  return { ok: true, next };
}

/** 发送前置守卫：未配置/未启用如实拒 */
export function resolveEnabledChannel(
  cfg: MessagingConfig,
  channel: string,
): { ok: true; ch: ChannelConfig } | { ok: false; error: string } {
  const ch = cfg[channel as "feishu" | "qq"];
  if (!ch?.enabled) {
    return { ok: false, error: `${channel} 渠道未配置或未启用（只支持官方 API + 用户自建应用）` };
  }
  return { ok: true, ch };
}
