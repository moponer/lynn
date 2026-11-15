// 去 AI 味插件（2026-11-15）：外部包 humanizer-stream 的宿主接线。
// 三条不变量：①卡片过滤 ②history 存原文 ③系统卡不动
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const pluginDir = path.resolve(process.cwd(), "..", "humanizer-stream");
const hasPlugin = fs.existsSync(path.join(pluginDir, "src", "index.js"));
// 必须在 import 之前设好：loadHumanizer 里对目录做一次性记忆
if (hasPlugin) process.env.LYNN_HUMANIZER_DIR = pluginDir;

const { Kernel } = await import("../dist/main/kernel.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-hz-"));

function seedModel(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "test",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "test-model",
        apiKey: { encrypted: false, data: "test-key" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
}

async function boot() {
  const root = tmp();
  seedModel(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  await kernel.init();
  return { kernel, root };
}

const RAW = "值得注意的是，我们对日志进行了分析。未来可期，让我们拭目以待。";

test("插件存在时：卡片文本过滤，history 与落盘保持原文", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    const status = kernel.handle("humanizer.status", undefined);
    assert.equal(status.loaded, true, "插件应已加载");
    assert.equal(status.enabled, true);

    const live = kernel.card({ kind: "lynn", text: "", streaming: true });
    kernel.liveCard = live;
    kernel.settleAssistant(live, RAW);

    const card = kernel.handle("session.snapshot").feed.find((c) => c.id === live.id);
    assert.ok(card, "这一轮的卡要落下来");
    assert.ok(!/值得注意/.test(card.text ?? ""), `卡上不该有套话：${card.text}`);
    assert.ok(!/未来可期/.test(card.text ?? ""), `卡上不该有升华结尾：${card.text}`);
    assert.match(card.text ?? "", /分析了日志/, "公文腔要化简");

    // 关键：上下文里必须是模型原文，否则下一轮前缀缓存会被打穿、风格会漂
    const tail = kernel.history.at(-1);
    assert.equal(tail.role, "assistant");
    assert.equal(tail.content, RAW, "history 必须存原文");
  } finally {
    await kernel.dispose();
  }
});

test("系统卡不过滤（那是代码写的，不是模型输出）", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    const sys = kernel.card({ kind: "system", text: "值得注意的是：这条是代码写的系统提示" });
    const hit = kernel.handle("session.snapshot").feed.find((c) => c.id === sys.id);
    assert.match(hit.text, /值得注意的是/, "系统卡一个字都不该动");
  } finally {
    await kernel.dispose();
  }
});

test("关掉开关后完全透传", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    kernel.handle("config.prefs", { autoStart: false, humanizer: false });
    const card = kernel.card({ kind: "lynn", text: RAW });
    const hit = kernel.handle("session.snapshot").feed.find((c) => c.id === card.id);
    assert.equal(hit.text, RAW, "关了开关就该原样显示");
    assert.equal(kernel.handle("humanizer.status", undefined).enabled, false);
  } finally {
    await kernel.dispose();
  }
});

test("成员回报卡（带 author 的发言）同样过滤", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    const card = kernel.card({
      kind: "tool",
      badge: "回报",
      title: "审计员 · task-1",
      body: "综上所述，我们对代码进行了分析，未发现严重问题。希望对你有帮助。",
      author: { kind: "member", name: "审计员", memberId: "m1" },
    });
    const hit = kernel.handle("session.snapshot").feed.find((c) => c.id === card.id);
    assert.ok(!/综上所述/.test(hit.body ?? ""), hit.body);
    assert.ok(!/希望对你有帮助/.test(hit.body ?? ""), hit.body);
    assert.match(hit.body ?? "", /分析了代码/);
  } finally {
    await kernel.dispose();
  }
});

test("写盘过滤：源码只动注释，代码本体零改动", { skip: !hasPlugin }, async () => {
  const mod = await import("../dist/main/humanizer.js");
  const code = ["// 注意：首先，进行优化", "const url = 'https://a.com//b'; // 首先，初始化", "export const x = 1;"].join("\n");
  const out = mod.humanizeFileText("a.ts", code);
  assert.ok(!out.includes("注意："), out);
  assert.ok(!out.includes("首先，"), out);
  assert.ok(out.includes("const url = 'https://a.com//b';"), "字符串里的 // 不是注释");
  assert.ok(out.includes("export const x = 1;"), "代码本体不能动");
  assert.equal(out.split("\n").length, code.split("\n").length, "注释规则不许增删行");

  const doc = mod.humanizeFileText("a.md", "值得注意的是，这份说明写完了。");
  assert.equal(doc, "这份说明写完了。");
});

test("插件缺失时不炸：一律透传", async () => {
  // 这个用例跑在独立进程里最可靠；这里只验证「关闭态」与「未加载态」都不抛错
  const mod = await import("../dist/main/humanizer.js");
  mod.setHumanizerEnabled(false);
  assert.equal(mod.humanizeDisplay(RAW), RAW);
  assert.doesNotThrow(() => mod.humanizeFileText("a.md", RAW));
  const st = mod.humanizerStatus();
  assert.equal(typeof st.loaded, "boolean");
});
