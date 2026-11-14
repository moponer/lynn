// 最小 MCP 客户端（M0-07）：stdio + JSON-RPC 2.0（一行一条消息）。
// 只做三件事：initialize → tools/list → tools/call。工具名映射成 mcp__<server>__<tool>，
// 执行仍回到壳里的同一道权限门禁（executeToolCall 先 gate 再分派）。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolSchema } from "./llm";

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** 单次请求超时（默认 15s） */
  timeoutMs?: number;
  /** 懒加载（M1-22）：冷启动不连，模型首次命中意图（调 mcp_connect_server）才拉起 */
  lazy?: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT = 15_000;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * 子进程环境白名单（2026-11-13 审计 #7）：此前全量继承主进程 env——Electron 主进程
 * 环境里可能有代理、令牌类变量，MCP server 一启动就全部拿走。现在只给工具链
 * 跑起来必需的几个键（PATH/PATHEXT/SYSTEMROOT/COMSPEC/TEMP/TMP），其余一律
 * 用显式声明的 cfg.env 覆盖/补充；没声明的拿不到。
 */
const CHILD_ENV_KEYS = ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"] as const;

export function mcpChildEnv(cfgEnv: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...(cfgEnv ?? {}) };
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitize(serverId)}__${sanitize(toolName)}`;
}

/** 读 <dataRoot>/mcp.json：{ servers: [...] }；坏文件当作没配，但要能被诊断 */
export function loadMcpConfig(dataRoot: string): { servers: McpServerConfig[]; error?: string } {
  return loadMcpConfigAt(path.join(dataRoot, "mcp.json"));
}

/** 读任意路径的 mcp.json（项目级配置也走同一套校验）；重复 server id 按 §4.11.5 报明冲突并去重（保首个） */
export function loadMcpConfigAt(file: string): { servers: McpServerConfig[]; error?: string } {
  if (!fs.existsSync(file)) return { servers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { servers?: unknown };
    const list = Array.isArray(raw.servers) ? raw.servers : [];
    const servers: McpServerConfig[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const s = item as McpServerConfig;
      if (!s || typeof s.id !== "string" || typeof s.command !== "string") continue;
      if (seen.has(s.id)) {
        const first = servers.find((x) => x.id === s.id);
        const cmdOf = (c: McpServerConfig) => [c.command, ...(c.args ?? [])].join(" ");
        errors.push(`server id 冲突：「${s.id}」出现多次，保留首个（${first ? cmdOf(first) : "?"}），忽略后续（${cmdOf(s)}）——重名拒绝，请改配置`);
        continue;
      }
      seen.add(s.id);
      servers.push({
        id: s.id,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: s.env && typeof s.env === "object" ? s.env : {},
        enabled: s.enabled !== false,
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : DEFAULT_TIMEOUT,
        lazy: s.lazy === true,
      });
    }
    return { servers, error: errors.length ? errors.join("；") : undefined };
  } catch (err) {
    return { servers: [], error: `mcp.json 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private toolDefs: McpToolDef[] = [];
  private stderr = "";
  private readonly cfg: McpServerConfig;
  private readonly cwd?: string;

  constructor(cfg: McpServerConfig, opts?: { cwd?: string }) {
    this.cfg = cfg;
    this.cwd = opts?.cwd;
  }

  get id(): string {
    return this.cfg.id;
  }

  get running(): boolean {
    return Boolean(this.child);
  }

  async start(): Promise<McpToolDef[]> {
    if (this.child) return this.toolDefs;
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      // cwd 钉到数据根（审计 #7）：GUI 下 process.cwd() 是安装目录或 C:\，
      // MCP server 相对读写会落到意想不到的地方；显式声明 cwd 的配置仍优先。
      cwd: this.cwd ?? process.cwd(),
      env: mcpChildEnv(this.cfg.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.once("exit", (code) => {
      this.child = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${this.cfg.id} 退出（code ${code ?? "?"}）${this.stderr ? `：${this.stderr.trim()}` : ""}`));
      }
      this.pending.clear();
    });
    child.once("error", (err) => {
      this.child = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${this.cfg.id} 启动失败：${err.message}`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lynn", version: "0.0.1" },
    });
    this.notify("notifications/initialized", {});
    const listed = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    // 同 server 内工具重名：保留首个并记 stderr（工具名冲突会让模型分不清调用目标）
    const all = Array.isArray(listed?.tools) ? listed.tools.filter((t) => t && typeof t.name === "string") : [];
    const seen = new Set<string>();
    this.toolDefs = [];
    for (const t of all) {
      if (seen.has(t.name)) {
        this.stderr += `\n[mcp ${this.cfg.id}] 工具重名：${t.name} 出现多次，保留首个，忽略后续`;
        continue;
      }
      seen.add(t.name);
      this.toolDefs.push(t);
    }
    return this.toolDefs;
  }

  tools(): McpToolDef[] {
    return [...this.toolDefs];
  }

  /** 调用一个工具：文本内容直接拼；isError 明确报错，不假装成功 */
  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.child) throw new Error(`MCP server ${this.cfg.id} 没有在运行`);
    const result = (await this.request("tools/call", { name: toolName, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : c?.type ? `[${c.type}]` : ""))
      .filter(Boolean)
      .join("\n");
    if (result?.isError) return `MCP 工具报错：${text || "（无详情）"}`;
    return text || "（工具没有返回文本内容）";
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP 会话已关闭"));
    }
    this.pending.clear();
    child.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // MCP server 偶尔会往 stdout 打日志，忽略掉
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP 请求失败"));
    else pending.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`MCP server ${this.cfg.id} 没有在运行`));
    const id = this.nextId++;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

