/**
 * 插件自举（P8-2 / 24 章）。
 *
 * 用户要求：「安装后可以通过对话随意增加修改插件」。这条要成立，
 * 缺的不是"起草能力"（工坊已有），而是**她自己的三件操作**：
 * 看不见装了什么、关不掉装错的、删不掉装错的。
 *
 * 这组测试守两件事：
 *  1. 三件工具真的存在且能操作已装插件（自举闭环）；
 *  2. **它们不越过 Q6 那条线**——不能给 L1/L2 自启用（那需要先补齐权限强制，
 *     实测隔离进程 4 项只挡住 0–1 项，见 24 章 3.1）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Kernel } = await import("../dist/main/kernel.js");
const { AGENT_TOOL_NAMES } = await import("../dist/main/kernel.js");
const { MANAGEMENT_ONLY_TOOLS } = await import("../dist/main/management-tools.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-selfhost-"));
}

function seed(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
    }),
    "utf-8",
  );
}

/** 装一个 L0 插件到 plugins/（模拟用户已装） */
function installPlugin(root, id, over = {}) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: over.name ?? id,
    version: over.version ?? "1.0.0",
    apiVersion: 1,
    tier: over.tier ?? "L0",
    engines: { kernel: ">=0.0.1" },
    ...(over.entry ? { entry: over.entry } : {}),
    /**
     * L0 必须有实际内容（theme/style/langs/slots 之一）——这是准入检查，不是我的夹具能省的。
     * 给它一个语言包：最小、合法、不影响别的东西。
     */
    contributes: over.contributes ?? { langs: ["lang.json"] },
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  // 语言包文件（L0 的实际内容）
  fs.writeFileSync(path.join(dir, "lang.json"), JSON.stringify({ lang: "zh", strings: { "demo.hello": "你好" } }, null, 2), "utf-8");
  return dir;
}

test("自举三件套已挂给风铃，且属于管理型工具（成员禁入）", () => {
  for (const name of ["list_plugins", "set_plugin_enabled", "uninstall_plugin"]) {
    assert.ok(AGENT_TOOL_NAMES.includes(name), `${name} 不在风铃工具面里，她没法自己收拾插件`);
    assert.ok(MANAGEMENT_ONLY_TOOLS.includes(name), `${name} 必须在管理型清单里——成员不得管插件`);
  }
});

test("list_plugins：没装插件时如实说没有", async () => {
  const root = tmp();
  seed(root);
  const k = new Kernel(root);
  try {
    await k.init();
    const out = String(k.runTool("list_plugins", {}));
    assert.match(out, /还没有安装任何插件/);
  } finally {
    await k.dispose();
  }
});

test("list_plugins：列出已装插件的 id / 档位 / 启用状态", async () => {
  const root = tmp();
  seed(root);
  installPlugin(root, "lynn.demo.hello", { name: "示例", tier: "L0" });
  const k = new Kernel(root);
  try {
    await k.init();
    const out = String(k.runTool("list_plugins", {}));
    assert.match(out, /lynn\.demo\.hello/, "要看得到 id");
    assert.match(out, /L0/, "要看得到档位");
    assert.match(out, /示例/, "要看得到名字");
  } finally {
    await k.dispose();
  }
});

test("set_plugin_enabled：停用已装插件，且能再启用回来", async () => {
  const root = tmp();
  seed(root);
  installPlugin(root, "lynn.demo.toggle", { tier: "L0" });
  const k = new Kernel(root);
  try {
    await k.init();
    const off = String(k.runTool("set_plugin_enabled", { id: "lynn.demo.toggle", enabled: false }));
    assert.match(off, /停用/);
    const listed = String(k.runTool("list_plugins", {}));
    assert.match(listed, /已停用/, "停用后清单里要标出来");

    const on = String(k.runTool("set_plugin_enabled", { id: "lynn.demo.toggle", enabled: true }));
    assert.match(on, /启用/);
  } finally {
    await k.dispose();
  }
});

