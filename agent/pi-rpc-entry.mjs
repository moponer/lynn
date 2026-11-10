/**
 * 【已退役 · 仅作一键回退】自建 JSONL worker，不再是默认运行时。
 *
 * 2026-11-08 起主路径是 Pi 官方 `--mode rpc`（dist/bundle/rpc-entry.js）+ 官方扩展
 * `agent/extensions/lynn-bridge.mjs`，见 src/main/pi-rpc-host.ts。
 * 本文件只在 LYNN_USE_LEGACY_RPC=1 时启用；**不要往这里加新功能**——
 * 新功能一律用 Pi 官方扩展 API 插件式接入，基座完整不变。
 *
 * Pi RPC worker（§4.1 / §4.11.4 崩溃半径）：**独立进程**里的 Agent 运行时。
 *
 * 分工（与 tether-ai 同一形状，但工具留在壳里）：
 *  - 本进程：Pi 会话、模型流式、上下文；
 *  - 主进程：工具实现、权限、审计、UI。
 *  工具调用不在这里执行——发 `tool_request` 让主进程跑，再等 `tool_response` 回来。
 *
 * 协议（JSONL over stdin/stdout，一行一条）：
 *   in : {"type":"init","tools":[{name,description,parameters}]}
 *        {"type":"prompt","id":"d1","text":"…","streamingBehavior":"followUp"?}
 *        {"type":"abort","id":"d2"}
 *        {"type":"get_state","id":"d3"}
 *        {"type":"tool_response","id":"t1","content":"…"}
 *        {"type":"shutdown"}
 *   out: {"type":"response","id":"d1","success":true,"data":{…}}
 *        {"type":"agent_start"} {"type":"text_delta","text":"…"} {"type":"agent_settled"}
 *        {"type":"tool_request","id":"t1","name":"…","arguments":{…}}
 *        {"type":"error","message":"…"}
 *
 * 环境变量：LYNN_MODEL_BASE_URL / LYNN_MODEL_API_KEY / LYNN_MODEL / LYNN_PROVIDER
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const write = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // stdout 已关：进程要退了
  }
};
const respond = (id, data) => write({ type: "response", id, success: true, data });
const respondError = (id, message) => write({ type: "response", id, success: false, error: message });

const pendingTool = new Map(); // toolId → resolve
let session = null;
let busy = false;
let toolSpecs = [];
/** persona 热更新（M1-17）：每次构建 system prompt 时都会调，改完下一轮即生效 */
let currentSystemPrompt = null;

/**
 * JSON Schema → TypeBox。**必须无损**：required / enum / anyOf / 数组元素都要带过去，
 * 否则模型拿到的参数约束比壳里真实定义弱，校验会晚一步才在工具执行时炸。
 */
function toTypeBox(schema) {
  if (!schema || typeof schema !== "object") return Type.Any();
  const desc = typeof schema.description === "string" ? { description: schema.description } : undefined;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const lits = schema.enum.map((v) => Type.Literal(v));
    return lits.length === 1 ? lits[0] : Type.Union(lits, desc);
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    return Type.Union(variants.map((v) => toTypeBox(v)));
  }
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

function buildTools(specs) {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description ?? spec.name,
    parameters: toTypeBox(spec.parameters ?? { type: "object", properties: {} }),
    execute: async (_callId, args) => {
      const toolId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      write({ type: "tool_request", id: toolId, name: spec.name, arguments: args ?? {} });
      const content = await new Promise((resolve) => {
        pendingTool.set(toolId, resolve);
        // 工具在主进程里执行；超时保护避免子进程永久挂住
        setTimeout(() => {
          if (pendingTool.delete(toolId)) resolve("工具执行超时（主进程未回应）。");
        }, 10 * 60_000).unref?.();
      });
      return { content: [{ type: "text", text: String(content) }], details: {} };
    },
  }));
}

