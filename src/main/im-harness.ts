/**
 * vendor 加载与 Harness 构造的公共部分（2026-11-18 P19-1）。
 *
 * 六个国内渠道有两件事完全一样：
 *  1. 从 `dist/main/im/vendor/` 加载 `.mjs`
 *  2. 造一个指向本地桥的 `HarnessClient`（注入 token）
 *
 * 所以收成这里一份，渠道适配层只关心"自己的配置形状"。
 *
 * ## 两个必须的细节（都踩过）
 *
 * **① tsc 会把 `import()` 降级成 `require()`**
 * 本项目的 main 编译目标是 CommonJS，而 vendor 是 `.mjs`——
 * `require()` 加载不了 `.mjs`（报 `Cannot find module './vendor/...mjs'`）。
 * 用 `Function` 包一层保留原生 `import()`。
 *
 * **② 路径要用 `__dirname` + `pathToFileURL`**
 * dist 与 src 的目录深度不同，相对路径编译后会指向不存在的位置。
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 原生 ESM import（绕开 tsc 的 require 降级） */
const importEsm = (spec: string): Promise<Record<string, unknown>> =>
  (Function("s", "return import(s)") as (s: string) => Promise<Record<string, unknown>>)(spec);

/** vendor 目录（编译后在 `dist/main/im/vendor`） */
export function vendorDir(): string {
  return path.join(__dirname, "im", "vendor");
}

/** 加载 vendor 里的一个模块 */
export async function loadVendor(rel: string): Promise<Record<string, unknown>> {
  return importEsm(pathToFileURL(path.join(vendorDir(), rel)).href);
}

/**
 * 造 HarnessClient，指向我们的本地桥。
 *
 * - `fetchImpl`：vendor **自己不发鉴权头**（它假设宿主端点不验），
 *   我们的桥要 Bearer token，所以在这里加；
 * - `createWebSocket`：WS 构造器不能设自定义头，token 只能走 query。
 */
export async function createVendorHarness(
  bridgeBaseUrl: string,
  bridgeToken: string,
  /**
   * 渠道标识（P20-1）：会作为 `x-lynn-channel` 头随每个 RPC 发出去。
   *
   * 为什么用头而不是参数：六个渠道**共用一个桥**，`session.prompt` 的
   * payload 由 vendor 生成，我们插不进字段。但 `fetchImpl` 是**我们提供**的，
   * 所以能在传输层加一个头——vendor 一行不改，桥也能知道是谁在调。
   */
  channel = "",
): Promise<unknown> {
  const { HarnessClient } = (await loadVendor("shared/harness-client.mjs")) as {
    HarnessClient: new (opts: Record<string, unknown>) => unknown;
  };
  return new HarnessClient({
    baseUrl: bridgeBaseUrl,
    autostart: false,
    fetchImpl: (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: {
          ...((init?.headers as Record<string, string>) ?? {}),
          authorization: `Bearer ${bridgeToken}`,
          ...(channel ? { "x-lynn-channel": channel } : {}),
        },
      }),
    createWebSocket: (url: string) => {
      const u = new URL(url);
      u.searchParams.set("token", bridgeToken);
      const WS = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket;
      if (!WS) throw new Error("当前 Node 没有全局 WebSocket（需要 22+）");
      return new WS(u.toString());
    },
  });
}

/**
 * 从磁盘加载状态。
 *
 * **必须显式调用**：vendor 的 runtime 不会自己调 `state.load()`
 * （DSH 的胶水层负责），我们替代了那一层，就得自己补上。
 *
 * 不调的后果（实测过）：
 *  - `sessionFor` / `setSession` 的**会话映射不落盘** → 每次重启后
 *    同一个飞书群会被当成新会话，**在界面上新开一个线程**；
 *  - `seenMessageIds` 丢失 → 飞书重投的消息可能被当成新消息再跑一遍；
 *  - `deferred` / `watches` 也丢。
 */
export async function loadStateStore(state: unknown): Promise<void> {
  const load = (state as { load?: () => Promise<void> } | null)?.load;
  if (typeof load === "function") await load.call(state);
}

/**
 * 统一的日志器（vendor 里 `logger` 是 console 形态）。
 *
 * 把 info/warn/error 都收进结构化日志，debug 丢掉——
 * 渠道的 debug 太吵，而且不提供诊断价值。
 */
export function vendorLogger(log: (event: string, detail?: Record<string, unknown>) => void, prefix: string): Console {
  const to = (level: string) => (...args: unknown[]) =>
    log(`${prefix}_${level}`, { msg: args.map((a) => String(a ?? "")).join(" ").slice(0, 240) });
  return {
    info: to("info"),
    warn: to("warn"),
    error: to("error"),
    debug: () => {},
    log: to("info"),
    trace: () => {},
  } as unknown as Console;
}