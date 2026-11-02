/**
 * JSONL over stdio 的行切分：不切断 UTF-8 多字节字符。
 * 参考实现：tt-11-dd/tether-ai（MIT）src/main/rpc-lines.ts，按本项目约定重写注释与边界处理。
 */
export function drainUtf8Lines(buffer: Buffer, chunk: Buffer): { rest: Buffer; lines: string[] } {
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
  return { rest: Buffer.from(combined.subarray(start)) as Buffer, lines };
}
