/**
 * L1 工具插件模板（2026-11-18 P9-3）。
 *
 * 契约只有三条：
 *  1. **默认导出** `activate(api)`；
 *  2. 用 `api.registerTool({ name, description, parameters, execute })` 注册工具；
 *  3. `name` 用短名（`word_count`），运行时自动加前缀成 `lynn_template_tool_word_count`。
 *
 * 三个不要：
 *  - 不要在模块顶层做副作用（`activate` 之前进程可能只是被加载）；
 *  - 不要 `require("node:child_process")`（manifest 里 `proc: false`；要子进程请做 L2）；
 *  - 不要读 `~/.lynn` 下的凭据（`permissions.secrets` 走内核代理，插件永不直读）。
 *
 * 这个模板注册两个工具，覆盖两种典型形态：
 *  - `word_count`：纯计算，无 IO；
 *  - `text_stats`：用 `api.dataDir` 落一个统计文件，演示"插件有自己的私有状态目录"。
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

interface L1Api {
  registerTool(def: ToolDef): void;
  /** 插件私有状态目录（`~/.lynn/plugins/<目录>/state/`），卸载时询问是否保留 */
  dataDir: string;
  log(...args: unknown[]): void;
}

export default function activate(api: L1Api) {
  /** 数中文字（按字）与英文词 */
  api.registerTool({
    name: "word_count",
    description: "数一段文字有多少字：中文按字、英文按词，返回分开的计数。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "要数的文本" },
      },
    },
    execute: (args) => {
      const text = String(args.text ?? "");
      const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      const words = (text.match(/[A-Za-z]+/g) ?? []).length;
      return JSON.stringify({ cjk, words, total: cjk + words });
    },
  });

  /** 把统计结果落进插件自己的 dataDir（演示私有状态） */
  api.registerTool({
    name: "text_stats",
    description: "统计文本的行数、字符数与最长行，并把结果写进插件私有目录（便于跨次对比）。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "要统计的文本" },
      },
    },
    execute: (args) => {
      const text = String(args.text ?? "");
      const lines = text.split(/\r?\n/);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      const stats = { lines: lines.length, chars: text.length, longest };
      /**
       * 私有状态写在 `api.dataDir` 里，**不要**写到插件自己的安装目录——
       * 安装目录是只读语义（重装会覆盖），状态要放 dataDir 才能活过升级。
       */
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        fs.mkdirSync(api.dataDir, { recursive: true });
        fs.writeFileSync(path.join(api.dataDir, "last-stats.json"), JSON.stringify({ ...stats, at: new Date().toISOString() }), "utf8");
      } catch (e) {
        api.log("写 stats 失败（不影响返回）：", e);
      }
      return JSON.stringify(stats);
    },
  });

  return { ok: true };
}