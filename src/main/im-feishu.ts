/**
 * 飞书渠道（2026-11-18 P14-1）。
 *
 * 为什么先接飞书（国内渠道里）：
 *  - **长连接**：不需要公网 IP / 内网穿透，本机就能收消息；
 *  - **个人可建**：飞书开放平台免费创建自建应用，不需要企业资质；
 *  - Lynn 之前有过飞书发送端（`messaging.ts`），虽然删了但域名与凭据形态是熟悉的。
 *
 * ## 它做的事
 *
 * ```
 * 飞书用户发消息
 *   → WSClient 长连接收到 im.message.receive_v1
 *   → 转成 HTTP 请求发给本地 im-bridge（Lynn 内核）
 *   → 拿到回答
 *   → 用 client.im.message.reply 发回飞书
 * ```
 *
 * ## 为什么不用 dsh-im 的飞书实现
 *
 * 它的实现有 44KB 的 `rpc.mjs` + 15KB 的 `production.mjs`，涵盖卡片、流式、
 * 斜杠命令面板、语音、群历史等。那些能力**在 Lynn 里没有对应物**
 * （Lynn 没有飞书卡片渲染、没有斜杠面板），照搬会带进大量无用依赖。
 *
 * 所以这里只做**最小可用**：收文本消息 → 跑一轮 → 回文本。
 * 够验证整条链路，也够日常用。要卡片/流式再加。
 *
 * ## 安全
 *
 * 飞书消息进来 = 陌生人可以驱动 Agent。所以三道闸：
 *  1. **白名单**：只有配置里列出的 open_id 能用（默认空 = 谁都进不来）；
 *  2. **单聊优先**：默认只响应私聊，群聊要显式开启；
 *  3. **审计**：每条进来的消息记日志（谁、什么内容的前 80 字）。
 */

/** 飞书凭据与策略 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /**
   * 允许驱动 Agent 的用户 open_id 白名单。
   *
   * **默认空数组 = 拒绝所有人**。这是刻意的：飞书消息来自陌生人，
   * 而 Lynn 的成员有文件与命令权限。必须由用户显式列出允许的人。
   */
  allowOpenIds: string[];
  /** 是否响应群聊（默认 false，只响应私聊） */
  allowGroup?: boolean;
}

/** 一条进来的消息（归一化后） */
export interface IncomingMessage {
  /** 飞书消息 id（回复时要带） */
  messageId: string;
  /** 发送者 open_id */
  senderId: string;
  /** 会话 id（回复目标） */
  chatId: string;
  /** 是否群聊 */
  isGroup: boolean;
  /** 文本内容 */
  text: string;
}

/** 渠道状态 */
export type ChannelState = "idle" | "connecting" | "connected" | "error";

export interface FeishuChannelDeps {
  config: FeishuConfig;
  /** 把消息交给 Lynn，返回回答文本 */
  ask(text: string, sessionKey: string): Promise<string>;
  /** 记日志 */
  log(event: string, detail?: Record<string, unknown>): void;
  /** 状态变化回调（给界面/诊断用） */
  onState?(state: ChannelState, detail?: string): void;
}

/** 飞书 SDK 的最小类型（不引它的 .d.ts：那个包类型很重，这里只声明用到的） */
interface FeishuSdk {
  WSClient: new (opts: { appId: string; appSecret: string; loggerLevel?: number }) => {
    start(opts: { eventDispatcher: unknown }): Promise<void>;
    close(): void;
  };
  EventDispatcher: new (opts: Record<string, unknown>) => {
    register(handles: Record<string, (data: unknown) => Promise<void> | void>): void;
  };
  Client: new (opts: { appId: string; appSecret: string }) => {
    im: {
      message: {
        reply(payload: {
          path: { message_id: string };
          data: { content: string; msg_type: string };
        }): Promise<unknown>;
      };
    };
  };
}

/** 动态加载 SDK：没装时给一条能照做的错误，而不是崩在 import */
async function loadSdk(): Promise<FeishuSdk> {
  try {
    const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as FeishuSdk & { default?: FeishuSdk };
    return (mod.default ?? mod) as FeishuSdk;
  } catch (err) {
    throw new Error(
      `飞书 SDK 没装：${err instanceof Error ? err.message : String(err)}。` +
        `装它：npm install @larksuiteoapi/node-sdk`,
    );
  }
}

/** 从飞书事件里取出归一化的消息；取不到返回 null */
export function parseIncoming(raw: unknown): IncomingMessage | null {
  const ev = raw as {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: { key?: string; name?: string }[];
    };
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  };
  const m = ev?.message;
  if (!m?.message_id || !m.chat_id) return null;

  // 只处理文本：其它类型（图片/文件/富文本）本轮不支持，明确返回 null 由调用方决定要不要提示
  if (m.message_type !== "text") return null;

  let text = "";
  try {
    const parsed = JSON.parse(m.content ?? "{}") as { text?: string };
    text = String(parsed.text ?? "");
  } catch {
    return null;
  }
  /**
   * 去掉 @机器人 的部分：飞书把 @ 放在文本里，形如 `@_user_1 你好`。
   * 留着会让 Lynn 看到 "@_user_1" 这种无意义前缀。
   */
  for (const at of m.mentions ?? []) {
    if (at.key) text = text.split(at.key).join("");
  }
  text = text.trim();
  if (!text) return null;

  return {
    messageId: m.message_id,
    senderId: ev.sender?.sender_id?.open_id ?? "",
    chatId: m.chat_id,
    isGroup: m.chat_type === "group" || m.chat_type === "topic",
    text,
  };
}

