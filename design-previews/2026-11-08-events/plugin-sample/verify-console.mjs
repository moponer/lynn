// C 阶段验收：stage.console 卡槽（可复现，无需开应用）
//   node design-previews/2026-11-08-events/plugin-sample/verify-console.mjs
//
// 验证四件事：
//   1. L0 声明式插件能占 stage.console（真读 ~/.lynn/plugins 的启用状态）
//   2. 第三方声明 stage.console 被拒（卡槽是内置注册表入口，不是提权口）
//   3. 声明卡槽却不给 view 被拒
//   4. 禁用插件 → enabled=false（渲染层据此卸载视图，回落值台）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanUiPlugins } from "../../../dist/main/ui-plugins.js";
import { checkManifest } from "../../../dist/main/plugin-manifest.js";

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- 夹具：临时 dataRoot ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-console-"));
const plug = path.join(root, "plugins");
fs.mkdirSync(plug, { recursive: true });

const manifest = (id, extra) => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: 1,
  tier: "L0",
  source: "official",
  engines: { kernel: "^1.4.0" },
  ...extra,
});

// 1) 官方 L0 占卡槽
fs.mkdirSync(path.join(plug, "a"));
fs.writeFileSync(
  path.join(plug, "a", "plugin.json"),
  JSON.stringify(manifest("lynn.view.console", { contributes: { slots: ["stage.console"], view: "console" } })),
);

// 2) 第三方占同一卡槽（应被拒）
fs.mkdirSync(path.join(plug, "b"));
fs.writeFileSync(
  path.join(plug, "b", "plugin.json"),
  JSON.stringify(manifest("lynn.evil.takeover", { source: "third-party", contributes: { slots: ["stage.console"], view: "console" } })),
);

// 3) 官方占了卡槽但没说用哪个视图（应被拒）
fs.mkdirSync(path.join(plug, "c"));
fs.writeFileSync(
  path.join(plug, "c", "plugin.json"),
  JSON.stringify(manifest("lynn.view.noview", { contributes: { slots: ["stage.console"] } })),
);

// 4) 纯主题 L0（不占卡槽，不该出现在 UI 列表里）
fs.mkdirSync(path.join(plug, "d"));
fs.writeFileSync(path.join(plug, "d", "plugin.json"), JSON.stringify(manifest("lynn.theme.x", { contributes: { theme: "theme.json" } })));
fs.writeFileSync(path.join(plug, "d", "theme.json"), JSON.stringify({ dark: { "--desk": "#000000" } }));

const first = scanUiPlugins(root);
const ids = first.plugins.map((p) => p.manifest.id);
ok("官方 L0 能占 stage.console", ids.includes("lynn.view.console"));
ok("纯主题 L0 不进 UI 列表", !ids.includes("lynn.theme.x"), `列表：${ids.join("、") || "（空）"}`);
ok(
  "第三方声明 stage.console 被拒",
  first.errors.some((e) => e.startsWith("b:") && e.includes("stage.console")),
  first.errors.find((e) => e.startsWith("b:")) ?? "没有报错，危险",
);
ok(
  "占卡槽不给 view 被拒",
  first.errors.some((e) => e.startsWith("c:") && e.includes("view")),
  first.errors.find((e) => e.startsWith("c:")) ?? "没有报错",
);

const view = first.plugins.find((p) => p.manifest.id === "lynn.view.console")?.manifest;
ok("view 透传为 console", view?.view === "console", `view=${view?.view}`);
ok("默认启用（官方 L0）", view?.enabled === true, `enabled=${view?.enabled}`);
ok("不携带 iframe 文档", !first.plugins.find((p) => p.manifest.id === "lynn.view.console")?.html);

// ---------- 禁用 → enabled=false（渲染层据此卸载视图） ----------
fs.writeFileSync(path.join(plug, "_state.json"), JSON.stringify({ "lynn.view.console": false }), "utf-8");
const off = scanUiPlugins(root).plugins.find((p) => p.manifest.id === "lynn.view.console");
ok("停用后 enabled=false", off?.manifest.enabled === false, `enabled=${off?.manifest.enabled}`);

// 安全模式：只有官方能过（这里本来就官方，仍启用；换成第三方同理被压成 false）
fs.writeFileSync(path.join(plug, "_safe-mode.json"), JSON.stringify({ at: new Date().toISOString(), reason: "verify" }), "utf-8");
const safe = scanUiPlugins(root).plugins.find((p) => p.manifest.id === "lynn.view.console");
ok("安全模式下官方仍按声明加载", safe?.manifest.enabled === true, `enabled=${safe?.manifest.enabled}`);

// ---------- manifest 单点校验（不依赖磁盘） ----------
ok(
  "checkManifest：占 stage.console 无 view → 不通过",
  !checkManifest(manifest("lynn.view.x", { contributes: { slots: ["stage.console"] } })).ok,
);
ok(
  "checkManifest：官方 + view 合法 → 通过",
  checkManifest(manifest("lynn.view.x", { contributes: { slots: ["stage.console"], view: "console" } })).ok,
);
ok(
  "checkManifest：view id 非法（大写/斜杠）→ 不通过",
  !checkManifest(manifest("lynn.view.x", { contributes: { slots: ["stage.console"], view: "Console/../x" } })).ok,
);

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
