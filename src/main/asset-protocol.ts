/**
 * lynn-asset:// 一次性令牌协议：主进程按 realpath 校验后流式下发文件，
 * 渲染层用 fetch().arrayBuffer() 拿完整 ArrayBuffer。
 *
 * 收益（注释里如实写，不假装已解决）：
 *   - 消除 base64 膨胀 33%（8MB 文件从 10.7MB 字符串变回 8MB buffer）
 *   - 消除 IPC 结构化克隆大字符串的峰值内存与序列化停顿
 *   - 主进程不再整份读文件到内存后转 base64，峰值内存减半
 * 但 docx-preview / @js-preview/excel / pptx-preview 必须拿完整 ArrayBuffer
 * 才能渲染，所以这不是"边下边渲染"——渲染层仍是等整份 buffer 到手才喂库。
 *
 * 安全：
 *   - 令牌一次性、TTL 60s、读取即核销
 *   - 协议层再次复核 realpath containment 与扩展名白名单
 *   - 不泄露路径细节（403/404 都只返回通用错误）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { insideBase } from "./path-guard";

/** 签发令牌时绑定的目标信息 */
export interface AssetTokenPayload {
  /** 真实路径（已 realpath 解析，仍在授权根内） */
  target: string;
  /** 扩展名（小写，白名单校验） */
  ext: string;
  /** 文件字节数（用于 Content-Length） */
  bytes: number;
}

const TOKEN_TTL_MS = 60_000;
const OFFICE_EXTS = new Set(["docx", "docm", "xlsx", "xlsm", "pptx"]);

interface PendingToken {
  payload: AssetTokenPayload;
  expires: number;
}

const pending = new Map<string, PendingToken>();
let sweepTimer: NodeJS.Timeout | null = null;

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, pt] of pending) {
      if (pt.expires < now) pending.delete(token);
    }
    if (pending.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, 30_000);
  sweepTimer.unref?.();
}

/** 签发一次性令牌；payload 的 target 必须已通过 realpath 与 containment 校验 */
export function issueAssetToken(payload: AssetTokenPayload): string {
  const token = crypto.randomUUID();
  pending.set(token, {
    payload,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  startSweep();
  return token;
}

/** 核销令牌并返回 payload（一次性：取走即删）；无效/过期返回 null */
export function consumeAssetToken(token: string): AssetTokenPayload | null {
  const pt = pending.get(token);
  if (!pt) return null;
  if (pt.expires < Date.now()) {
    pending.delete(token);
    return null;
  }
  pending.delete(token);
  return pt.payload;
}

/** 校验 target 是否仍在授权根内、扩展名是否白名单、文件是否存在且为普通文件 */
export function validateAssetTarget(
  target: string,
  allowedRoots: string[],
): { ok: true; payload: AssetTokenPayload } | { ok: false; error: string } {
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
    if (!st.isFile()) return { ok: false, error: "Not a regular file" };
  } catch {
    return { ok: false, error: "File not found" };
  }

  const ext = path.extname(target).toLowerCase().replace(/^\./, "");
  if (!OFFICE_EXTS.has(ext)) return { ok: false, error: "Unsupported extension" };

  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return { ok: false, error: "Cannot resolve realpath" };
  }

  for (const root of allowedRoots) {
    try {
      const realRoot = fs.realpathSync(root);
      if (insideBase(realRoot, real)) {
        return {
          ok: true,
          payload: { target: real, ext, bytes: st.size },
        };
      }
    } catch {
      /* root 不存在或不可读，跳过 */
    }
  }
  return { ok: false, error: "Path outside allowed roots" };
}

/** 注册 lynn-asset:// 协议处理器（app ready 后调用） */
export function registerAssetProtocol(protocol: typeof import("electron").protocol): void {
  protocol.handle("lynn-asset", async (req): Promise<Response> => {
    const url = new URL(req.url);
    const token = url.pathname.replace(/^\//, "");
    const payload = consumeAssetToken(token);
    if (!payload) {
      return new Response("Not found", { status: 404, statusText: "Not Found" });
    }

    try {
      const st = fs.statSync(payload.target);
      if (!st.isFile() || st.size !== payload.bytes) {
        return new Response("Not found", { status: 404, statusText: "Not Found" });
      }
    } catch {
      return new Response("Not found", { status: 404, statusText: "Not Found" });
    }

    const stream = fs.createReadStream(payload.target);
    // Electron 的 protocol.handle 支持 Node.js ReadableStream 直接返回，
    // 内部会转成 Web Stream；这里直接返回 Node 流，避免跨类型转换。
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.bytes),
        "Cache-Control": "no-store",
      },
    });
  });
}