/**
 * open_id 格式校验（2026-11-18）。
 *
 * 真实事故：用户从飞书后台复制 open_id 时多选了末尾 3 个字符
 * （`ou_xxx...ccs`），保存成功、渠道起来了，但每条消息都被白名单挡掉，
 * 表现为"发消息没反应"——很难自己看出是 id 写错了。
 *
 * 所以保存时校验格式：`ou_` + 32 位十六进制。
 */
export function isValidOpenId(id: string): boolean {
  return /^ou_[0-9a-f]{32}$/i.test(id.trim());
}

/** 判断这条消息该不该处理 */
export function shouldHandle(
  msg: IncomingMessage,
  cfg: FeishuConfig,
): { ok: true } | { ok: false; reason: string } {
  // 机器人自己发的消息不处理（否则会自己回自己）
  if (!msg.senderId) return { ok: false, reason: "没有发送者 open_id" };
  if (!cfg.allowOpenIds.length) {
    return { ok: false, reason: "白名单为空——在设置里加上允许的用户 open_id" };
  }
  if (!cfg.allowOpenIds.includes(msg.senderId)) {
    return { ok: false, reason: `发送者 ${msg.senderId} 不在白名单` };
  }
  if (msg.isGroup && !cfg.allowGroup) {
    return { ok: false, reason: "群聊未开启（allowGroup=false）" };
  }
  return { ok: true };
}

/**
 * 飞书渠道。
 *
 * 生命周期：`start()` → 收消息 → `stop()`。
 * 停不掉会让进程退不干净（WSClient 持有 socket）。
 */
export class FeishuChannel {
  private ws: { start(o: { eventDispatcher: unknown }): Promise<void>; close(): void } | null = null;
  private client: FeishuSdk["Client"] extends new (o: never) => infer R ? R : never;
  private state: ChannelState = "idle";
  /** 会话 → 最近一次交互时间（用于日志与将来的会话隔离） */
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly deps: FeishuChannelDeps) {
    this.client = null as never;
  }

  /** 当前状态（诊断用） */
  getState(): { state: ChannelState; sessions: number } {
    return { state: this.state, sessions: this.lastSeen.size };
  }

  private setState(s: ChannelState, detail?: string): void {
    this.state = s;
    this.deps.onState?.(s, detail);
  }

  /** 启动长连接 */
  async start(): Promise<void> {
    const { config } = this.deps;
    if (!config.appId || !config.appSecret) {
      throw new Error("飞书渠道缺少 appId / appSecret");
    }
    if (!config.allowOpenIds.length) {
      /**
       * 白名单为空时**拒绝启动**，而不是"启动了但谁都不理"。
       *
       * 后者更难排查：用户会以为连上了，实际每条消息都被静默丢弃。
       */
      throw new Error("飞书渠道的白名单为空：先在设置里加上允许的用户 open_id，否则任何人都能驱动 Agent");
    }

    this.setState("connecting");
    const sdk = await loadSdk();
    this.client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret });

    const dispatcher = new sdk.EventDispatcher({});
    dispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.onMessage(data);
      },
    });

    this.ws = new sdk.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      // 0 = error 级：不要每条心跳都打日志
      loggerLevel: 0,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.setState("connected");
    this.deps.log("feishu_connected", { appId: config.appId, allow: config.allowOpenIds.length });
  }

  /** 停止长连接 */
  stop(): void {
    try {
      this.ws?.close();
    } catch (err) {
      this.deps.log("feishu_close_error", { error: String(err) });
    }
    this.ws = null;
    this.setState("idle");
  }

  /** 收一条消息：过滤 → 交给 Lynn → 回复 */
  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseIncoming(raw);
    if (!msg) return; // 非文本消息静默忽略（本轮只支持文本）

    const verdict = shouldHandle(msg, this.deps.config);
    if (!verdict.ok) {
      this.deps.log("feishu_ignored", { sender: msg.senderId, reason: verdict.reason });
      return;
    }

    this.lastSeen.set(msg.chatId, Date.now());
    this.deps.log("feishu_incoming", {
      sender: msg.senderId,
      chat: msg.chatId,
      group: msg.isGroup,
      // 只记前 80 字：日志不该变成聊天记录的副本
      preview: msg.text.slice(0, 80),
    });

    let answer: string;
    try {
      // 会话 key 用 chatId：同一个飞书会话对应 Lynn 的同一个线程
      answer = await this.deps.ask(msg.text, msg.chatId);
    } catch (err) {
      answer = `出错了：${err instanceof Error ? err.message : String(err)}`;
      this.deps.log("feishu_ask_error", { error: answer.slice(0, 200) });
    }

    try {
      await this.client.im.message.reply({
        path: { message_id: msg.messageId },
        data: { content: JSON.stringify({ text: answer }), msg_type: "text" },
      });
    } catch (err) {
      this.deps.log("feishu_reply_error", { error: String(err).slice(0, 200) });
    }
  }
}