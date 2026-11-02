import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * 隔离试装（计划书 §4.11.3）的最小可复用件：
 * 「在一次性进程里把它跑起来、调用一次、再杀干净」。
 *
 * - 任何一步失败都不进主程序；
 * - 超时先 SIGTERM，2 秒后对整个进程组 SIGKILL（Windows 用 taskkill /T）；
 * - 只返回结构化结果，不把子进程输出直接当可信内容使用。
 */

export interface ProbeResult {
  ok: boolean;
  code: number | null;
  signal: string | null;
  ms: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** 杀掉整棵进程树（MCP server 常自己再起子进程） */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 已经退出就算了
  }
}

export interface McpProbeOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** 握手成功后是否顺带 tools/list */
  listTools?: boolean;
}

export interface McpProbeResult extends ProbeResult {
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  tools?: string[];
}

/**
 * 对一个 stdio MCP server 做一次真实握手：
 * initialize → 等响应 → notifications/initialized → 可选 tools/list → shutdown → 杀进程。
 * 这是 L2 能力「装之前先试装」的支点。
 */
export function probeMcpServer(opts: McpProbeOptions): Promise<McpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let serverInfo: McpProbeResult["serverInfo"];
    let protocolVersion: string | undefined;
    let tools: string[] | undefined;
    let buf = "";
    let phase: "init" | "tools" | "shutdown" = "init";

    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(opts.command),
      windowsHide: true,
    });

    const finish = (ok: boolean, extra: Partial<McpProbeResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child.pid);
      resolve({
        ok,
        code: child.exitCode,
        signal: child.signalCode ?? null,
        ms: Date.now() - started,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
        timedOut,
        serverInfo,
        protocolVersion,
        tools,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish(false, { error: `握手超时（${timeoutMs}ms）` });
    }, timeoutMs);

    const send = (msg: Record<string, unknown>) => {
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch {
        // 进程已退出，交给 exit 处理
      }
    };

    child.on("error", (err) => finish(false, { error: err.message }));
    child.on("exit", (code) => {
      if (!settled) {
        finish(false, { error: `进程提前退出（code=${code}）` });
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString("utf-8");
      stdout += chunk;
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          const r = msg.result as { serverInfo?: McpProbeResult["serverInfo"]; protocolVersion?: string } | undefined;
          if (!r) {
            finish(false, { error: `initialize 返回错误：${JSON.stringify(msg.error ?? null)}` });
            return;
          }
          serverInfo = r.serverInfo;
          protocolVersion = r.protocolVersion;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          if (opts.listTools) {
            phase = "tools";
            send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            // tools/list 最多再等 1.5s；没有就当作可用但未列工具
            setTimeout(() => {
              if (!settled && phase === "tools") finish(true, { error: "tools/list 无响应，按可用处理" });
            }, 1500);
          } else {
            send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
            finish(true);
          }
        } else if (msg.id === 2) {
          const r = msg.result as { tools?: { name?: string }[] } | undefined;
          tools = (r?.tools ?? []).map((t) => String(t.name ?? "")).filter(Boolean);
          send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
          finish(true);
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lynn", version: "0.0.1" },
      },
    });
  });
}

/** 通用一次性进程（L1 试装、健康检查都走它） */
export function runOnce(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        ms: Date.now() - started,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
        timedOut,
        error,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null, null, `超时（${timeoutMs}ms）`);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", (err) => finish(null, null, err.message));
    child.on("exit", (code, signal) => finish(code, signal));
  });
}

/** 试装时的默认 cwd：插件目录（避免插件偷偷用宿主 cwd） */
export function pluginCwd(dir: string): string {
  return path.resolve(dir);
}