async function init(message) {
  toolSpecs = Array.isArray(message.tools) ? message.tools : [];
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const baseUrl = process.env.LYNN_MODEL_BASE_URL;
  const apiKey = process.env.LYNN_MODEL_API_KEY;
  const modelId = process.env.LYNN_MODEL;
  if (!baseUrl || !apiKey || !modelId) throw new Error("缺少模型环境变量（LYNN_MODEL_BASE_URL / LYNN_MODEL_API_KEY / LYNN_MODEL）");
  runtime.registerProvider("lynn-user", {
    name: process.env.LYNN_PROVIDER ?? "lynn",
    baseUrl,
    api: "openai-completions",
    apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.LYNN_CONTEXT_WINDOW) || 128000,
        maxTokens: Number(process.env.LYNN_MAX_TOKENS) || 8192,
      },
    ],
  });
  await runtime.setRuntimeApiKey("lynn-user", apiKey);
  const model = runtime.getModel("lynn-user", modelId);
  if (!model) throw new Error(`Pi getModel 为空：${modelId}`);

  // 系统提示词（人设）由壳下发：Pi 的 system prompt 挂在 resource loader 上
  //
  // cwd 必须是**用户的项目根**（壳通过 LYNN_PROJECT_ROOT 下发），不能用 worker 脚本所在目录：
  // Pi 会顺着 cwd 的祖先目录找 AGENTS.md / CLAUDE.md 并塞进 system prompt，
  // 用脚本目录时它捡到了 F:\spiker\AGENTS.md（另一个 Rust 项目的开发指南），
  // 结果风铃以为自己是那个项目的 agent，满口 "hermes / browser.rs"。
  const cwd = process.env.LYNN_PROJECT_ROOT || process.cwd();
  // 内核会给 PI_CODING_AGENT_DIR（重定向到 ~/.lynn/kernel）；独立跑/测试时兜底到临时目录，
  // 不能把 undefined 传给 Pi（内部会对路径做 startsWith，直接崩）
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.tmpdir(), "lynn-pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    /* 项目根建不出来就让 Pi 自己报 */
  }
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    ...(agentDir ? { agentDir } : {}),
    settingsManager,
    // 默认**不加载**项目上下文文件（AGENTS.md / CLAUDE.md 那类）：
    // 风铃的"项目"是指挥台，不继承任何仓库的开发指南；需要时用 LYNN_CONTEXT_FILES=1 显式打开。
    noContextFiles: process.env.LYNN_CONTEXT_FILES !== "1",
    ...(typeof message.systemPrompt === "string" && message.systemPrompt.trim()
      ? { systemPrompt: message.systemPrompt }
      : {}),
    systemPromptOverride: (base) => (currentSystemPrompt && currentSystemPrompt.trim() ? currentSystemPrompt : base),
  });
  await resourceLoader.reload();
  // 加载到项目上下文文件时如实播报（默认不会发生；开了开关就得让人看见注入了什么）
  {
    const loaded = resourceLoader.getAgentsFiles?.()?.agentsFiles ?? [];
    if (loaded.length) write({ type: "context_files", files: loaded.map((f) => f.path) });
  }

  const tools = buildTools(toolSpecs);
  // 会话落盘（§4.1「崩溃后会话可续」）：worker 独占写，主进程只读索引。
  // 打不开就退回内存会话，但要在事件里说清楚，不假装持久化成功。
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  let sessionManager;
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    // LYNN_RESUME=0（session.new）→ 开新档；否则续最近一次，重启应用上下文还在
    if (process.env.LYNN_RESUME === "0") {
      sessionManager = SessionManager.create(cwd, sessionDir);
    } else {
      try {
        sessionManager = SessionManager.continueRecent(cwd, sessionDir);
      } catch {
        sessionManager = SessionManager.create(cwd, sessionDir);
      }
    }
  } catch (err) {
    write({ type: "error", message: `会话文件不可用，本次退化为内存会话：${err instanceof Error ? err.message : String(err)}` });
    sessionManager = SessionManager.inMemory();
  }
  const created = await createAgentSession({
    modelRuntime: runtime,
    model,
    sessionManager,
    customTools: tools,
    tools: tools.map((t) => t.name),
    settingsManager,
    resourceLoader,
  });
  session = created.session;
  session.subscribe((event) => {
    if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) write({ type: "text_delta", text: delta });
      return;
    }
    // 压缩是 Pi 内置行为（自动/手动），把开始与结果透给壳，界面才有交代
    if (event?.type === "compaction_start" || event?.type === "compaction_end") {
      write({
        type: event.type,
        ...(event.type === "compaction_end" && event.result
          ? { tokensBefore: event.result.tokensBefore ?? null, tokensAfter: event.result.tokensAfter ?? null }
          : {}),
      });
    }
  });
  return { tools: tools.map((t) => t.name), model: modelId };
}

