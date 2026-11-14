// L1 插件隔离进程（2026-11-13 审计 #3）。
//
// 此前 L1 插件用 jiti 在主进程内直跑 TS：插件代码与内核同进程同权限，
// 死循环/长阻塞只能"放弃等待"（无法强杀），崩溃直接带走内核。
// 现在每个 L1 插件在这个独立进程里加载与执行：
//   - 崩溃隔离：插件 process.exit / 段错误不再影响内核；
//   - 超时可强杀：host 超时后直接 kill 进程树（同进程做不到的事）；
//   - api 面仍然只有 registerTool / dataDir / log——fs/net 权限强制
//     仍属声明（进程内 require 无法拦截），这里不谎报已沙箱。
//
// 协议（stdin/stdout 各一行一条 JSON，UTF-8）：
//   host → worker：{type:"activate", callId, id, entryPath, declared:[短名...], dataDir}
//                  {type:"execute", callId, short, args}
//                  {type:"deactivate", callId}
//   worker → host：{type:"activated", callId, tools:[{name,description,parameters}]}
//                  {type:"activateError", callId, message}
//                  {type:"deactivated", callId}
//                  {type:"result", callId, ok, value?, error?}
//                  {type:"log", parts:[string]}（插件 api.log 转发，无 callId）
// 任何请求都要有响应或由 host 超时击杀——进程不允许悄悄挂死。
import * as fs from "node:fs";
import readline from "node:readline";

let currentId = null;
let tools = new Map();
let deactivateHook = null;

const send = (msg) => {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {
    /* 管道断了 host 会经 exit 事件感知 */
  }
};

async function activate(msg) {
  currentId = msg.id;
  tools = new Map();
  const jitiMod = await import("jiti");
  const jiti = jitiMod.createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: true });
  const mod = (await jiti.import(msg.entryPath)) ?? {};
  const factory = mod.default;
  if (typeof factory !== "function") throw new Error("entry 必须默认导出 activate(api) 工厂函数");
  const declared = new Set(Array.isArray(msg.declared) ? msg.declared.map(String) : []);
  const dataDir = String(msg.dataDir ?? "");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    /* dataDir 建不了就等插件自己写的时候报 */
  }
  const api = {
    dataDir,
    log: (...parts) =>
      send({
        type: "log",
        parts: parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))),
      }),
    registerTool: (def) => {
      if (!def || typeof def.name !== "string" || typeof def.execute !== "function") {
        throw new Error("registerTool 需要 { name, description, parameters, execute }");
      }
      if (declared.size > 0 && !declared.has(def.name)) {
        throw new Error(`工具 "${def.name}" 未在 manifest contributes.tools 声明（先声明再注册）`);
      }
      if (tools.has(def.name)) {
        throw new Error(`工具名冲突：${def.name} 在本插件内重复注册`);
      }
      tools.set(def.name, def);
    },
  };
  await factory(api);
  deactivateHook = typeof mod.deactivate === "function" ? mod.deactivate : null;
  send({
    type: "activated",
    callId: msg.callId,
    tools: [...tools.values()].map((d) => ({
      name: d.name,
      description: typeof d.description === "string" ? d.description : "",
      parameters: d.parameters && typeof d.parameters === "object" ? d.parameters : { type: "object", properties: {} },
    })),
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // host 只会发 JSON；非 JSON 行忽略
    }
    if (msg.type === "activate") {
      try {
        await activate(msg);
      } catch (err) {
        deactivateHook = null;
        send({ type: "activateError", callId: msg.callId, message: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if (msg.type === "execute") {
      const def = tools.get(String(msg.short ?? ""));
      if (!def) {
        send({ type: "result", callId: msg.callId, ok: false, error: "工具未注册（可能刚被重载），请重试。" });
        continue;
      }
      try {
        const value = await def.execute(msg.args ?? {});
        send({ type: "result", callId: msg.callId, ok: true, value: typeof value === "string" ? value : JSON.stringify(value) });
      } catch (err) {
        send({ type: "result", callId: msg.callId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if (msg.type === "deactivate") {
      try {
        deactivateHook?.();
      } catch (err) {
        send({ type: "log", parts: [`[l1:${currentId}] deactivate 钩子出错：`, String(err)] });
      }
      deactivateHook = null;
      tools = new Map();
      send({ type: "deactivated", callId: msg.callId });
      continue;
    }
  }
  // stdin 关闭 = host 走了：自然退出
}

main().catch((err) => {
  send({ type: "log", parts: [`[l1-worker] 主循环崩溃：`, err instanceof Error ? err.stack ?? err.message : String(err)] });
  process.exit(1);
});
