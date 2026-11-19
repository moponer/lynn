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
 *
 * ## 超长输出落盘（2026-11-19 今日复盘）
 *
 * 实机：机器级 PATH 原文 24688 字、注册表应用清单、netstat 列表全被折叠成
 * 「首…尾」，完整清单拿不到，成员只能凭可见片段猜。
 *
 * 只截断不落盘 = 把数据丢了。所以超预算时调用 `spill`（若提供）把**完整原文**
 * 写成文件，并在结果里给出路径，让成员用 read_file 分段读——数据不丢、上下文不炸。
 * 没提供 spill 时退回旧的"头尾各留一半"。
 */
export function formatCommandResult(input: {
  stdout?: Buffer | Uint8Array;
  stderr?: Buffer | Uint8Array;
  exitCode?: number | null;
  budget: number;
  /** 超预算时把完整原文落盘，返回给成员看的文件路径；缺省 = 不落盘（旧行为） */
  spill?: (label: "stdout" | "stderr", full: string) => string | null;
}): string {
  const fullOut = decodeCommandOutput(input.stdout);
  const fullErr = decodeCommandOutput(input.stderr);
  const overBudget = fullOut.length > input.budget || fullErr.length > input.budget;
  let outNote = "";
  let errNote = "";
  if (overBudget && input.spill) {
    // 有落盘通道：只给清晰的预览 + 完整文件路径，完整数据在文件里
    const preview = (s: string) => {
      if (s.length <= input.budget) return s;
      const head = s.slice(0, Math.min(2000, input.budget));
      return `${head}\n…（预览只显示开头，完整 ${s.length} 字符已落盘，见下方路径，用 read_file 分段读）`;
    };
    if (fullOut.length > input.budget) {
      const p = input.spill("stdout", fullOut);
      outNote = preview(fullOut) + (p ? `\n[完整 stdout 已落盘：${p}]` : "");
    } else {
      outNote = fullOut;
    }
    if (fullErr.length > input.budget) {
      const p = input.spill("stderr", fullErr);
      errNote = preview(fullErr) + (p ? `\n[完整 stderr 已落盘：${p}]` : "");
    } else {
      errNote = fullErr;
    }
  } else {
    outNote = shapeCommandOutput(fullOut, input.budget);
    errNote = shapeCommandOutput(fullErr, input.budget);
  }
  const code = input.exitCode;
  return [
    outNote ? `stdout:\n${outNote}` : null,
    errNote ? `stderr:\n${errNote}` : null,
    code === 0 ? "exit code: 0" : `exit code: ${code ?? "非零"}`,
  ]
    .filter(Boolean)
    .join("\n");
}
