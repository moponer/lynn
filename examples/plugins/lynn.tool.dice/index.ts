/**
 * 示例 L1 进程内扩展（§4.2.1）：jiti 直跑，无需编译。
 *
 * 契约：
 *  - 默认导出 activate(api) 工厂；api.registerTool({ name, description, parameters, execute })
 *  - 工具短名必须先在 plugin.json 的 contributes.tools 声明
 *  - 可选导出 deactivate()：停用钩子（反注册前调用）
 */
export default function activate(api: {
  registerTool(def: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => string | Promise<string>;
  }): void;
  log(...args: unknown[]): void;
}): void {
  api.registerTool({
    name: "roll",
    description: "掷一颗 N 面骰子（默认 6 面），返回点数。仅用于演示与决断辅助。",
    parameters: {
      type: "object",
      properties: { sides: { type: "number", description: "骰子面数，默认 6" } },
    },
    execute: async (args: Record<string, unknown>) => {
      const sides = Math.max(2, Math.floor(Number(args.sides) || 6));
      const n = 1 + Math.floor(Math.random() * sides);
      return `骰子（${sides} 面）掷出：${n}`;
    },
  });
  api.log("骰子工具已就绪");
}

export function deactivate(): void {
  console.log("[lynn.tool.dice] 反注册完成");
}
