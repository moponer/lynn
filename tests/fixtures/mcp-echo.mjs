// 最小 stdio MCP server（测试用）：只实现 initialize / tools/list / shutdown
let buf = "";
process.stdin.setEncoding("utf-8");

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function handle(m) {
  if (m.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "echo", version: "0.1.0" },
      },
    });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo" }, { name: "ping" }] } });
  } else if (m.method === "shutdown") {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
    setTimeout(() => process.exit(0), 10);
  }
}

process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 忽略坏行
    }
  }
});
