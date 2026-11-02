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
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT = 15_000;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitize(serverId)}__${sanitize(toolName)}`;
}

/** 读 <dataRoot>/mcp.json：{ servers: [...] }；坏文件当作没配，但要能被诊断 */
export function loadMcpConfig(dataRoot: string): { servers: McpServerConfig[]; error?: string } {
  const file = path.join(dataRoot, "mcp.json");
  if (!fs.existsSync(file)) return { servers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { servers?: unknown };
    const list = Array.isArray(raw.servers) ? raw.servers : [];
    const servers: McpServerConfig[] = [];
    for (const item of list) {
      const s = item as McpServerConfig;
      if (!s || typeof s.id !== "string" || typeof s.command !== "string") continue;
      servers.push({
        id: s.id,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: s.env && typeof s.env === "object" ? s.env : {},
        enabled: s.enabled !== false,
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : DEFAULT_TIMEOUT,
      });
    }
    return { servers };
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

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
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
      cwd: process.cwd(),
      env: { ...process.env, ...(this.cfg.env ?? {}) },
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
    this.toolDefs = Array.isArray(listed?.tools) ? listed.tools.filter((t) => t && typeof t.name === "string") : [];
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

/** 多 server 的注册表：启动、列 schema、按全名分派、收尾 */
export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private names = new Map<string, { client: McpClient; tool: string }>();
  private errors: { id: string; message: string }[] = [];

  async startAll(servers: McpServerConfig[]): Promise<void> {
    for (const cfg of servers) {
      if (cfg.enabled === false) continue;
      const client = new McpClient(cfg);
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
    return out;
  }

  has(full: string): boolean {
    return this.names.has(full);
  }

  async execute(full: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.names.get(full);
    if (!entry) throw new Error(`没有这个 MCP 工具：${full}`);
    return entry.client.call(entry.tool, args);
  }

  fingerprint(): string {
    return [...this.names.keys()].sort().join(",");
  }

  lastErrors(): { id: string; message: string }[] {
    return [...this.errors];
  }

  size(): number {
    return this.names.size;
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) await client.stop().catch(() => undefined);
    this.clients.clear();
    this.names.clear();
  }
}
