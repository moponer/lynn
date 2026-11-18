/**
 * 在 vendored 渠道外面观察飞书事件（2026-11-18 P18-2）。
 *
 * ## 为什么需要它
 *
 * 用户配好机器人后收不到消息，日志里只有一句没有 id 的
 * `ignored a message from a sender outside the legacy allowlist`。
 * 而飞书的 open_id **按应用隔离**——用户必须拿到**这个 app** 下的 id。
 *
 * 试过用官方 API 查：`GET /im/v1/chats` **只返回群，不返回私聊**，
 * 所以"只跟机器人私聊过"的最常见情形查不到。
 *
 * ## 解法：包一层 SDK 的 EventDispatcher
 *
 * vendored `FeishuRuntime` 自己 `new lark.EventDispatcher({}).register({...})`
 * 注册事件处理。我们传进去的 `lark` 是我们构造的——所以可以让
 * `EventDispatcher` 这个属性返回一个**子类**，它在 `register` 时把每个
 * handler 包一层：先记账（拿到原始事件里的 sender open_id），再交给原 handler。
 *
 * 这样：
 * - **vendor 一行不改**（我们只替换它拿到的构造器）
 * - 白名单照旧生效（被拒的消息也会先被我们记下来）
 * - 用户能从日志里直接看到自己的 open_id
 */

/** 一条观察到的发送者 */
export interface ObservedSender {
  openId: string;
  /** 会话类型：p2p / group */
  chatType: string;
  /** 会话 id（群聊才有意义） */
  chatId: string;
  /** 原始事件时间 */
  at: string;
}

/** 观察器：由适配层创建，回调给壳层记账 */
export interface SenderObserver {
  (sender: ObservedSender): void;
}

/**
 * 从飞书 `im.message.receive_v1` 事件里取出发送者。
 *
 * 字段路径与 vendored `senderOpenId()` 一致（bridge.mjs）：
 * `event.sender.sender_id.open_id`，退化到 `user_id`。
 */
export function extractSender(data: unknown): ObservedSender | null {
  const ev = data as {
    sender?: { sender_id?: { open_id?: string; user_id?: string } };
    message?: { chat_id?: string; chat_type?: string };
  };
  const id = ev?.sender?.sender_id?.open_id ?? ev?.sender?.sender_id?.user_id ?? "";
  if (typeof id !== "string" || !id) return null;
  return {
    openId: id,
    chatType: ev?.message?.chat_type ?? "",
    chatId: ev?.message?.chat_id ?? "",
    at: new Date().toISOString(),
  };
}

/**
 * 把 SDK 的 `EventDispatcher` 包成"先记账、再分发"的子类。
 *
 * 只替换 `register`：事件到来时先调 `observer`，再调原 handler。
 * **不吞事件、不改事件**——原 handler 收到的对象与原来完全一致。
 */
export function wrapEventDispatcher(
  Dispatcher: new (opts: Record<string, unknown>) => {
    register(handles: Record<string, (data: unknown) => unknown>): unknown;
  },
  observer: SenderObserver,
): new (opts: Record<string, unknown>) => {
  register(handles: Record<string, (data: unknown) => unknown>): unknown;
} {
  return class ObservedDispatcher extends Dispatcher {
    register(handles: Record<string, (data: unknown) => unknown>): unknown {
      const wrapped: Record<string, (data: unknown) => unknown> = {};
      for (const [key, handler] of Object.entries(handles ?? {})) {
        wrapped[key] = (data: unknown) => {
          /**
           * 记账要**包在 try 里**：观察逻辑出错不能影响消息处理。
           * 这是观察者，不是拦截器。
           */
          try {
            const seen = extractSender(data);
            if (seen) observer(seen);
          } catch {
            /* 记账失败不阻塞渠道 */
          }
          return handler(data);
        };
      }
      return super.register(wrapped);
    }
  };
}

/**
 * 造一个 SDK 代理：只有 `EventDispatcher` 被替换，其余原样透传。
 *
 * 用 Proxy 而不是展开复制：SDK 的导出可能有 getter / 类静态属性，
 * 展开会丢；Proxy 只拦截需要的那一个属性。
 */
export function observeFeishuSdk<T extends Record<string, unknown>>(sdk: T, observer: SenderObserver): T {
  const Dispatcher = sdk.EventDispatcher as
    | (new (opts: Record<string, unknown>) => {
        register(handles: Record<string, (data: unknown) => unknown>): unknown;
      })
    | undefined;
  if (typeof Dispatcher !== "function") return sdk; // 没有这个导出就原样返回，不冒险
  const Wrapped = wrapEventDispatcher(Dispatcher, observer);
  return new Proxy(sdk, {
    get(target, prop, receiver) {
      if (prop === "EventDispatcher") return Wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}