import * as fs from "node:fs";
import * as path from "node:path";
import { checkManifest } from "./plugin-manifest";
import { PluginSetStore } from "./plugin-set";
import { checkUiPlugin, type UiPluginManifest, type UiSlot } from "../shared/ui-plugin";

/**
 * 从磁盘加载占卡槽的插件（计划书 §4.2.2 / §4.2.4）。
 *
 * 发现规则：`~/.lynn/plugins/<id>/plugin.json`（用户级）。
 *  - **U 档**：第三方一律 sandbox（iframe），宿主只把 `entry` 指向的 HTML 作为 iframe 文档，
 *    不执行插件 JS、不把插件塞进主 DOM；
 *  - **L0 档**：声明式插件也可能占卡槽（如 `stage.console`），本身不带代码，组件来自宿主
 *    的内置视图注册表，只把 `view` 这个名字传上去。纯主题/技能插件没声明卡槽，不进这份列表。
 *
 * 启用状态来自 `_state.json`（主进程单一真相），不由渲染层 localStorage 决定。
 */

export interface LoadedUiPlugin {
  manifest: UiPluginManifest;
  dir: string;
  html?: string;
}

const MAX_HTML_BYTES = 512 * 1024;

export function scanUiPlugins(dataRoot: string): { plugins: LoadedUiPlugin[]; errors: string[] } {
  const root = path.join(dataRoot, "plugins");
  const plugins: LoadedUiPlugin[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(root)) return { plugins, errors };

  const setStore = new PluginSetStore(dataRoot);

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, "plugin.json");
    if (!fs.existsSync(file)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      errors.push(`${entry.name}: plugin.json 不是合法 JSON`);
      continue;
    }

    const check = checkManifest(raw);
    if (!check.ok) {
      errors.push(`${entry.name}: ${check.issues.map((i) => `${i.field} ${i.message}`).join("；")}`);
      continue;
    }

    const m = raw as Record<string, unknown>;
    const tier = String(m.tier);
    // U 走 iframe；L0 声明式也可能占卡槽（内置视图）。L1/L2 归各自加载器。
    if (tier !== "U" && tier !== "L0") continue;

    const contributes = m.contributes as { slots?: UiSlot[]; view?: string } | undefined;
    const slots = (contributes?.slots ?? []) as UiSlot[];
    // 纯主题 / 技能 / 语言包的 L0 不占卡槽，不进 UI 列表（免得设置面板里冒出空白条目）
    if (tier === "L0" && !slots.length) continue;

    const official = m.source === "official";
    const manifest: UiPluginManifest = {
      id: String(m.id),
      name: String(m.name),
      version: String(m.version),
      slots,
      source: official ? "official" : "third-party",
      // U 第三方强制沙箱；L0 是声明式，组件在宿主内，恒 false
      sandbox: tier === "L0" ? false : official ? m.sandbox === true : true,
      description: typeof m.description === "string" ? m.description : undefined,
      view: typeof contributes?.view === "string" ? contributes.view : undefined,
      tier,
      enabled: setStore.enabledOf(String(m.id), tier, official),
    };

    const uiCheck = checkUiPlugin(manifest);
    if (!uiCheck.ok) {
      errors.push(`${entry.name}: ${uiCheck.issues.join("；")}`);
      continue;
    }

    // L0 无代码：不读 entry，组件在宿主注册表里
    if (tier === "L0") {
      plugins.push({ manifest, dir });
      continue;
    }

    const entryFile = typeof m.entry === "string" ? m.entry : "";
    if (!entryFile.toLowerCase().endsWith(".html")) {
      errors.push(`${entry.name}: U 插件 entry 必须指向 .html（iframe 文档）`);
      continue;
    }
    const abs = path.resolve(dir, entryFile);
    if (!abs.startsWith(path.resolve(dir))) {
      errors.push(`${entry.name}: entry 不能跳出插件目录`);
      continue;
    }
    if (!fs.existsSync(abs)) {
      errors.push(`${entry.name}: entry 不存在 ${entryFile}`);
      continue;
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_HTML_BYTES) {
      errors.push(`${entry.name}: entry 超过 ${Math.round(MAX_HTML_BYTES / 1024)}KB 上限`);
      continue;
    }

    plugins.push({ manifest, dir, html: fs.readFileSync(abs, "utf-8") });
  }

  return { plugins, errors };
}
