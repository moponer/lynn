// 假 RPC worker：只实现协议本身，用来测壳侧 AgentHost（不碰真模型）
import readline from "node:readline";

const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const pendingTools = new Map(); // toolId → resolve
let streaming = false;

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const id = msg.id;
  if (msg.type === "tool_response") {
    const resolve = pendingTools.get(id);
    if (resolve) {
      pendingTools.delete(id);
      resolve(String(msg.content ?? ""));
    }
    return;
  }
  switch (msg.type) {
    case "init":
      write({ type: "response", id, success: true, data: { tools: (msg.tools ?? []).map((t) => t.name) } });
      break;
    case "prompt":
      void handlePrompt(msg);
      break;
    case "get_state":
      write({ type: "response", id, success: true, data: { isStreaming: streaming, pendingMessageCount: 0 } });
      break;
    case "abort":
      streaming = false;
      write({ type: "agent_settled" });
      write({ type: "response", id, success: true, data: { aborted: true } });
      break;
    default:
      write({ type: "response", id, success: false, error: `unknown ${msg.type}` });
  }
});

async function handlePrompt(msg) {
  const id = msg.id;
  if (msg.text === "crash") {
    process.stderr.write("fake worker exploding on purpose");
    process.exit(3);
  }
  streaming = true;
  write({ type: "agent_start" });
  write({ type: "text_delta", text: "你好，" });
  if (msg.text === "tool") {
    const toolId = "t1";
    write({ type: "tool_request", id: toolId, name: "test_echo", arguments: { message: "pi-ok" } });
    const content = await new Promise((resolve) => {
      pendingTools.set(toolId, resolve);
      setTimeout(() => resolve("（假 worker 工具超时）"), 3000).unref?.();
    });
    write({ type: "text_delta", text: `工具返回：${content}` });
  }
  if (msg.text === "stuck") {
    // 故意漏发 agent_settled（权威状态已是空闲）：只有看门狗对账能把壳救回来
    streaming = false;
    write({ type: "response", id, success: true, data: { ok: true } });
    return;
  }
  streaming = false;
  write({ type: "text_delta", text: "世界。" });
  write({ type: "agent_settled" });
  write({ type: "response", id, success: true, data: { ok: true } });
}

write({ type: "ready", pid: process.pid });
