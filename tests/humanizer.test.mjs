// 写作规则插件（humanizer-stream v0.2，2026-11-15 重做）：
// 三条不变量 —— ①规则进系统提示词 ②模型输出一个字都不改 ③插件缺失/旧版一律当没装
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { memberSystemPrompt } from "../dist/main/member-runner.js";

const pluginDir = path.resolve(process.cwd(), "..", "humanizer-stream");
const hasPlugin = fs.existsSync(path.join(pluginDir, "src", "rules", "zh.js"));
// 必须在 import 之前设好：loadHumanizer 对目录做一次性记忆
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

test("插件存在时：写作规则进系统提示词，且报出注入了多少字", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    const status = kernel.handle("humanizer.status", undefined);
    assert.equal(status.loaded, true, "插件应已加载");
    assert.equal(status.enabled, true);
    assert.match(String(status.version), /^0\.2\./, "认的是 v0.2（writingRules）契约");
    assert.ok(status.chars > 200, `实际注入字数 ${status.chars}`);

    const sys = kernel.systemPrompt();
    assert.match(sys, /写作规则/, "规则段要进系统提示词");
    assert.match(sys, /硬约束/, "规则段要写明是硬约束，不是建议");
    assert.match(sys, /不展望未来|不写「希望对你有帮助」/, "要带具体约束，不是泛泛一句「写好点」");
  } finally {
    await kernel.dispose();
  }
});

test("模型输出一个字都不改：卡片、history 与落盘逐字一致", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    const live = kernel.card({ kind: "lynn", text: "", streaming: true });
    kernel.liveCard = live;
    kernel.settleAssistant(live, RAW);

    const card = kernel.handle("session.snapshot").feed.find((c) => c.id === live.id);
    assert.ok(card);
    assert.equal(card.text, RAW, "展示层不许再改写（0.1 的老毛病：界面 A、落盘 B）");
    assert.equal(kernel.history.at(-1).content, RAW, "history 是原文");
  } finally {
    await kernel.dispose();
  }
});

test("关掉开关：规则段消失，输出仍然原样", { skip: !hasPlugin }, async () => {
  const { kernel } = await boot();
  try {
    kernel.handle("config.prefs", { autoStart: false, humanizer: false });
    assert.ok(!/写作规则/.test(kernel.systemPrompt()), "关了开关就不许注入");
    assert.equal(kernel.handle("humanizer.status").chars, 0);
    assert.equal(kernel.handle("humanizer.status").enabled, false);

    const card = kernel.card({ kind: "lynn", text: RAW });
    const hit = kernel.handle("session.snapshot").feed.find((c) => c.id === card.id);
    assert.equal(hit.text, RAW);
  } finally {
    await kernel.dispose();
  }
});

test("成员写文档前也拿到约束（约束生成，不是事后改稿）", { skip: !hasPlugin }, async () => {
  const mod = await import("../dist/main/humanizer.js");
  // 上一条用例把开关关掉了，而开关是模块级状态：这里显式打开，避免用例之间串味
  mod.setHumanizerEnabled(true);
  const prose = mod.writingRulesSection("prose", 1200);
  assert.match(prose, /写作规则/);
  assert.ok(prose.length <= 1400, `成员那段不该超过预算：${prose.length}`);

  const prompt = memberSystemPrompt({
    profile: {
      name: "林工",
      role: "数据整理员",
      goal: "把源数据整理成可核对的月报",
      boundaries: ["只动工作区"],
      tools: ["read_file", "write_file"],
      model: "test-model",
      limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
      outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
      escalateWhen: "卡住",
      body: "",
    },
    brief: "【目标】整理月报\n【完成标准】数字对得上\n【材料与位置】工作区\n【限制】只做 9 月",
    deadline: "30 分钟",
    tools: ["read_file", "write_file"],
    workdir: "F:/tmp/work",
    model: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" },
    writingRules: prose,
  });
  assert.match(prompt, /写作规则/, "成员提示词要带上约束");
  assert.match(prompt, /不展望未来|不写「希望对你有帮助」/);

  // 没装插件时是恒等变换：不许出现空的规则段
  const none = memberSystemPrompt({
    profile: {
      name: "林工",
      role: "数据整理员",
      goal: "整理月报",
      boundaries: [],
      tools: ["read_file"],
      model: "m",
      limits: { maxTurns: 3, budgetTokens: 1000, wallClockMin: 5 },
      outputContract: { deliverable: "r.md", evidence: [], acceptance: [] },
      escalateWhen: "",
      body: "",
    },
    brief: "【目标】整理\n【完成标准】对得上\n【材料与位置】工作区\n【限制】只做 9 月",
    deadline: "10 分钟",
    tools: ["read_file"],
    workdir: "F:/tmp/work",
    model: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" },
    writingRules: "",
  });
  assert.ok(!/写作规则/.test(none), "空规则不该留下一个空段落");
});

test("插件目录里躺着 0.1 的输出过滤器：跳过，不加载、不报错", () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "index.js"),
    'export const api = 1;\nexport function createFilter() { return { text: (s) => s }; }\nexport default { api };\n',
    "utf8",
  );
  const script = [
    `process.env.LYNN_HUMANIZER_DIR = ${JSON.stringify(dir)};`,
    'const m = await import("./dist/main/humanizer.js");',
    "const h = await m.loadHumanizer();",
    'process.stdout.write(JSON.stringify({ loaded: Boolean(h), rules: m.writingRulesSection("chat") }));',
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.loaded, false, "api 1 的旧插件不能被当成新契约加载");
  assert.equal(out.rules, "", "没装就是空串，一个字都不注入");
});
