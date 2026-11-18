/**
 * vendored `.mjs` 的最小类型声明（2026-11-18 P16-1）。
 *
 * vendor 下是纯 JS（来自 dsh-im，MIT），tsc 不认识 `.mjs` 的导入。
 * 这里只声明**我们真正用到的那几个成员**——不是完整类型。
 *
 * 为什么不给整个 vendor 写声明：那等于把 2.4 MB JS 重新类型化一遍，
 * 成本远超收益，而且上游一升级就过期。声明只覆盖适配层碰到的边界，
 * 边界之内保持 `unknown`，强制调用方自己校验。
 */

declare module "*/vendor/feishu/feishu-runtime.mjs" {
  export const FeishuRuntime: new (opts: Record<string, unknown>) => {
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 是 getter 不是方法 */
    readonly status: unknown;
    setGroupResponseMode(mode: string): void;
    sendProactiveText(...args: unknown[]): Promise<unknown>;
  };
  export function createBridgeStatus(opts?: Record<string, unknown>): unknown;
}

declare module "*/vendor/feishu/state-store.mjs" {
  export const MAX_WATCHES_PER_KEY: number;
  export class StateStore {
    constructor(path: string);
    load(): Promise<void>;
  }
}

declare module "*/vendor/shared/harness-client.mjs" {
  export class HarnessClient {
    constructor(opts: Record<string, unknown>);
    health(options?: Record<string, unknown>): Promise<boolean>;
    createSession(options?: Record<string, unknown>): Promise<string>;
    ask(sessionId: string, prompt: string, options?: Record<string, unknown>): Promise<string>;
    watchHarnessEvents(options: Record<string, unknown>): Promise<void>;
  }
}