import path from "node:path";
import { AgentHost } from "./dist/main/agent-host.js";

const host = new AgentHost({
  entryPath: path.resolve("tests/fixtures/rpc-fake-worker.mjs"),
  model: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
  tools: [],
  onToolCall: async () => "",
  onEvent: (ev) => console.log(Date.now() % 100000, "[EVENT]", ev.type, JSON.stringify(ev.reconciled ?? "")),
  onError: (m) => console.log("[ERR]", m),
  watchdogMs: 40,
});

await host.start();
console.log("started");
const r = await host.request("prompt", { text: "stuck" });
console.log("prompt done", JSON.stringify(r), "busy=", host.isBusy());
await new Promise((r2) => setTimeout(r2, 600));
console.log("after wait busy=", host.isBusy());
await host.stop();
