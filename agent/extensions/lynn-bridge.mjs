/**
 * 风铃 ↔ Pi 的官方扩展（插件层，唯一允许承载风铃特有逻辑的地方）。
 *
 * 基座（@earendil-works/pi-*）原样不动：模型/provider 由 Pi 从 models.json + 环境变量解析，
 * 会话、压缩、重试、错误事件、工具调度全部由 Pi 负责。本扩展只做两件事：
 *
 *  1. 把壳下发的工具清单注册成 Pi 工具；execute() 通过**官方扩展 UI 子协议**
 *     （extension_ui_request/response 的 input dialog）把调用交回主进程执行。
 *     工具实现、权限门禁、审计仍留在壳里——这是产品边界，不是新协议。
 *  2. before_agent_start 追加 persona：每轮重读文件，改人设不用重启进程。
 *
 * 参考：docs/extensions.md（pi.registerTool / pi.on / ctx.ui）、
 *       docs/rpc-extension-ui.md（dialog 是 RPC 里扩展↔宿主的双向通道）。
 */
import * as fs from "node:fs";
import { Type } from "typebox";

export const TOOL_BRIDGE_TITLE = "lynn:tool";

/**
 * JSON Schema → TypeBox。壳里的工具面是 JSON Schema，Pi 要 TypeBox；
 * required / enum / anyOf / 数组元素都必须带走，否则模型拿到的约束比壳里弱。
 */
export function toTypeBox(schema) {
  if (!schema || typeof schema !== "object") return Type.Any();
  const desc = typeof schema.description === "string" ? { description: schema.description } : undefined;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const lits = schema.enum.map((v) => Type.Literal(v));
    return lits.length === 1 ? lits[0] : Type.Union(lits, desc);
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) return Type.Union(variants.map((v) => toTypeBox(v)));
  switch (schema.type) {
    case "number":
    case "integer":
      return Type.Number(desc);
    case "boolean":
      return Type.Boolean(desc);
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(toTypeBox(schema.items ?? {}), desc);
    case "object": {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const props = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        const t = toTypeBox(v);
        props[k] = required.has(k) ? t : Type.Optional(t);
      }
      return Type.Object(props, desc);
    }
    default:
      return Type.String(desc);
  }
}

export function readToolSpecs(env = process.env) {
  try {
    const specs = JSON.parse(env.LYNN_TOOL_SPECS || "[]");
    return Array.isArray(specs) ? specs : [];
  } catch {
    return [];
  }
}

export function readPersona(env = process.env) {
  const file = env.LYNN_PERSONA_FILE;
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** 工具结果在壳里执行完，经 extension_ui_response.value 回传 */
export function parseToolResponse(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
  } catch {
    /* 落到统一错误 */
  }
  return { ok: false, error: "壳未返回合法的工具结果" };
}

export default function lynnBridge(pi) {
  for (const spec of readToolSpecs()) {
    if (!spec?.name) continue;
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description ?? spec.name,
      parameters: toTypeBox(spec.parameters ?? { type: "object", properties: {} }),
      async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
        const payload = JSON.stringify({ name: spec.name, args: args ?? {} });
        let raw;
        try {
          raw = await ctx.ui.input(TOOL_BRIDGE_TITLE, payload, { timeout: 10 * 60_000 });
        } catch (err) {
          return {
            content: [{ type: "text", text: `工具执行失败：${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
        const result = parseToolResponse(raw);
        return {
          content: [{ type: "text", text: result.ok ? String(result.content ?? "") : `工具执行失败：${result.error ?? "壳未回应"}` }],
          details: {},
        };
      },
    });
  }

  // 在 Pi 内置 prompt 之后追加风铃人设，不覆盖内置的工具说明与安全约束。
  pi.on("before_agent_start", (event) => {
    const persona = readPersona();
    if (!persona.trim()) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${persona}` };
  });
}
