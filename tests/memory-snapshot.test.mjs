/**
 * 记忆快照（P1-3 / B3）：会话内冻结，save_memory 不再打断 system 前缀；
 * 新事实走当轮尾部提示，切会话/换项目后进入快照。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Kernel } = await import("../dist/main/kernel.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mem-"));
}

function seedKernel(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
      prefs: { heartbeat: false, supervisor: false },
    }),
    "utf-8",
  );
  return new Kernel(root);
}

test("会话内 save_memory 不改 system；当轮尾部可见；切会话后进入快照", async () => {
  const root = tmpRoot();
  const k = seedKernel(root);
  try {
    await k.init();
    k.ensureThreadId();
    const before = k.systemPrompt();

    await k.executeToolCall("save_memory", { entry: "偏好：先给结论再给细节", scope: "memory" });
    assert.equal(k.systemPrompt(), before, "会话内记忆快照必须冻结，否则整段前缀作废");

    k.submitTurn("你好");
    const lastUser = [...k.history].reverse().find((m) => m.role === "user");
    assert.match(lastUser.content, /【记忆更新】/, "当轮要能看到刚记的事实");
    assert.match(lastUser.content, /先给结论再给细节/);

    const meta = k.threads.create("第二群", k.roots);
    k.switchThread(meta.id);
    assert.match(k.systemPrompt(), /先给结论再给细节/, "新会话应带上最新记忆");
  } finally {
    await k.dispose();
  }
});

test("forget_memory：当轮提示「别再引用」，system 仍不抖", async () => {
  const root = tmpRoot();
  const k = seedKernel(root);
  try {
    await k.init();
    k.ensureThreadId();
    await k.executeToolCall("save_memory", { entry: "事实：端口 8080", scope: "memory" });
    const meta = k.threads.create("第二群", k.roots);
    k.switchThread(meta.id);
    const withFact = k.systemPrompt();
    assert.match(withFact, /端口 8080/);

    const res = await k.executeToolCall("forget_memory", { keyword: "端口 8080", scope: "memory" });
    assert.match(res, /删掉|不再引用/);
    assert.equal(k.systemPrompt(), withFact, "删除也不许动当前会话的系统前缀");
    k.submitTurn("刚才那个端口是多少");
    const lastUser = [...k.history].reverse().find((m) => m.role === "user");
    assert.match(lastUser.content, /【记忆已删除】/);
  } finally {
    await k.dispose();
  }
});
