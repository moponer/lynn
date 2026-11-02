// 测试用最小 MCP server（stdio + 一行一条 JSON-RPC）
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const TOOLS = [
  {
    name: "echo",
    description: "把 message 原样返回",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "boom",
    description: "总是返回错误（用来测 isError 不当成功）",
    inputSchema: { type: "object", properties: {} },
  },
];

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-fixture", version: "1.0.0" } });
      break;
    case "tools/list":
      reply({ tools: TOOLS });
      break;
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === "echo") {
        reply({ content: [{ type: "text", text: `echo:${args.message}` }] });
      } else if (name === "boom") {
        reply({ content: [{ type: "text", text: "炸了" }], isError: true });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `没有这个工具：${name}` } });
      }
      break;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
