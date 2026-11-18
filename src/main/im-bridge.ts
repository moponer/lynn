/**
 * 本地 HTTP 端点（2026-11-18 P13-2）。
 *
 * 目的：让外部 IM 网关（如 dsh-im）通过 `baseUrl` 模式接上 Lynn。
 *
 * ## 为什么需要它
 *
 * `dsh-im` 的 `HarnessClient` 有两种模式：
 *  - `apiProxy`：进程内调 DSH Host API（与框架强耦合）
 *  - **`baseUrl`：HTTP + WebSocket**（与框架解耦）
 *
 * 我们提供第二种，就能复用它的 11 个渠道实现，不用自己写适配器。
 *
 * ## 协议（照它的 `HarnessClient` 抄）
 *
 * ```
 * POST /api/<domain>.<action>
 * body: { type: "client-request", rpcId, method, payload }
 * resp: { type: "server-response", rpcId, ok, data?, error? }
 * ```
 *
 * domain 四个：`host` / `session` / `workspace` / `llm`。
 *
 * ## 安全（这是重点，不是附加项）
 *
 * 1. **只监听 127.0.0.1**——不 bind 0.0.0.0，局域网连不上；
 * 2. **token 鉴权**——每次启动生成随机 token，放在 `Authorization: Bearer`；
 * 3. **Origin 检查**——只接受本机来源，挡住浏览器跨站请求；
 * 4. **body 上限**——防止一个超大请求打满内存；
 * 5. **方法白名单**——只接受明确实现的那几个，未知方法直接拒。
 *
 * 这四条缺一条都是漏洞：只监听 loopback 挡不住本机其他程序；
 * 不校验 token 等于任何本地进程都能驱动 Agent。
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";

/** 请求体上限：8MB（图片 base64 会比较大，但再大就不该走这个通道） */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 一个 RPC 处理函数 */
/**
 * 处理函数的第二个参数：rpcId（渠道靠它把 turn 绑定到某次 prompt）与渠道标识。
 */
export type RpcHandler = (payload: unknown, meta?: { rpcId?: unknown; channel?: string }) => Promise<unknown> | unknown;

/**
 * 从请求头取渠道标识（P20-1）。
 *
 * 六个渠道**共用一个桥**，`session.prompt` 的 payload 由 vendor 生成、
 * 插不进字段。但适配层的 `fetchImpl` 是**我们提供**的，所以渠道标识走传输层：
 * 每个渠道的 Harness 在请求上带 `x-lynn-channel` 头。
 *
 * 取值**白名单化**——这个值会进日志与消息卡，不能让任意字符串透进去。
 */
const CHANNEL_IDS = new Set(["feishu", "dingtalk", "qq", "wecom", "wecom-app", "weixin"]);
function channelOf(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-lynn-channel"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && CHANNEL_IDS.has(v) ? v : undefined;
}

export interface BridgeOptions {
  /** 已实现的方法表（方法名 → 处理函数） */
  handlers: Record<string, RpcHandler>;
  /** 固定端口（0 = 随机）；默认 0 */
  port?: number;
  /**
   * 事件源（2026-11-18 P15-3）：提供后 `/api/events.mux` 才可用。
   *
   * 为什么要它：vendored 渠道的 `HarnessClient` 在 `baseUrl` 模式下
   * 不只发 HTTP，还要连一个 **WebSocket** 收事件流（`/api/events.mux`）。
   * 只实现 HTTP 的话，渠道能建会话但收不到流式回答——表现为"发消息没反应"。
   *
   * 签名：`subscribe(push)` 返回取消订阅函数。`push` 每调一次就向所有
   * 已连接的 socket 广播一帧。
   */
  subscribeEvents?(push: (envelope: unknown) => void): () => void;
}

export interface BridgeHandle {
  /** 实际监听端口 */
  port: number;
  /** 访问 token（调用方要放进 Authorization 头） */
  token: string;
  /** 完整 baseUrl，形如 http://127.0.0.1:12345 */
  baseUrl: string;
  /** 关闭服务 */
  close(): Promise<void>;
}

