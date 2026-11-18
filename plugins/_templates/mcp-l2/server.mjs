#!/usr/bin/env node
/**
 * 最小 MCP server（P11-2 模板配套）。
 *
 * 为什么模板要带一个**能真跑**的 server：空壳模板只能证明"配置格式对"，
 * 证明不了"装上之后真的能调到工具"。这个 server 实现了 MCP 的三个必需方法：
 *
 *   initialize   → 握手，回报协议版本与能力
 *   tools/list   → 报出自己有哪些工具
 *   tools/call   → 执行一个工具
 *
 * 协议：stdin/stdout 各一行一条 JSON（JSON-RPC 2.0）。日志必须走 stderr——
 * 写 stdout 会被当成协议消息，那是最常见的 MCP 实现错误。
 *
 * 它只提供一个 `echo` 工具：把 text 原样返回。够验证链路，也够当起点。
 */

let buffer = "";

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

const TOOLS = [
  {
    name: "echo",
    description: "把传入的 text 原样返回，并在前面标出来自哪个 server。用于验证 MCP 链路。",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
    },
  },
];

function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lynn-demo-mcp", version: "1.0.0" },
      },
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name !== "echo") {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `没有这个工具：${name}` } };
    }
    const text = String(params?.arguments?.text ?? "");
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `[lynn-demo-mcp] ${text}` }] },
    };
  }

  // 通知（没有 id）不需要回复
  if (id === undefined) return null;

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法：${method}` } };
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // 协议错误也走 stdout（它是协议层的事），但带上错误码
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `JSON 解析失败：${String(e)}` } });
      continue;
    }
    const reply = handle(msg);
    if (reply) send(reply);
  }
});

// 日志走 stderr：stdout 是协议通道，混进日志会让客户端解析失败
process.stderr.write("[lynn-demo-mcp] 已启动，等待 stdin 上的 JSON-RPC\n");
