import * as fs from "node:fs";
import * as path from "node:path";
import { checkManifest } from "./plugin-manifest";
import { checkUiPlugin, type UiPluginManifest, type UiSlot } from "../shared/ui-plugin";

/**
 * 从磁盘加载 U 档插件（计划书 §4.2.2 / §4.2.4）。
 *
 * 发现规则：`~/.lynn/plugins/<id>/plugin.json`（用户级）。
 * 只认 tier=U；第三方一律 sandbox（iframe），宿主只把 `entry` 指向的 HTML 作为 iframe 文档，
 * 不执行插件 JS、不把插件塞进主 DOM。加载前先过 manifest 校验 + 卡槽白名单。
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
    if (m.tier !== "U") continue; // 只处理 U 档；L0/L1/L2 归各自加载器

    const manifest: UiPluginManifest = {
      id: String(m.id),
      name: String(m.name),
      version: String(m.version),
      slots: ((m.contributes as { slots?: UiSlot[] } | undefined)?.slots ?? []) as UiSlot[],
      source: m.source === "official" ? "official" : "third-party",
      sandbox: m.source === "official" ? m.sandbox === true : true,
      description: typeof m.description === "string" ? m.description : undefined,
    };

    const uiCheck = checkUiPlugin(manifest);
    if (!uiCheck.ok) {
      errors.push(`${entry.name}: ${uiCheck.issues.join("；")}`);
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
