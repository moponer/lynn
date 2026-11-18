/**
 * 工具面实测（P2-1b 验收用）：把内核真正发出去的 tools 数组序列化，量字符与估算 tokens。
 *
 * 为什么不用“数源码片段”：源码里混着注释与实现，量出来的是文件大小，不是每次请求的负载。
 * 这里直接构造一个空内核（temp 数据根），调 allTools() 拿真实 schema。
 *
 * 用法：node scripts/tool-surface-size.mjs [--json]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Kernel } = require("../dist/main/kernel.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolsize-"));
const kernel = new Kernel(root);

try {
  await kernel.init();
  // allTools 是 private（仅 TS 层面），运行时可直接取——这正是真正发出去的那份
  const tools = kernel.allTools();
  const serialized = JSON.stringify(tools);
  // CJK 一字约 1 token，其余约 4 字符 1 token（与我们的中文提示词同口径）
  const cjk = (serialized.match(/[\u4e00-\u9fa5]/g) || []).length;
  const tokens = Math.round(cjk + (serialized.length - cjk) / 4);

  const perTool = tools
    .map((t) => {
      const s = JSON.stringify(t);
      const c = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
      return { name: t.function.name, chars: s.length, tokens: Math.round(c + (s.length - c) / 4) };
    })
    .sort((a, b) => b.tokens - a.tokens);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ count: tools.length, chars: serialized.length, tokens, perTool }, null, 2));
  } else {
    console.log(`工具件数 ${tools.length} · 序列化 ${serialized.length} 字符 · 约 ${tokens} tokens`);
    console.log("\nTop 8：");
    for (const t of perTool.slice(0, 8)) console.log(`  ${String(t.tokens).padStart(5)}  ${t.name}（${t.chars} 字符）`);
  }
} finally {
  await kernel.dispose?.();
  // Windows 上刚 dispose 完目录可能还被句柄占着：清理失败不该让整次测量以异常收场
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录留给系统清理 */
  }
}