test("set_plugin_enabled：不存在的 id 如实报错，不静默成功", async () => {
  const root = tmp();
  seed(root);
  const k = new Kernel(root);
  try {
    await k.init();
    const out = String(k.runTool("set_plugin_enabled", { id: "根本没装", enabled: false }));
    assert.match(out, /没有这个插件/);
  } finally {
    await k.dispose();
  }
});

test("uninstall_plugin：移到 plugins-trash 而不是永久删除（装错了能找回）", async () => {
  const root = tmp();
  seed(root);
  const dir = installPlugin(root, "lynn.demo.remove", { tier: "L0" });
  assert.ok(fs.existsSync(dir));
  const k = new Kernel(root);
  try {
    await k.init();
    const out = String(k.runTool("uninstall_plugin", { id: "lynn.demo.remove" }));
    assert.match(out, /已卸载/);
    assert.match(out, /plugins-trash/, "要说明去哪了（可恢复）");
    assert.equal(fs.existsSync(dir), false, "原目录应已移走");
    const trash = path.join(root, "plugins-trash");
    const moved = fs.readdirSync(trash).filter((f) => f.startsWith("lynn.demo.remove"));
    assert.equal(moved.length, 1, "必须能在回收目录里找到");
    // 文件内容还在（不是删掉重建）
    assert.ok(fs.existsSync(path.join(trash, moved[0], "plugin.json")));
  } finally {
    await k.dispose();
  }
});

test("uninstall_plugin：不存在的 id 如实报错", async () => {
  const root = tmp();
  seed(root);
  const k = new Kernel(root);
  try {
    await k.init();
    assert.match(String(k.runTool("uninstall_plugin", { id: "没有这个" })), /没有这个插件/);
  } finally {
    await k.dispose();
  }
});

/**
 * 这一条是**边界守卫**，不是功能测试。
 *
 * Q6 定稿 C：她不得给自己的产物提权。实测（24 章 3.1）隔离进程 4 项只挡住 0–1 项——
 * 凭据能读、子进程能起、HTTP 能发。在补齐权限强制之前，L1/L2 自启用必须继续被拦。
 * 谁要是哪天为了"方便"把这行删了，这条测试会立刻红。
 */
test("边界：promoteDraft 直接拒 L1 自启用（Q6 定稿 C 的最后一道闸）", async () => {
  const { promoteDraft } = await import("../dist/main/workshop.js");
  const root = tmp();
  seed(root);
  /**
   * 直接测 promoteDraft 这一层，而不是绕 ship_plugin：
   *  - ship_plugin 前面还有 review 闸，测它只能证明"没审就装不上"；
   *  - 真正要守的是"就算审过了，L1 也不许她自启用"。
   * 所以这里造一个 status=reviewed 的 L1 草稿，再调 promoteDraft(byUser=false)。
   */
  const draftId = "d-test-l1";
  const dir = path.join(root, "plugins", "_drafts", draftId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "lynn.demo.danger", name: "危险", version: "1.0.0", apiVersion: 1, tier: "L1", engines: { kernel: ">=0.0.1" }, entry: "index.ts", contributes: { tools: ["danger"] } }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "index.ts"), "export default function activate() { return { ok: true }; }\n", "utf-8");
  fs.writeFileSync(
    path.join(dir, "_meta.json"),
    JSON.stringify({ draftId, title: "危险", kind: "L1", spec: "测试", status: "reviewed", createdAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  assert.throws(
    () => promoteDraft(root, draftId, false, { pluginIds: [], skillNames: [] }),
    /必须由用户点启用|Q6/,
    "L1 自启用必须被拦——这是 Q6 定稿 C 的硬约束",
  );
  // 而用户点启用（byUser=true）应当放行到下一道检查（这里会因为 hash 不符而失败，但错误信息不同）
  let userError = "";
  try {
    promoteDraft(root, draftId, true, { pluginIds: [], skillNames: [] });
  } catch (e) {
    userError = String(e);
  }
  assert.doesNotMatch(userError, /Q6|必须由用户点启用/, "byUser=true 时不该再被 Q6 拦（应走到哈希/准入检查）");
});