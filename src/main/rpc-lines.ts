export const DEFAULT_RPC_LINE_MAX_BUFFER = 1024 * 1024;

/** 未换行数据超过上限：调用方必须拒绝挂起请求并回收 worker，不能继续累积。 */
export class RpcLineBufferOverflowError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBuffer: number,
  ) {
    super(`RPC stdout 半行缓冲超过上限（${actualBytes} > ${maxBuffer} 字节）`);
    this.name = "RpcLineBufferOverflowError";
  }
}

/**
 * JSONL over stdio 的行切分：不切断 UTF-8 多字节字符。
 * 参考实现：tt-11-dd/tether-ai（MIT）src/main/rpc-lines.ts，按本项目约定重写注释与边界处理。
 * maxBuffer 只限制未换行残留；一大块包含多行完整 JSONL 的数据不会被误伤。
 */
export function drainUtf8Lines(
  buffer: Buffer,
  chunk: Buffer,
  maxBuffer = DEFAULT_RPC_LINE_MAX_BUFFER,
): { rest: Buffer; lines: string[] } {
  const combined = Buffer.concat([buffer, chunk]);
  const lines: string[] = [];
  let start = 0;
  let index = combined.indexOf(0x0a, start);
  while (index >= 0) {
    const line = combined.subarray(start, index).toString("utf8").replace(/\r$/, "");
    if (line) lines.push(line);
    start = index + 1;
    index = combined.indexOf(0x0a, start);
  }
  const rest = Buffer.from(combined.subarray(start)) as Buffer;
  if (rest.length > maxBuffer) throw new RpcLineBufferOverflowError(rest.length, maxBuffer);
  return { rest, lines };
}
