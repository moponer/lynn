// 量 system prompt + 工具面体积（不调模型，纯本地）。用于 token 优化前后对比。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..", "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prompt-"));
process.env.LYNN_HOME = dataRoot;
process.env.NODE_TEST_CONTEXT = "eval";

const { Kernel } = await import(pathToFileURL(path.join(repo, "dist/main/kernel.js")).href);
const k = new Kernel(dataRoot);
const sys = k.systemPrompt();
const tools = k.allTools();
const toolsJson = JSON.stringify(tools);

const summarize = (s) => ({
  chars: s.length,
  chineseChars: [...s].filter((c) => /[\u4e00-\u9fff]/.test(c)).length,
  estTokens: Math.round(s.length / 2.2), // 中文为主，粗估；真实值以端点 usage 为准
});

console.log(
  JSON.stringify(
    {
      system: summarize(sys),
      tools: summarize(toolsJson),
      toolCount: tools.length,
      toolNames: tools.map((t) => t.function.name),
      combinedEstTokens: Math.round((sys.length + toolsJson.length) / 2.2),
    },
    null,
    2,
  ),
);
