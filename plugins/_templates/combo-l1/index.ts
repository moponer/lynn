/**
 * 组合插件模板（P9-3）：一个插件同时提供**工具 + 语言包 + 形态层 + 命令**。
 *
 * 这个模板的存在是为了回答"不同能力怎么统一"：
 * 它们不是四种插件，而是**同一个 plugin.json 里的四个 contributes 字段**。
 * 校验器是同一个 `checkManifest()`，安装器是同一条 `importPluginPackage()`。
 *
 * 为什么组合有意义：一个"周报助手"可能同时需要
 *  - 一个 `weekly_summary` 工具（算数据）；
 *  - 几条它自己的文案（语言包）；
 *  - 一点专属样式（形态层）；
 *  - 一个斜杠命令（触发入口）。
 * 拆成四个插件会让用户装四次、启四次，还要自己对齐版本。
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

interface L1Api {
  registerTool(def: ToolDef): void;
  dataDir: string;
  log(...args: unknown[]): void;
}

export default function activate(api: L1Api) {
  api.registerTool({
    name: "echo",
    description: "把传入的 text 原样返回，并在前面标出来自哪个插件。用于验证插件装好了。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", description: "要回显的文本" } },
    },
    execute: (args) => `[lynn.template.combo] ${String(args.text ?? "")}`,
  });
  return { ok: true };
}