/** 生成本次会话的访问 token */
function makeToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * 启动本地端点。
 *
 * 刻意不用任何框架：Node 内置 `http` 够用，多一个依赖就多一份攻击面与安装成本。
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const token = makeToken();
  const allowed = new Set(Object.keys(opts.handlers));

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        // 不允许任何跨站读取
        "access-control-allow-origin": "null",
        "x-content-type-options": "nosniff",
      });
      res.end(text);
    };

    /**
     * Origin 检查：浏览器发起的跨站请求会带 Origin 头。
     * 本机网关（Node 进程）不发 Origin，所以"有 Origin 就拒"是安全的。
     */
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      reply(403, { type: "server-response", ok: false, error: "不接受跨站请求" });
      return;
    }

    // token 鉴权
    const auth = req.headers.authorization ?? "";
    const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    /**
     * 定时安全比较：普通 `===` 会在第一个不同的字节返回，
     * 理论上可被计时攻击逐字节猜出 token。本机场景风险低，但这是免费的正确性。
     */
    const want = Buffer.from(token);
    const have = Buffer.from(got);
    const okLen = want.length === have.length;
    if (!okLen || !crypto.timingSafeEqual(want, have)) {
      reply(401, { type: "server-response", result: { ok: false, error: "token 不对" } });
      return;
    }

    if (req.method !== "POST") {
      reply(405, { type: "server-response", result: { ok: false, error: "只接受 POST" } });
      return;
    }

    // 读 body（带上限）
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) {
        reply(413, { type: "server-response", ok: false, error: `请求体超过 ${MAX_BODY_BYTES / 1024 / 1024}MB` });
        return;
      }
      void (async () => {
        let msg: { type?: string; rpcId?: unknown; method?: string; payload?: unknown };
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reply(400, { type: "server-response", ok: false, error: "body 不是合法 JSON" });
          return;
        }
        if (msg.type !== "client-request") {
          reply(400, { type: "server-response", ok: false, error: `不认识的 type：${String(msg.type)}` });
          return;
        }
        /**
         * 方法名以 **URL path** 为准（它按 `/api/<method>` 发请求），
         * body 里的 method 只作交叉校验——两者不一致说明调用方有问题，直接拒。
         *
         * **必须 decodeURIComponent**：HTTP 客户端会把非 ASCII 的路径编码
         * （`/api/session.根本` → `/api/session.%E6%A0%B9%E6%9C%AC`），
         * 不解码就会与 body 里的原文对不上，把"未知方法"误判成"path 与 body 不一致"。
         */
        const rawPath = (req.url ?? "").replace(/^\/api\//, "");
        let fromPath = rawPath;
        try {
          fromPath = decodeURIComponent(rawPath);
        } catch {
          // 解码失败（畸形百分号编码）就按原样用，后面会因为"未知方法"被拒
          fromPath = rawPath;
        }
        const method = fromPath || String(msg.method ?? "");
        if (msg.method && msg.method !== method) {
          reply(400, { type: "server-response", ok: false, error: "path 与 body 的 method 不一致" });
          return;
        }
        if (!allowed.has(method)) {
          reply(404, {
            type: "server-response",
            rpcId: msg.rpcId,
            result: {
              ok: false,
              error: `没有这个方法：${method}（已实现：${[...allowed].sort().join(", ")}）`,
            },
          });
          return;
        }
        /**
         * 响应形状必须与 vendored `HarnessClient` 期待的一致（见 harness-client.mjs:1136-1147）：
         *
         * ```
         * { type: "server-response", rpcId, result: { ok, value?, error? } }
         * ```
         *
         * 它检查三样：`type === 'server-response'`、`rpcId` 相等、
         * `result.ok` 是布尔。任何一项不对都报 `harness-response-invalid`——
         * 那就是"发消息没反应"的来源。
         */
        try {
          const value = await opts.handlers[method]!(msg.payload, { rpcId: msg.rpcId, channel: channelOf(req) });
          reply(200, { type: "server-response", rpcId: msg.rpcId, result: { ok: true, value } });
        } catch (err) {
          reply(200, {
            type: "server-response",
            rpcId: msg.rpcId,
            result: { ok: false, error: err instanceof Error ? err.message : String(err) },
          });
        }
      })();
    });
  });

  /**
   * WebSocket 事件流（2026-11-18 P15-3）：`/api/events.mux`。
   *
   * 为什么必须有它：vendored 渠道的 `HarnessClient` 在 `baseUrl` 模式下
   * 用 WebSocket 收事件（见 vendor/shared/harness-mux.mjs:60）。
   * 只有 HTTP 的话，渠道能建会话、能发消息，但**收不到流式回答**——
   * 表现为"发消息没反应"。
   *
   * 鉴权用 **query token**（`?token=...`）：浏览器与 Node 的 WebSocket 构造器
   * 都不能设自定义头，所以只能放 query。我们的 `createWebSocket` 工厂会拼上它。
   */
  const wss = new WebSocketServer({ noServer: true });
  /** 已连接的客户端（广播用） */
  const clients = new Set<import("ws").WebSocketLike>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${(server.address() as AddressInfo)?.port ?? 0}`);
    if (url.pathname !== "/api/events.mux") {
      socket.destroy();
      return;
    }
    // query token 校验（与 HTTP 的 Bearer 是同一个 token）
    const got = url.searchParams.get("token") ?? "";
    const want = Buffer.from(token);
    const have = Buffer.from(got);
    if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  /**
   * 订阅事件源并广播。
   *
   * 广播而不是排队：这些帧是**状态更新**（一轮的开始/正文增量/结束），
   * 后到的客户端只关心"从现在起发生什么"，不需要补发历史。
   */
  let unsubscribe: (() => void) | null = null;
  if (opts.subscribeEvents) {
    unsubscribe = opts.subscribeEvents((envelope) => {
      if (!clients.size) return;
      const text = JSON.stringify(envelope);
      for (const ws of clients) {
        // 1 = OPEN
        if (ws.readyState === 1) {
          try {
            ws.send(text);
          } catch {
            clients.delete(ws);
          }
        }
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 只监听 loopback：不 bind 0.0.0.0，局域网连不上
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    token,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    async close() {
      try {
        unsubscribe?.();
      } catch {
        /* 取消失败不阻止关闭 */
      }
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}