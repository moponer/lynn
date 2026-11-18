/**
 * IM 网关的 RPC 映射（P13-3）。
 *
 * 这层的风险不是"功能不全"，而是**谎报**：
 * `host.describe` 里列了某个方法、调用方就会去调它；
 * 如果它其实没实现，调用方会拿到一个错误，然后基于错误状态继续跑。
 *
 * 所以测试守三件事：
 *  1. `host.describe` 声明的每个方法**都真的能调**；
 *  2. 不支持的方法**明确拒绝**，不返回假成功；
 *  3. 参数缺失时报清楚缺什么，不是静默返回空。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildImHandlers } = await jiti.import("../src/main/im-handlers.ts", { default: true });

/** 假内核：记录调用，返回哨兵值 */
function fakeDeps(over = {}) {
  const calls = [];
  const deps = {
    listThreads: () => {
      calls.push(["listThreads"]);
      return [
        { id: "t-1", title: "第一群", updatedAt: "2026-11-18T00:00:00Z" },
        { id: "t-2", title: "第二群" },
      ];
    },
    createThread: (title) => {
      calls.push(["createThread", title]);
      return "t-new";
    },
    switchThread: (id) => calls.push(["switchThread", id]),
    renameThread: (id, title) => calls.push(["renameThread", id, title]),
    threadHistory: (id) => {
      calls.push(["threadHistory", id]);
      return [{ role: "user", text: "你好" }];
    },
    currentThreadId: () => "t-1",
    submitTurn: (text, threadId) => {
      calls.push(["submitTurn", text, threadId]);
    },
    waitTurn: async () => {
      calls.push(["waitTurn"]);
    },
    abortTurn: () => calls.push(["abortTurn"]),
    listModels: () => [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "qwen", label: "Qwen" },
    ],
    currentModelId: () => "deepseek-chat",
    selectModel: (id, threadId) => calls.push(["selectModel", id, threadId]),
    listWorkspaces: () => [{ path: "F:\\proj", name: "proj" }],
    createWorkspace: (p) => calls.push(["createWorkspace", p]),
    version: () => "0.0.2-test",
    ...over,
  };
  return { deps, calls };
}

test("host.describe：如实报版本与能力", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  const r = h["host.describe"]({});
  assert.equal(r.name, "lynn");
  assert.equal(r.version, "0.0.2-test");
  assert.ok(Array.isArray(r.methods) && r.methods.length > 0);
  assert.equal(r.streaming, false, "本轮没有 WebSocket，必须如实说");
});

test("host.describe 声明的每个方法都真的存在且能调", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  const described = h["host.describe"]({}).methods;
  for (const m of described) {
    assert.equal(typeof h[m], "function", `${m} 在 host.describe 里声明了，但没有实现——这是谎报`);
  }
});

test("host.describe 的 unsupported 清单里每个方法都真的会抛错", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  const unsupported = Object.keys(h["host.describe"]({}).unsupported);
  for (const m of unsupported) {
    assert.equal(typeof h[m], "function", `${m} 应该在 handlers 里有对应的拒绝实现`);
    assert.throws(() => h[m]({}), /不支持|Lynn 没有|暂未/, `${m} 应明确拒绝，而不是返回假成功`);
  }
});

test("session.list：列出会话并标出当前那个", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  const r = h["session.list"]({});
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[0].current, true, "t-1 是当前会话");
  assert.equal(r.sessions[1].current, false);
  assert.equal(r.sessions[0].title, "第一群");
});

test("session.create：建会话并返回 id", () => {
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  const r = h["session.create"]({ title: "IM 群" });
  assert.equal(r.id, "t-new");
  assert.deepEqual(calls.find((c) => c[0] === "createThread"), ["createThread", "IM 群"]);
});

test("session.prompt：把 text 与 sessionId 透传给 submitTurn", async () => {
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  const r = await h["session.prompt"]({ text: "看一下这张图", sessionId: "t-2" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.find((c) => c[0] === "submitTurn"), ["submitTurn", "看一下这张图", "t-2"]);
});

test("session.prompt：空 text 明确报错，不静默成功", async () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  await assert.rejects(() => h["session.prompt"]({ text: "   " }), /text 不能为空/);
});

test("session.prompt：waitTurn 抛错要透传出去（不吞）", async () => {
  const { deps } = fakeDeps({
    waitTurn: async () => {
      throw new Error("模型没配置");
    },
  });
  const h = buildImHandlers(deps);
  await assert.rejects(() => h["session.prompt"]({ text: "hi" }), /模型没配置/);
});

test("session.prompt：先启动再等待（顺序不能反）", async () => {
  /**
   * 顺序是这条链的关键：`submitTurn` 同步返回，它之后才可能有 busy 事件。
   * 如果先 `waitTurn` 再 `submitTurn`，会在 busy 还没置起来时误判完成。
   */
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  await h["session.prompt"]({ text: "hi" });
  const order = calls.filter((c) => c[0] === "submitTurn" || c[0] === "waitTurn").map((c) => c[0]);
  assert.deepEqual(order, ["submitTurn", "waitTurn"], `顺序错了：${order.join(" → ")}`);
});

test("session.cancel：调 abortTurn", () => {
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  assert.deepEqual(h["session.cancel"]({}), { ok: true });
  assert.deepEqual(calls.find((c) => c[0] === "abortTurn"), ["abortTurn"]);
});

test("session.history：默认读当前会话", () => {
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  const r = h["session.history"]({});
  assert.ok(Array.isArray(r.messages));
  assert.deepEqual(calls.find((c) => c[0] === "threadHistory"), ["threadHistory", "t-1"]);
});

test("session.rename：缺参数明确报错", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  assert.throws(() => h["session.rename"]({ sessionId: "t-1" }), /需要 sessionId 与 title/);
});

test("llm.models / session.models：都返回模型清单", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  for (const m of ["llm.models", "session.models"]) {
    const r = h[m]({});
    assert.equal(r.models.length, 2);
    assert.equal(r.current, "deepseek-chat");
  }
});

test("session.selectModel：缺 modelId 明确报错", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  assert.throws(() => h["session.selectModel"]({}), /需要 modelId/);
});

test("workspace.list / create：正常映射", () => {
  const { deps, calls } = fakeDeps();
  const h = buildImHandlers(deps);
  assert.equal(h["workspace.list"]({}).workspaces.length, 1);
  assert.deepEqual(h["workspace.create"]({ path: "F:\\new" }), { ok: true });
  assert.deepEqual(calls.find((c) => c[0] === "createWorkspace"), ["createWorkspace", "F:\\new"]);
});

test("不支持的方法：错误名可辨识（调用方能区分「没实现」与「出错了」）", () => {
  const { deps } = fakeDeps();
  const h = buildImHandlers(deps);
  try {
    h["session.fork"]({});
    assert.fail("应当抛错");
  } catch (e) {
    assert.equal(e.name, "UnsupportedMethod", "错误名要让调用方能判断");
  }
});