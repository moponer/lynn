/**
 * 插件 MCP 加载器（P11-2）。
 *
 * 补的是 26 章第 3 节最后一条缺口：`mcp.recipe`（L2）**没有加载器**——
 * 校验器要求必填，插件能过审能装，但不会真的连 server。
 *
 * 这组测试守四件事：
 *  1. 插件声明的 server 能被扫出来，且 id 加了插件前缀（两个插件不撞车）；
 *  2. recipe 格式错误 / 文件缺失 / 路径越界 → 报具体原因，不静默；
 *  3. 停用的插件不提供 server（与 `_state.json` 同一份真相）；
 *  4. **真的能连上并调到工具**（用模板自带的 demo server，不是 mock）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const TEMPLATES = path.join(repo, "plugins", "_templates");

const jiti = createJiti(import.meta.url);
const { scanPluginMcp, describeL2Boundary } = await jiti.import("../src/main/plugin-mcp.ts", { default: true });
const { McpRegistry } = await import("../dist/main/mcp.js");

const tmp = (p = "lynn-mcp-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

function makePlugin(root, id, over = {}) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: over.name ?? id,
    version: "1.0.0",
    apiVersion: 1,
    tier: over.tier ?? "L2",
    engines: { kernel: ">=0.0.1" },
    ...(over.recipe ? { mcp: { recipe: over.recipe } } : {}),
    contributes: {},
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

function writeRecipe(dir, servers) {
  fs.writeFileSync(path.join(dir, "recipe.json"), JSON.stringify({ servers }, null, 2), "utf8");
}

test("扫出 L2 插件的 server，id 带插件前缀", () => {
  const root = tmp();
  const dir = makePlugin(root, "lynn.a", { recipe: "recipe.json" });
  writeRecipe(dir, [{ id: "fs", command: "node", args: ["x.mjs"] }]);
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 1, `没扫到：${r.errors.join("；")}`);
  assert.equal(r.servers[0].id, "lynn.a:fs", "id 必须带插件前缀，否则两个插件会撞车");
  assert.equal(r.servers[0].pluginId, "lynn.a");
  assert.equal(r.servers[0].command, "node");
});

test("两个插件声明同名 server 不冲突", () => {
  const root = tmp();
  for (const id of ["lynn.a", "lynn.b"]) {
    const dir = makePlugin(root, id, { recipe: "recipe.json" });
    writeRecipe(dir, [{ id: "fs", command: "node" }]);
  }
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers.map((s) => s.id).sort(), ["lynn.a:fs", "lynn.b:fs"]);
});

test("非 L2 插件被忽略（L0/L1 不该有 MCP）", () => {
  const root = tmp();
  const dir = makePlugin(root, "lynn.l0", { tier: "L0", recipe: "recipe.json" });
  writeRecipe(dir, [{ id: "fs", command: "node" }]);
  assert.equal(scanPluginMcp(root).servers.length, 0);
});

test("recipe 文件缺失：报错并点名", () => {
  const root = tmp();
  makePlugin(root, "lynn.missing", { recipe: "recipe.json" });
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 0);
  assert.ok(r.errors.some((e) => /recipe\.json/.test(e)), `要点名文件：${r.errors.join("；")}`);
});

test("L2 缺少 mcp.recipe：整条被跳过（manifest 校验已拦，这里不重复报）", () => {
  /**
   * 分工要说清：`checkManifest` 已经强制 L2 必须有 `mcp.recipe`，
   * 所以缺这个字段的 manifest 在 `scanPluginMcp` 里连 `checkManifest` 都过不了，
   * 直接被跳过——错误由 `PluginHost` 统一报（避免同一个问题报两遍）。
   *
   * 这条测的是"不会因为缺字段而崩，也不会误收 server"，不是"这里会报错"。
   */
  const root = tmp();
  makePlugin(root, "lynn.norecipe", {});
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 0, "缺 recipe 的 L2 不该产出 server");
  assert.deepEqual(r.errors, [], "错误由 PluginHost 报，这里不重复");
});

