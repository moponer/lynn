// 示例 MCP server：一个 echo 工具，用来验证 mcp.json 配好之后工具面是否真的多出来。
// 用法：把 examples/mcp/mcp.example.json 复制到 ~/.lynn/mcp.json 后重启应用。
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "lynn-echo", version: "1.0.0" } });
      break;
    case "tools/list":
      reply({
        tools: [
          {
            name: "echo",
            description: "把 message 原样返回（用来确认 MCP 链路与权限门禁都通了）",
            inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          },
        ],
      });
      break;
    case "tools/call":
      reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.message ?? ""}` }] });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