async function handlePrompt(message) {
  if (!session) throw new Error("会话未初始化（先发 init）");
  // 官方字段是 message；text 是旧字段，保留兼容
  const text = typeof message.message === "string" ? message.message : String(message.text ?? "");
  if (!text.trim()) throw new Error("空消息");
  const wantSteer = message.streamingBehavior === "steer";
  const wantQueue = message.streamingBehavior === "followUp";

  // 插话：只对进行中的回合生效，不新开回合
  if (busy && wantSteer && typeof session.steer === "function") {
    await session.steer(text);
    return { ok: true, disposition: "steered" };
  }
  // 只有「真的在跑」才排队；空闲时立刻开始（否则消息被静默吞进下一轮）
  const queued = busy && wantQueue && typeof session.followUp === "function";
  busy = true;
  write({ type: "agent_start" });
  try {
    await (queued ? session.followUp(text) : session.prompt(text));
    await session.waitForIdle?.();
    return { ok: true, disposition: queued ? "queued" : "started" };
  } finally {
    busy = false;
    write({ type: "agent_settled" });
  }
}

async function handleAbort() {
  if (!session || typeof session.abort !== "function") {
    return { ok: false, aborted: false, detail: "当前 Pi 版本没有 abort()" };
  }
  await session.abort();
  // 等真停再报 settled：否则看门狗会把"还在跑"当成"已停"
  await session.waitForIdle?.();
  busy = false;
  write({ type: "agent_settled" });
  return { ok: true, aborted: true };
}

/** 排队消息数：用 Pi 自己的计数（steering + follow-up），不在壳里猜 */
function pendingCount() {
  try {
    return typeof session?.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
  } catch {
    return 0;
  }
}

function handleStats() {
  if (!session) throw new Error("会话未初始化（先发 init）");
  const s = typeof session.getSessionStats === "function" ? session.getSessionStats() : null;
  const cu = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
  const tokens = s?.tokens ?? { input: 0, output: 0, total: 0 };
  if (!s) throw new Error("当前 Pi 版本没有 getSessionStats()");
  return {
    tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0, total: tokens.total ?? 0 },
    contextTokens: cu?.tokens ?? cu?.usedTokens ?? tokens.total ?? 0,
    contextWindow: cu?.contextWindow ?? cu?.limit ?? (Number(process.env.LYNN_CONTEXT_WINDOW) || 128000),
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
  };
}

function handleClearQueue() {
  if (!session || typeof session.clearQueue !== "function") return { ok: false, steering: [], followUp: [] };
  const cleared = session.clearQueue();
  return { ok: true, steering: cleared?.steering ?? [], followUp: cleared?.followUp ?? [] };
}

async function handle(message) {
  switch (message.type) {
    case "init":
      return init(message);
    case "prompt":
      return handlePrompt(message);
    case "steer":
      return handlePrompt({ ...message, streamingBehavior: "steer" });
    case "follow_up":
      return handlePrompt({ ...message, streamingBehavior: "followUp" });
    case "abort":
      return handleAbort();
    case "clear_queue":
      return handleClearQueue();
    case "set_system_prompt":
      currentSystemPrompt = typeof message.systemPrompt === "string" ? message.systemPrompt : null;
      return { ok: true };
    case "get_stats":
      return handleStats();
    case "get_state":
      return {
        isStreaming: busy,
        pendingMessageCount: pendingCount(),
        sessionReady: Boolean(session),
        // M0-13 追溯：壳缓存 sessionId 供派单/回报记录回写
        sessionId: session?.sessionId,
        sessionFile: session?.sessionFile,
      };
    case "tool_response": {
      const resolve = pendingTool.get(message.id);
      if (resolve) {
        pendingTool.delete(message.id);
        resolve(String(message.content ?? ""));
      }
      return { ok: true };
    }
    default:
      throw new Error(`未知指令：${message.type}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    write({ type: "error", message: `无法解析的指令行：${text.slice(0, 120)}` });
    return;
  }
  if (message.type === "shutdown") {
    rl.close();
    process.exit(0);
    return;
  }
  const id = typeof message.id === "string" ? message.id : undefined;
  void handle(message).then(
    (data) => id && respond(id, data ?? {}),
    (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (id) respondError(id, detail);
      write({ type: "error", message: detail });
    },
  );
});
rl.on("close", () => process.exit(0));

process.on("uncaughtException", (err) => {
  write({ type: "error", message: `worker 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}` });
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  write({ type: "error", message: `worker 未处理的 Promise 拒绝：${err instanceof Error ? err.stack ?? err.message : String(err)}` });
});

write({ type: "ready", pid: process.pid });