test("manifest 校验确实强制 L2 必须有 mcp.recipe", async () => {
  /** 上面那条依赖这个前提，单独断言一次，前提变了会立刻红 */
  const { checkManifest } = await jiti.import("../src/main/plugin-manifest.ts", { default: true });
  const bad = checkManifest({
    id: "lynn.x",
    name: "x",
    version: "1.0.0",
    apiVersion: 1,
    tier: "L2",
    engines: { kernel: ">=0.0.1" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.field === "mcp.recipe"), `要拦 L2 缺 recipe：${JSON.stringify(bad.issues)}`);
});

test("recipe 路径越界（../）：拒绝", () => {
  const root = tmp();
  makePlugin(root, "lynn.slip", { recipe: "../../../etc/recipe.json" });
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 0);
  assert.ok(r.errors.some((e) => /越界/.test(e)), `要报越界：${r.errors.join("；")}`);
});

test("recipe 不是合法 JSON：报错但不拖垮其它插件", () => {
  const root = tmp();
  const bad = makePlugin(root, "lynn.bad", { recipe: "recipe.json" });
  fs.writeFileSync(path.join(bad, "recipe.json"), "{ 不是 JSON", "utf8");
  const good = makePlugin(root, "lynn.good", { recipe: "recipe.json" });
  writeRecipe(good, [{ id: "ok", command: "node" }]);
  const r = scanPluginMcp(root);
  assert.equal(r.servers.length, 1, "好的插件应该照常加载");
  assert.equal(r.servers[0].pluginId, "lynn.good");
  assert.ok(r.errors.length >= 1, "坏的要报错");
});

test("停用的插件不提供 server", () => {
  const root = tmp();
  const dir = makePlugin(root, "lynn.off", { recipe: "recipe.json" });
  writeRecipe(dir, [{ id: "fs", command: "node" }]);
  fs.writeFileSync(path.join(root, "plugins", "_state.json"), JSON.stringify({ "lynn.off": false }), "utf8");
  assert.equal(scanPluginMcp(root).servers.length, 0, "停用的插件不该还连着 MCP server");
});

test("server 顺序稳定（按 id 排）", () => {
  const root = tmp();
  for (const id of ["lynn.z", "lynn.a"]) {
    const dir = makePlugin(root, id, { recipe: "recipe.json" });
    writeRecipe(dir, [{ id: "s", command: "node" }]);
  }
  const a = scanPluginMcp(root).servers.map((s) => s.id);
  const b = scanPluginMcp(root).servers.map((s) => s.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort());
});

test("describeL2Boundary 如实说明隔离边界（不吹成沙箱）", () => {
  const text = describeL2Boundary();
  assert.match(text, /不在本应用的沙箱里/, "必须说清它不在沙箱里");
  assert.match(text, /不能.*保证|不能\*\*保证/, "必须列出做不到的部分");
  assert.match(text, /密钥/, "要提到密钥不继承");
});

/**
 * 这一条是**真连**：用模板自带的 demo server，走完整的
 * initialize → tools/list → tools/call 链路。
 *
 * 为什么值得一条慢测试：MCP 的坑几乎都在协议细节上
 * （日志混进 stdout、一行多 JSON、通知回了消息）。只测"扫出了配置"证明不了能用。
 */
test("真连：模板的 demo server 能启动、列出工具、调用成功", async () => {
  const tpl = path.join(TEMPLATES, "mcp-l2");
  const manifest = JSON.parse(fs.readFileSync(path.join(tpl, "plugin.json"), "utf8"));
  assert.equal(manifest.tier, "L2");

  // 用插件目录当 cwd（server.mjs 用相对路径）
  const reg = new McpRegistry({ cwd: tpl });
  try {
    await reg.startAll([
      {
        id: "lynn.template.mcp:demo",
        command: process.execPath,
        args: [path.join(tpl, "server.mjs")],
        timeoutMs: 20_000,
      },
    ]);
    const errs = reg.lastErrors();
    assert.deepEqual(errs, [], `连不上：${JSON.stringify(errs)}`);
    assert.ok(reg.size() >= 1, "一个工具都没注册上");

    const schemas = reg.schemas();
    const names = schemas.map((s) => s.function.name);
    assert.ok(
      names.some((n) => /echo/.test(n)),
      `工具面里没有 echo：${names.join(",")}`,
    );

    // 调一次，验证 tools/call 链路
    const echoName = names.find((n) => /echo/.test(n));
    const out = await reg.execute(echoName, { text: "你好 MCP" });
    assert.match(String(out), /lynn-demo-mcp/, "返回里应带 server 标识");
    assert.match(String(out), /你好 MCP/, "应回显传入的文本");
  } finally {
    await reg.stopAll().catch(() => undefined);
  }
});