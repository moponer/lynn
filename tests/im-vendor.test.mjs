/**
 * vendor 渠道实现（P15-1）。
 *
 * 用户要求"照原插件的方式实现，不要自己造轮子"。
 * 这个文件守的是：**vendor 真的能用**，不是"复制过来了"。
 *
 * 三个层次：
 *  1. 结构完整（六个国内渠道 + shared 都在）
 *  2. **核心模块能 import**（这是最容易出问题的地方——路径一变就崩）
 *  3. 上游信息与许可记录在案（MIT，必须保留版权声明）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(here, "..", "src", "main", "im", "vendor");

const CHANNELS = ["feishu", "dingtalk", "qq", "wecom", "wecom-app", "weixin"];

test("六个国内渠道都在", () => {
  for (const ch of CHANNELS) {
    const dir = path.join(VENDOR, ch);
    assert.ok(fs.existsSync(dir), `${ch} 目录不存在`);
    const n = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).length;
    assert.ok(n >= 5, `${ch} 只有 ${n} 个 .mjs，太少了`);
  }
});

test("shared 公共层在（渠道都依赖它）", () => {
  const dir = path.join(VENDOR, "shared");
  assert.ok(fs.existsSync(dir));
  const n = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).length;
  assert.ok(n >= 50, `shared 只有 ${n} 个模块，渠道会缺依赖`);
});

/**
 * 这一条是本组最重要的：**核心模块真的能 import**。
 *
 * 移植时最容易坏的就是相对路径——原仓库 `src/channels/shared/x.mjs`
 * 里写 `import '../../../package.json'` 指到仓库根；
 * 我们放在 `src/main/im/vendor/shared/` 多了一层，就解析不到了。
 */
test("核心模块能 import（路径修正有效）", async () => {
  const core = [
    "shared/i18n.mjs",
    "shared/harness-client.mjs",
    "shared/token-bot-controller.mjs",
    "shared/connection-error.mjs",
    "shared/workspace-command.mjs",
    "shared/harness-approval.mjs",
  ];
  for (const rel of core) {
    const mod = await import(`../src/main/im/vendor/${rel}`);
    assert.ok(Object.keys(mod).length > 0, `${rel} 加载了但没有任何导出`);
  }
});

test("六个渠道的配置模块都能 import", async () => {
  /** 飞书用 plugin-config-store，其余用 config-store —— 原插件的命名差异 */
  const map = {
    feishu: "plugin-config-store.mjs",
    dingtalk: "config-store.mjs",
    qq: "config-store.mjs",
    wecom: "config-store.mjs",
    "wecom-app": "config-store.mjs",
    weixin: "config-store.mjs",
  };
  for (const [ch, file] of Object.entries(map)) {
    const mod = await import(`../src/main/im/vendor/${ch}/${file}`);
    assert.ok(Object.keys(mod).length > 0, `${ch}/${file} 没有导出`);
  }
});

/**
 * DSH 耦合面清单（实测，2026-11-18）。
 *
 * 移植前我断言"vendor 零 ctx 引用"。实测有 4 个文件用了 `ctx.`，
 * 逐个看过后分成三类——**这个清单本身就是移植的已知边界**：
 *
 *  | 文件 | ctx 用来做什么 | 处理 |
 *  |---|---|---|
 *  | `shared/group-history-access.mjs` | `ctx.tools.register` / `ctx.on(...)` 注册到 DSH | **DSH 专有，我们不加载它** |
 *  | `shared/agent-preset.mjs` | `ctx.get('agentPresets')` 取 DSH 服务 | 有 `typeof` 保护，传 undefined 即可 |
 *  | `shared/semantic/artifact.mjs` | `ctx.logger` 取日志器 | 有 fallback 到 console |
 *  | `qq/qq-runtime.mjs` | `ctx.message = ...` | **误报**：那是局部变量，不是 DSH 的 ctx |
 *
 * 所以真正的阻塞只有 `group-history-access`——它把渠道能力注册进 DSH 的工具表，
 * 而 Lynn 的工具表是 `ToolRegistry`（我们自己有）。**这一个文件不用**。
 */
const DSH_ONLY = new Set([
  // 把渠道能力注册进 DSH 的工具表——Lynn 用自己的 ToolRegistry，这个不加载
  "shared/group-history-access.mjs",
  // 下面两个**有守卫**：传 undefined 时自动降级（不注册 / 返回空清单）。
  // 它们不是阻塞，是"有 DSH 就增强"的可选功能。
  "shared/agent-preset.mjs",
  "shared/semantic/artifact.mjs",
]);