/** 意图元工具（M1-22 lazy-mcp）：模型首次想用某个懒加载 server 的能力时先调它 */
export const MCP_CONNECT_TOOL = "mcp_connect_server";

/** 多 server 的注册表：启动、列 schema、按全名分派、收尾 */
export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private names = new Map<string, { client: McpClient; tool: string }>();
  private errors: { id: string; message: string }[] = [];
  /** 懒加载 server：冷启动不连，命中意图才拉起 */
  private lazyCfgs = new Map<string, McpServerConfig>();
  /** 子进程 cwd 钉扎（审计 #7）：内核传入数据根；不传保持旧行为 */
  private readonly cwd?: string;

  constructor(opts?: { cwd?: string }) {
    this.cwd = opts?.cwd;
  }

  async startAll(servers: McpServerConfig[]): Promise<void> {
    // 每次重载重新记账：上一次的失败不该赖在这张表上
    this.errors = [];
    for (const cfg of servers) {
      if (cfg.enabled === false) continue;
      if (cfg.lazy === true) {
        this.lazyCfgs.set(cfg.id, cfg);
        continue;
      }
      const client = new McpClient(cfg, { cwd: this.cwd });
      try {
        const tools = await client.start();
        this.clients.set(cfg.id, client);
        for (const t of tools) {
          this.names.set(mcpToolName(cfg.id, t.name), { client, tool: t.name });
        }
      } catch (err) {
        this.errors.push({ id: cfg.id, message: err instanceof Error ? err.message : String(err) });
        await client.stop().catch(() => undefined);
      }
    }
  }

  private connectSchema(): ToolSchema {
    const ids = [...this.lazyCfgs.keys()].sort();
    return {
      type: "function",
      function: {
        name: MCP_CONNECT_TOOL,
        description: `连接一个按需加载的扩展 server（当前待命：${ids.length ? ids.join("、") : "无"}）。成功后它的工具会出现在你的工具面，下一轮即可直接调用；连接一次即可，不用重复调。`,
        parameters: {
          type: "object",
          required: ["server"],
          properties: {
            server: { type: "string", enum: ids, description: "要连接的 server id" },
          },
        },
      },
    };
  }

  schemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const [full, entry] of this.names) {
      const def = entry.client.tools().find((t) => t.name === entry.tool);
      out.push({
        type: "function",
        function: {
          name: full,
          description: `[MCP ${entry.client.id}] ${def?.description ?? entry.tool}`,
          parameters: def?.inputSchema ?? { type: "object", properties: {} },
        },
      });
    }
    if (this.lazyCfgs.size > 0) out.push(this.connectSchema());
    return out;
  }

  has(full: string): boolean {
    return this.names.has(full) || full === MCP_CONNECT_TOOL;
  }

  /** 连接懒加载 server：真拉起子进程，工具注册进工具面；失败如实抛错（保持待命可重试） */
  private async connectLazy(serverId: string): Promise<string> {
    const cfg = this.lazyCfgs.get(serverId);
    if (!cfg) {
      const ids = [...this.lazyCfgs.keys()].sort().join("、") || "无";
      throw new Error(`没有这个按需加载的 server：${serverId}（待命清单：${ids}）`);
    }
    const client = new McpClient(cfg, { cwd: this.cwd });
    try {
      const tools = await client.start();
      this.clients.set(cfg.id, client);
      const fulls: string[] = [];
      for (const t of tools) {
        const full = mcpToolName(cfg.id, t.name);
        this.names.set(full, { client, tool: t.name });
        fulls.push(full);
      }
      this.lazyCfgs.delete(cfg.id);
      return `已连接 ${cfg.id}，接入 ${fulls.length} 个工具：${fulls.join("、") || "（无工具）"}。工具面已更新，下一轮即可直接调用，无需再次连接。`;
    } catch (err) {
      await client.stop().catch(() => undefined);
      throw new Error(`连接 ${cfg.id} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async execute(full: string, args: Record<string, unknown>): Promise<string> {
    if (full === MCP_CONNECT_TOOL) {
      return this.connectLazy(String(args?.server ?? ""));
    }
    const entry = this.names.get(full);
    if (!entry) throw new Error(`没有这个 MCP 工具：${full}`);
    return entry.client.call(entry.tool, args);
  }

  fingerprint(): string {
    const keys = [...this.names.keys()];
    // lazy 待命的也计入：连上后清单变化 → 指纹变化 → worker 工具面随之刷新
    for (const id of this.lazyCfgs.keys()) keys.push(`lazy:${id}`);
    return keys.sort().join(",");
  }

  lastErrors(): { id: string; message: string }[] {
    return [...this.errors];
  }

  size(): number {
    return this.names.size;
  }

  /**
   * 给界面看的实况：哪些连上了、各带几个工具、哪些待命、哪些连不上。
   * 只报事实——没连上的 server 不会因为"配置里写了"就显示成已连接。
   */
  status(): { id: string; connected: boolean; lazy: boolean; tools: number; error?: string }[] {
    const out: { id: string; connected: boolean; lazy: boolean; tools: number; error?: string }[] = [];
    for (const [id, client] of this.clients) {
      out.push({ id, connected: true, lazy: false, tools: client.tools().length });
    }
    for (const id of this.lazyCfgs.keys()) {
      out.push({ id, connected: false, lazy: true, tools: 0 });
    }
    for (const e of this.errors) {
      if (!out.some((s) => s.id === e.id)) out.push({ id: e.id, connected: false, lazy: false, tools: 0, error: e.message });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  lazyIds(): string[] {
    return [...this.lazyCfgs.keys()].sort();
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) await client.stop().catch(() => undefined);
    this.clients.clear();
    this.names.clear();
    this.lazyCfgs.clear();
  }
}
