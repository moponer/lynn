/**
 * 插件模板可用性（P9-3 / 25 章第 4.2 节「模板必须一直能装」）。
 *
 * 为什么要有这组测试：模板是**给 agent 复制的起点**。如果模板本身装不上、
 * 或者装上跑不起来，那比没有模板更糟——agent 会照着错的学，而且以为是对的。
 *
 * 所以这里不只验结构，还验三件真事：
 *  1. 五个模板都能**导入**（走真实 `importPluginPackage`）；
 *  2. L1 模板能**激活**并调到它注册的工具（走真实 `L1Host`）；
 *  3. 每个模板都有 README（agent 靠它知道怎么改）。
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
const { importPluginPackage, readPackage } = await jiti.import("../src/main/plugin-package.ts", { default: true });
const { L1Host } = await import("../dist/main/plugin-l1.js");

const tmp = (p = "lynn-tpl-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 模板目录清单 */
function templateDirs() {
  return fs
    .readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

test("六个模板都在（覆盖 L0 主题 / L0 语言包 / L1 工具 / U 界面 / L1 组合 / L2 MCP）", () => {
  const dirs = templateDirs();
  assert.deepEqual(dirs, ["combo-l1", "lang-l0", "mcp-l2", "theme-l0", "tool-l1", "ui-u"]);
});

test("每个模板都能过包校验（结构与 manifest 都对）", () => {
  for (const name of templateDirs()) {
    const { pkg, issues } = readPackage(path.join(TEMPLATES, name));
    assert.ok(pkg, `${name} 读不出来：${issues.map((i) => i.message).join("；")}`);
    assert.deepEqual(
      issues.filter((i) => i.stage !== "size"),
      [],
      `${name} 有校验问题：${issues.map((i) => `[${i.stage}] ${i.message}`).join("；")}`,
    );
  }
});

test("每个模板都有 README（agent 靠它知道怎么改）", () => {
  for (const name of templateDirs()) {
    const readme = path.join(TEMPLATES, name, "README.md");
    assert.ok(fs.existsSync(readme), `${name} 缺 README.md——模板不带说明等于没教`);
    const text = fs.readFileSync(readme, "utf8");
    assert.ok(text.length > 100, `${name} 的 README 太短（${text.length} 字）`);
  }
});

test("每个模板都能真的装进 plugins/", () => {
  for (const name of templateDirs()) {
    const data = tmp("lynn-tpldata-");
    const r = importPluginPackage(path.join(TEMPLATES, name), data);
    assert.equal(r.ok, true, `${name} 装不上：${JSON.stringify(r.issues)}`);
    assert.ok(fs.existsSync(path.join(data, "plugins", r.id, "plugin.json")), `${name} 装完找不到 plugin.json`);
  }
});

test("L1 模板能激活，并调到它注册的工具（这是模板的核心价值）", async () => {
  for (const name of ["tool-l1", "combo-l1"]) {
    const dir = path.join(TEMPLATES, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    const host = new L1Host({
      listEntries: () => [{ id: manifest.id, dir, manifest, enabled: true }],
      manifestOf: (id) => (id === manifest.id ? { dir, manifest } : null),
      kernelVersion: "0.0.1",
      workerEntry: path.join(repo, "agent", "l1-worker.mjs"),
      // P10-1：权限模型下 worker 要读 node_modules 才能加载 jiti
      kernelModules: path.join(repo, "node_modules"),
      toolTimeoutMs: 20_000,
    });
    try {
      const loaded = await host.activate(manifest.id);
      assert.equal(loaded.ok, true, `${name} 激活失败：${loaded.detail}`);
      // 工具全名 = 插件 id 的下划线化 + 短名
      const prefix = manifest.id.replace(/[^a-z0-9]+/gi, "_");
      const firstTool = manifest.contributes.tools[0];
      const fullName = `${prefix}_${firstTool}`;
      const out = await host.execute(fullName, { text: "hello 世界" });
      assert.ok(typeof out === "string" && out.length > 0, `${name} 的工具没有返回内容`);
    } finally {
      try {
        await host.deactivate(manifest.id);
      } catch {
        /* 忽略 */
      }
      host.setBusy?.(false);
    }
  }
});

test("模板的 id 都以 lynn.template. 开头（避免和真插件撞名）", () => {
  for (const name of templateDirs()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATES, name, "plugin.json"), "utf8"));
    assert.match(manifest.id, /^lynn\.template\./, `${name} 的 id 是 ${manifest.id}，模板应当带 template 前缀`);
  }
});

test("模板目录被 .gitignore 排除（它们随源码走，但不该出现在用户的 plugins/ 里）", () => {
  const gi = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  // 模板在仓库里（plugins/_templates），而用户的运行时 plugins/ 在数据根——两者不同目录。
  // 这里只断言"没有把整个 plugins/ 忽略掉"，否则模板会进不了库。
  assert.ok(!/^\/?plugins\/?$/m.test(gi), "不要把仓库里的 plugins/ 整个忽略——模板要入库");
});

/**
 * 模板不许演示"声明了却没加载器"的字段。
 *
 * 为什么值得一条测试：模板是给 agent 复制的起点。如果模板里写了 `commands`，
 * agent 会照抄，用户装上发现斜杠命令不出现——然后怀疑整个插件系统。
 * **"写了没反应"比"不支持"更伤信任。**
 *
 * 这条测试在 `combo-l1` 里抓到过一次：它最初演示了 `commands`（字段存在但全仓 0 处引用）。
 */
test("模板不许声明没有加载器的字段（commands / mcp）", () => {
  /**
   * 已知没有加载器的字段（历史上踩过：写了不生效比不支持更伤信任）。
   *
   * 2026-11-18 更新：
   *  - `commands` 补上了加载器（`plugin-commands.ts`）
   *  - `mcp` 也补上了（`plugin-mcp.ts`）
   * 现在这份名单是空的——**这是好事，不是测试失效**：它守的是"别声明没接的东西"，
   * 全接上了自然没东西可守。将来若新增字段却没加载器，把它加回来。
   */
  const NO_LOADER = [];
  for (const name of templateDirs()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATES, name, "plugin.json"), "utf8"));
    for (const field of NO_LOADER) {
      assert.equal(
        manifest.contributes?.[field],
        undefined,
        `${name} 声明了 contributes.${field}，但它没有加载器——写了不会生效，会误导照着学的人`,
      );
      assert.equal(manifest[field], undefined, `${name} 声明了 ${field}，但它没有加载器`);
    }
  }
});

test("模板声明的每种能力都真有加载器", () => {
  /**
   * 这张表是"真能用"的白名单（26 章第 1 节）。
   * 新增能力要先有加载器再进这张表——反过来会让模板演示空功能。
   * 2026-11-18 P12-2：`skills` 也进来了（之前是"填不填都加载"，现在按声明加载）。
   * 2026-11-18 设计系统重建：`icons` 进来了 —— 主进程 checkIconsFile 消毒 +
   * plugin-host 读文件 + 渲染层 applyPluginIcons 覆盖内置字形，三段都通了。
   */
  const HAS_LOADER = new Set(["theme", "icons", "style", "langs", "tools", "slots", "view", "commands", "skills"]);
  for (const name of templateDirs()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATES, name, "plugin.json"), "utf8"));
    for (const field of Object.keys(manifest.contributes ?? {})) {
      assert.ok(
        HAS_LOADER.has(field),
        `${name} 声明了 ${field}，但它不在"有加载器"清单里。` +
          `要么先实现加载器，要么从模板移除`,
      );
    }
  }
});