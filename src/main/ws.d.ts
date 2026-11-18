/**
 * `ws` 的最小类型声明（2026-11-18 P15-3）。
 *
 * 为什么不装 @types/ws：本机 npm registry 时通时断，装类型包会让构建依赖网络。
 * 我们只用到三个 API（WebSocketServer / handleUpgrade / send），声明的成本远低于装包。
 *
 * 注意：这是**故意的最小声明**，不是完整类型。用到更多 API 时按需补。
 */
declare module "ws" {
  import type { IncomingMessage, Server } from "node:http";
  import type { Duplex } from "node:stream";

  export interface WebSocketLike {
    readonly readyState: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: "close" | "error" | "message" | "open", listener: (...args: unknown[]) => void): void;
  }

  export class WebSocketServer {
    constructor(options?: { noServer?: boolean; server?: Server });
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocketLike) => void,
    ): void;
    close(cb?: () => void): void;
  }

  export const WebSocket: {
    new (url: string, options?: unknown): WebSocketLike;
    readonly OPEN: number;
  };
}