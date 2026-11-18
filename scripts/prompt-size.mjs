/**
 * 固定成本实测（P2-1b / P2-1c 验收用）：把「每次请求都要发的固定部分」量出来。
 *
 * 01 章 §5 的口径是三段相加：
 *   1. persona 固定头（composeSystemPrompt 的产物）
 *   2. 工具面（allTools 序列化后的 JSON）
 *   3. 记忆 + 项目 + 环境事实（system prompt 里其余几段）
 * 以前只有第 2 段有脚本（`tool-surface-size.mjs`），所以"固定成本降了多少"没法一次量完、
 * 也没法被测试锁住。这里补上整段，并按 prompt-compiler 的分段口径打印每段字数。
 *
 * 为什么要把真实记忆文件拷进临时根：记忆段长度取决于数据根里的 MEMORY.md / USER.md。
 * 空数据根量出来的数会偏小，与 01 章的实测不可比。所以默认从 `--data`
 * （或 LYNN_DATA_ROOT，或 ~/.lynn）**只读复制**记忆文件到临时根，再量。
 *
 * 用法：
 *   node scripts/prompt-size.mjs                 # 默认取真实数据根的记忆
 *   node scripts/prompt-size.mjs --empty         # 不拷记忆（量"最小可复现"底数）
 *   node scripts/prompt-size.mjs --json          # 机器可读
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Kernel } = require("../dist/main/kernel.js");
const { estimateTokens } = require("../dist/main/prompt-compiler.js");

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const empty = argv.includes("--empty");
const dataArg = (() => {
  const i = argv.indexOf("--data");
  return i >= 0 ? argv[i + 1] : null;
})();

/** 与 scripts/bench/score.mjs 同口径的数据根解析 */
function resolveDataRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.LYNN_DATA_ROOT) return process.env.LYNN_DATA_ROOT;
  return path.join(os.homedir(), ".lynn");
}

/** 只复制记忆相关文件：这是唯一会随使用变长、又进 system prompt 的内容 */
function seedMemory(from, to) {
  const copied = [];
  const dir = path.join(from, "memory");
  if (!fs.existsSync(dir)) return copied;
  for (const name of ["MEMORY.md", "USER.md"]) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    const dstDir = path.join(to, "memory");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, name));
    copied.push(`${name}:${fs.statSync(src).size}`);
  }
  return copied;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prompt-size-"));
const seeded = empty ? [] : seedMemory(resolveDataRoot(dataArg), root);
const kernel = new Kernel(root);

try {
  await kernel.init();
  // systemPrompt() 是 private（仅 TS 层面）：运行时直接取，量的就是真要发出去的那份
  const system = kernel.systemPrompt();
  const segments = kernel.lastPromptSegments ?? [];
  const tools = kernel.allTools();
  const toolsJson = JSON.stringify(tools);

  const systemTokens = estimateTokens(system);
  const toolsTokens = estimateTokens(toolsJson);
  const total = systemTokens + toolsTokens;

  const perTool = tools
    .map((t) => {
      const s = JSON.stringify(t);
      return {
        name: t.function.name,
        chars: s.length,
        tokens: estimateTokens(s),
        descChars: String(t.function.description ?? "").length,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const result = {
    seeded,
    system: { chars: system.length, tokens: systemTokens, segments },
    tools: { count: tools.length, chars: toolsJson.length, tokens: toolsTokens, perTool },
    fixedCost: total,
  };

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`数据根：${empty ? "(空)" : resolveDataRoot(dataArg)}${seeded.length ? ` → 已拷 ${seeded.join(" ")}` : ""}`);
    console.log(`\nsystem prompt ${system.length} 字符 ≈ ${systemTokens} tokens`);
    for (const s of segments) console.log(`  ${String(s.name).padEnd(12)} ${String(s.chars).padStart(6)} 字符`);
    console.log(`\n工具面 ${tools.length} 件 · ${toolsJson.length} 字符 ≈ ${toolsTokens} tokens`);
    console.log("\nTop 8 工具：");
    for (const t of perTool.slice(0, 8)) {
      console.log(`  ${String(t.tokens).padStart(5)} tokens  ${String(t.chars).padStart(5)} 字符  ${t.name}`);
    }
    console.log(`\n固定成本/次 ≈ ${total} tokens（system ${systemTokens} + tools ${toolsTokens}）`);
  }
} finally {
  try {
    await kernel.dispose?.();
  } catch {
    /* 关不掉也不影响读数 */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 留给系统清理 */
  }
}
// kernel 里有常驻定时器：量完直接退，别让脚本挂着
process.exit(0);