test("DSH 耦合面只有已知的那一个（超了说明移植判断要重做）", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".mjs")) {
        const rel = path.relative(VENDOR, full).split(path.sep).join("/");
        const src = fs.readFileSync(full, "utf8");
        // 去掉注释再判，避免注释里的说明被误算
        const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        /**
         * 只认 DSH 专有的用法：`ctx.tools` / `ctx.on(` / `ctx.get(` / `ctx.logger`。
         * 不认裸 `ctx.`——`qq-runtime.mjs` 里的 `ctx.message` 是局部变量，会误报。
         */
        const dshCtx = /\bctx\.(tools|on|get|logger|slots|systemPrompt|inject|effect|sessionProjections)\b/.test(noComments);
        if (dshCtx && !DSH_ONLY.has(rel)) offenders.push(rel);
      }
    }
  };
  walk(VENDOR);
  assert.deepEqual(
    offenders,
    [],
    `出现了新的 DSH 耦合（不在已知清单里）：${offenders.join(", ")}——需要重新评估这个文件能不能移植`,
  );
});

test("已知的 DSH 专有文件确实存在（清单不是空话）", () => {
  for (const rel of DSH_ONLY) {
    assert.ok(fs.existsSync(path.join(VENDOR, rel)), `${rel} 不在 vendor 里，清单该更新了`);
  }
});

test("带守卫的两个文件：传 undefined 时能降级而不是抛错", async () => {
  /**
   * 这两条是这个清单的**证据**：它们不是"依赖 DSH 所以不能用"，
   * 而是"有 DSH 就增强、没有就降级"。验证方式是真的传 undefined 调一次。
   */
  const preset = await import("../src/main/im/vendor/shared/agent-preset.mjs");
  const r = await preset.listAgentPresetCatalog(undefined);
  assert.deepEqual(r, { defaultId: "", items: [] }, "没有 ctx 时应返回空清单，而不是抛错");

  const artifact = await import("../src/main/im/vendor/shared/semantic/artifact.mjs");
  const fn = Object.values(artifact).find((v) => typeof v === "function" && /install|register/i.test(v.name));
  if (fn) {
    // 没有 ctx 时应返回 false（不注册），不抛
    assert.doesNotThrow(() => fn(undefined));
  }
});

test("上游信息与许可记录在案（MIT 必须保留版权声明）", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(VENDOR, "UPSTREAM.json"), "utf8"));
  assert.match(meta.upstream, /github\.com\/xmanrui\/dsh-im/);
  assert.equal(meta.license, "MIT");
  assert.match(meta.copyright, /xmanrui/, "必须记原作者的版权声明");
  assert.ok(meta.files > 100, `记录了 ${meta.files} 个文件，太少了`);

  const lic = fs.readFileSync(path.join(VENDOR, "LICENSE"), "utf8");
  assert.match(lic, /MIT License/);
  assert.match(lic, /xmanrui/);
});

test("vendor 不含测试文件（那些依赖 DSH 环境，跑不了）", () => {
  let tests = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.includes(".test.")) tests += 1;
    }
  };
  walk(VENDOR);
  assert.equal(tests, 0, `vendor 里有 ${tests} 个测试文件，它们的 import 会指向不存在的路径`);
});

/**
 * 六个国内渠道的 **runtime** 能加载（P15-9）。
 *
 * 比"配置模块能加载"更进一步：runtime 是真正干活的那一层，
 * 它 import 了平台 SDK。缺 SDK 时这里会明确报出缺哪个包——
 * 这比运行时才崩在某个消息上强得多。
 *
 * 依赖是按渠道懒装的（optionalDependencies）：
 *   飞书 → @larksuiteoapi/node-sdk + qrcode
 *   钉钉 → dingtalk-stream
 *   QQ   → @tencent-connect/qqbot-nodejs
 *   企微 / 企微应用 → @wecom/aibot-node-sdk
 *   微信 → （无额外 SDK，走 HTTP）
 */
test("六个国内渠道的 runtime 都能加载（缺 SDK 时报出具体包名）", async () => {
  const runtimes = {
    飞书: "feishu/feishu-runtime.mjs",
    钉钉: "dingtalk/dingtalk-runtime.mjs",
    QQ: "qq/qq-runtime.mjs",
    企业微信: "wecom/wecom-runtime.mjs",
    企微应用: "wecom-app/wecom-app-runtime.mjs",
    微信: "weixin/weixin-runtime.mjs",
  };
  const failed = [];
  for (const [label, rel] of Object.entries(runtimes)) {
    try {
      const mod = await import(`../src/main/im/vendor/${rel}`);
      assert.ok(Object.keys(mod).length > 0, `${label} 加载了但没有导出`);
    } catch (err) {
      const missing = String(err?.message ?? "").match(/Cannot find (?:module|package) '([^']+)'/);
      failed.push(`${label}：${missing ? `缺依赖 ${missing[1]}（npm install ${missing[1]}）` : String(err?.message).slice(0, 90)}`);
    }
  }
  assert.deepEqual(failed, [], `这些渠道的 runtime 加载失败：\n  ${failed.join("\n  ")}`);
});