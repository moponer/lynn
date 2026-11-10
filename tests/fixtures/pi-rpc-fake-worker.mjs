/** 官方 RPC 协议的假 worker：只用于验证薄胶水层，不替代 Pi。 */
import readline from "node:readline";

const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const respond = (id, data = {}, success = true) => write({ type: "response", id, command: "test", success, data });

const pendingTools = new Map();

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "extension_ui_response") {
    const resolve = pendingTools.get(msg.id);
    if (resolve) {
      pendingTools.delete(msg.id);
      resolve(msg.value);
    }
    return;
  }
  switch (msg.type) {
    case "get_state":
      respond(msg.id, { isStreaming: false, sessionId: "fake-session", pendingMessageCount: 0 });
      break;
    case "get_session_stats":
      respond(msg.id, {
        tokens: { input: 12, output: 5, total: 17 },
        contextUsage: { tokens: 100, contextWindow: 128000 },
        sessionId: "fake-session",
        sessionFile: "/tmp/fake.jsonl",
      });
      break;
    case "prompt": {
      respond(msg.id, { disposition: "started" });
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      write({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429 quota" });
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
      if (String(msg.message).includes("tool")) {
        const id = "ui-1";
        const value = new Promise((resolve) => pendingTools.set(id, resolve));
        write({
          type: "extension_ui_request", id, method: "input",
          title: "lynn:tool", placeholder: JSON.stringify({ name: "test_echo", args: { message: "pi-ok" } }),
        });
        void value.then((raw) => {
          write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: String(raw) } });
          write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          write({ type: "agent_end", messages: [], willRetry: false });
          write({ type: "agent_settled", aborted: false });
        });
      } else {
        write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled", aborted: false });
      }
      break;
    }
    case "steer":
      respond(msg.id, { disposition: "queued" });
      break;
    case "abort":
      respond(msg.id, { ok: true });
      write({ type: "agent_settled", aborted: true });
      break;
    default:
      respond(msg.id, {});
  }
});
write({ type: "ready" });
