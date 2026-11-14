// 命令输出的解码与整形（2026-11-14）。两件事，都是修真实故障：
//
// 1) 解码：中文 Windows 上很多老程序按 ANSI 代码页（GBK）输出，直接 toString("utf8")
//    得到一串 U+FFFD。策略：先按 UTF-8，出现替换字符就试 GBK，谁的替换字符少用谁。
// 2) 整形：旧行为是"超过上限就砍掉尾巴"，而报错行几乎总在 stderr 末尾——等于把真正的原因丢了。
//    改成头尾各留一半，中间写明省略了多少。
import * as iconv from "iconv-lite";

/** 解码一段进程输出（Buffer → 文本） */
export function decodeCommandOutput(buf: Buffer | Uint8Array | undefined): string {
  if (!buf || buf.length === 0) return "";
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = b.toString("utf8");
  const badOf = (s: string) => (s.match(/\uFFFD/g) ?? []).length;
  if (badOf(utf8) === 0) return utf8;
  try {
    const gbk = iconv.decode(b, "gbk");
    return badOf(gbk) < badOf(utf8) ? gbk : utf8;
  } catch {
    return utf8;
  }
}

/**
 * 超预算时保留头尾：头部是"在干什么"，尾部是"为什么失败"。
 * budget 是单段（stdout / stderr 各自）的预算，与旧口径一致。
 */
export function shapeCommandOutput(text: string, budget: number): string {
  const s = text ?? "";
  if (!s || s.length <= budget) return s;
  const half = Math.max(1, Math.floor(budget / 2));
  const head = s.slice(0, half);
  const tail = s.slice(-half);
  return `${head}\n…（中间省略 ${s.length - half * 2} 字符，共 ${s.length} 字符；报错通常在尾部，已保留）\n${tail}`;
}

/**
 * 拼成成员看的结果文本。保持既有 "stdout: / stderr: / exit code:" 口径——
 * 成员与既有测试都认这个形状，不因为换了执行器就改契约。
 */
export function formatCommandResult(input: {
  stdout?: Buffer | Uint8Array;
  stderr?: Buffer | Uint8Array;
  exitCode?: number | null;
  budget: number;
}): string {
  const out = shapeCommandOutput(decodeCommandOutput(input.stdout), input.budget);
  const err = shapeCommandOutput(decodeCommandOutput(input.stderr), input.budget);
  const code = input.exitCode;
  return [
    out ? `stdout:\n${out}` : null,
    err ? `stderr:\n${err}` : null,
    code === 0 ? "exit code: 0" : `exit code: ${code ?? "非零"}`,
  ]
    .filter(Boolean)
    .join("\n");
}
