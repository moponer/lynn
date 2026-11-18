import * as fs from "node:fs";
import * as path from "node:path";
import { checkManifest, type PluginManifest } from "./plugin-manifest";
import { probeMcpServer } from "./plugin-probe";
import { PluginSetStore } from "./plugin-set";
import { checkThemeTokens } from "../shared/skin";
import { checkLangPack, type LangPack } from "../shared/i18n";
import type { L1Host } from "./plugin-l1";

/**
 * 三档加载器：**L0 声明式**（主题/皮肤，真热插拔）+ **L1 进程内扩展**（jiti 直跑 TS，
 * 运行时见 plugin-l1.ts）+ L2 MCP（隔离试装已通）。发现规则：`~/.lynn/plugins/<id>/plugin.json`。
 * 第三方 L1 与内核同权限（§4.2.1 高信任档）——**默认关闭**，启用时逐项确认。
 */

export interface ThemeFile {
  name?: string;
  /** 暗色 Token 覆盖（只许白名单键） */
  dark?: Record<string, string>;
  light?: Record<string, string>;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  tier: string;
  enabled: boolean;
  /** L0 主题插件才有 */
  theme?: ThemeFile;
  /** L0 形态层：插件目录里的 CSS 内容（已过 checkPluginCss），无则不下发 */
  style?: string;
  /** L0 图标覆盖：图标名 → SVG 内联路径串（已过 checkIconsFile） */
  icons?: Record<string, string>;
  /** M3-08：L0 语言包插件才有（可能同时带 zh/en 多个包） */
  langs?: LangPack[];
  /** 占用的卡槽（设置页据此标注「控制台视图」等） */
  slots?: string[];
  /** 占内置视图卡槽时指名的视图 id（组件在宿主注册表里） */
  view?: string;
  /** false = 该档加载器还没接（L1/L2） */
  loadable: boolean;
  description?: string;
}

/** 形态层上限：整屏 CSS 远小于此，超了说明放的不是样式 */
const STYLE_MAX = 256 * 1024;

/**
 * 形态层 CSS 的准入检查（与 theme.json 同级纪律：只下发给渲染层，不经脚本求值）。
 *  - 禁 `@import`：否则插件能远程拉未申报样式
 *  - 禁 `javascript:` / `expression()`：老 IE 攻击面，现代浏览器也已无正当用途
 *  - 禁 `url(` 里的绝对协议（http/https）以外的外链不拦，但 data/file 拦掉
 */
export function checkPluginCss(raw: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (raw.length > STYLE_MAX) issues.push(`形态层超过 ${STYLE_MAX / 1024}KB（实际 ${Math.round(raw.length / 1024)}KB）`);
  if (/@import\b/i.test(raw)) issues.push("形态层不得使用 @import（会绕过申报加载外部样式）");
  if (/javascript\s*:/i.test(raw)) issues.push("形态层不得包含 javascript: URL");
  if (/expression\s*\(/i.test(raw)) issues.push("形态层不得使用 expression()");
  if (/url\(\s*['"]?\s*(file|data):/i.test(raw)) issues.push("形态层不得引用 file:/data: 资源");
  return { ok: issues.length === 0, issues };
}

/**
 * 主题文件（contributes.theme → theme.json）的准入检查。
 *
 * 2026-11-18：改用 checkThemeTokens —— 主题可以覆盖颜色**和几何**
 * （间距/圆角/字号/行高/层级），但仍然不能新增或改名。
 *
 * 为什么放开几何：设计系统重建后，tokens.css 里有 60+ 个令牌。
 * 如果主题插件只能改颜色，"紧凑主题""大字主题"这类真实需求就做不出来，
 * 而它们恰恰是主题相对于皮肤的价值所在（皮肤只改色）。
 */
export function checkThemeFile(raw: unknown): { ok: boolean; issues: string[]; theme?: ThemeFile } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, issues: ["theme.json 必须是对象"] };
  const t = raw as Record<string, unknown>;
  const theme: ThemeFile = {};
  if (typeof t.name === "string") theme.name = t.name;

  for (const mode of ["dark", "light"] as const) {
    const block = t[mode];
    if (block === undefined) continue;
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      issues.push(`${mode} 必须是对象`);
      continue;
    }
    const { issues: modeIssues, values } = checkThemeTokens(block as Record<string, unknown>, mode);
    issues.push(...modeIssues);
    theme[mode] = values;
  }

  if (!theme.dark && !theme.light) issues.push("至少要有 dark 或 light 一组 Token");
  return { ok: issues.length === 0, issues, theme: issues.length ? undefined : theme };
}

/** 单个图标的体积上限：一条 24 网格的路径串通常 < 1KB */
const ICON_MAX_LEN = 4096;
const ICON_MAX_COUNT = 128;
/** 图标名：与内置 PATHS 同一命名（小写字母/数字/连字符） */
const ICON_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * 图标覆盖文件的准入检查（contributes.icons → icons.json）。
 *
 * 只接受 **SVG 内联路径**（<path>/<circle>/<rect>/<line>/<polyline>/<polygon>/<g>），
 * 一律拒绝：script / 事件属性 / 外链 / foreignObject / style / image。
 * 为什么这么严：这段字符串最终会进 dangerouslySetInnerHTML ——
 * 主机若放行，等于给插件一个在宿主 DOM 里执行脚本的通道。
 */
export function checkIconsFile(raw: unknown): { ok: boolean; issues: string[]; icons?: Record<string, string> } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["icons.json 必须是对象（图标名 → SVG 路径串）"] };
  }
  const src = raw as Record<string, unknown>;
  // 允许一个可选的元数据键，避免主题作者写说明时被拒
  const keys = Object.keys(src).filter((k) => k !== "$comment");
  if (keys.length === 0) issues.push("icons.json 至少要有一个图标");
  if (keys.length > ICON_MAX_COUNT) issues.push(`图标数量超过 ${ICON_MAX_COUNT} 上限`);

  const icons: Record<string, string> = {};
  for (const name of keys) {
    const val = src[name];
    if (!ICON_NAME_RE.test(name)) {
      issues.push(`图标名 "${name}" 不合法（小写字母开头，只含小写字母/数字/连字符，≤32 字符）`);
      continue;
    }
    if (typeof val !== "string") {
      issues.push(`图标 "${name}" 的值必须是字符串`);
      continue;
    }
    const markup = val.trim();
    if (markup.length > ICON_MAX_LEN) {
      issues.push(`图标 "${name}" 超过 ${ICON_MAX_LEN} 字符`);
      continue;
    }
    if (/<script|<foreignObject|<iframe|<style|<image|<use/i.test(markup)) {
      issues.push(`图标 "${name}" 含禁止的元素（script/foreignObject/iframe/style/image/use）`);
      continue;
    }
    if (/\son[a-z]+\s*=/i.test(markup) || /javascript\s*:/i.test(markup)) {
      issues.push(`图标 "${name}" 含事件属性或 javascript: URL`);
      continue;
    }
    if (/href|xlink/i.test(markup)) {
      issues.push(`图标 "${name}" 不得引用外部资源（href/xlink）`);
      continue;
    }
    if (!/^<[a-z]/i.test(markup)) {
      issues.push(`图标 "${name}" 必须是一段 SVG 标记（以 < 开头）`);
      continue;
    }
    icons[name] = markup;
  }
  return { ok: issues.length === 0, issues, icons: issues.length ? undefined : icons };
}

export class PluginHost {
  /** L1 运行时（试装用；内核构造后 attach） */
  private l1: L1Host | null = null;

  attachL1(l1: L1Host): void {
    this.l1 = l1;
  }

  constructor(readonly dataRoot: string) {}

  private get pluginsDir(): string {
    return path.join(this.dataRoot, "plugins");
  }

  private get stateFile(): string {
    return path.join(this.pluginsDir, "_state.json");
  }

  private readState(): Record<string, boolean> {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  private writeState(s: Record<string, boolean>): void {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2), "utf-8");
  }

  /** 扫描 + 校验：返回能列的插件与逐条错误（坏插件不影响别的） */
  scan(): { plugins: PluginView[]; errors: string[] } {
    const plugins: PluginView[] = [];
    const errors: string[] = [];
    if (!fs.existsSync(this.pluginsDir)) return { plugins, errors };

    const state = this.readState();
    // 安全模式：只跑官方核心，其余一律按停用处理（§4.11.4）
    const safeMode = new PluginSetStore(this.dataRoot).isSafeMode();
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const dir = path.join(this.pluginsDir, entry.name);
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
      const m = raw as PluginManifest;
      const official = (raw as { source?: string }).source === "official";
      const view: PluginView = {
        id: m.id,
        name: m.name,
        version: m.version,
        tier: m.tier,
        // 第三方 L1 与内核同权限 → 默认关闭，用户显式启用才载（§4.2.1 信任模型）
        enabled: safeMode ? official : (state[m.id] ?? !(m.tier === "L1" && !official)),
        loadable: m.tier === "L0" || m.tier === "L1",
        description: typeof (raw as { description?: string }).description === "string" ? (raw as { description?: string }).description : undefined,
        slots: m.contributes?.slots,
        view: m.contributes?.view,
      };

      if (m.tier === "L1") {
        const entryRel = m.entry;
        if (entryRel) {
          const entryPath = path.resolve(dir, entryRel);
          if (!entryPath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(entryPath)) {
            errors.push(`${entry.name}: entry 文件不存在或跳出插件目录`);
            continue;
          }
        }
      }

      if (m.tier === "L0") {
        const themeRel = m.contributes?.theme;
        const langRels = m.contributes?.langs ?? [];
        const slotList = m.contributes?.slots ?? [];
        // L0 是声明式档：主题 / 形态层 / 语言包 / 内置视图卡槽，任一种都算有产物。
        // 占内置视图卡槽的插件零代码（组件在宿主注册表里），所以 slots 单独也算数。
        if (!themeRel && !langRels.length && !slotList.length && !m.contributes?.style && !m.contributes?.icons) {
          errors.push(`${entry.name}: L0 插件至少要有 contributes.theme / icons / style / langs / slots 之一`);
          continue;
        }
        if (themeRel) {
          const themePath = path.resolve(dir, themeRel);
          if (!themePath.startsWith(path.resolve(dir)) || !fs.existsSync(themePath)) {
            errors.push(`${entry.name}: theme 文件不存在或跳出插件目录`);
            continue;
          }
          try {
            const themeCheck = checkThemeFile(JSON.parse(fs.readFileSync(themePath, "utf-8")));
            if (!themeCheck.ok) {
              errors.push(`${entry.name}: ${themeCheck.issues.join("；")}`);
              continue;
            }
            view.theme = themeCheck.theme;
          } catch {
            errors.push(`${entry.name}: theme.json 不是合法 JSON`);
            continue;
          }
        }
        // 形态层：与 theme.json 同一沙箱纪律，坏 CSS 整插件跳过（不降级跑半个主题）
        const styleRel = m.contributes?.style;
        if (styleRel) {
          const stylePath = path.resolve(dir, styleRel);
          if (!stylePath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(stylePath)) {
            errors.push(`${entry.name}: style 文件不存在或跳出插件目录`);
            continue;
          }
          const css = fs.readFileSync(stylePath, "utf-8");
          const cssCheck = checkPluginCss(css);
          if (!cssCheck.ok) {
            errors.push(`${entry.name}: ${cssCheck.issues.join("；")}`);
            continue;
          }
          view.style = css;
        }
        // 图标覆盖：与 theme.json 同级纪律（路径不出插件目录 + 消毒），坏文件整插件跳过
        const iconsRel = m.contributes?.icons;
        if (iconsRel) {
          const iconsPath = path.resolve(dir, iconsRel);
          if (!iconsPath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(iconsPath)) {
            errors.push(`${entry.name}: icons 文件不存在或跳出插件目录`);
            continue;
          }
          try {
            const iconsCheck = checkIconsFile(JSON.parse(fs.readFileSync(iconsPath, "utf-8")));
            if (!iconsCheck.ok) {
              errors.push(`${entry.name}: ${iconsCheck.issues.join("；")}`);
              continue;
            }
            view.icons = iconsCheck.icons;
          } catch {
            errors.push(`${entry.name}: icons.json 不是合法 JSON`);
            continue;
          }
        }
        // M3-08：语言包——同一沙箱纪律（路径不出插件目录 + 结构校验），坏包跳过不拖垮其它
        const packs: LangPack[] = [];
        let langBad = false;
        for (const rel of langRels) {
          const p = path.resolve(dir, rel);
          if (!p.startsWith(path.resolve(dir)) || !fs.existsSync(p)) {
            errors.push(`${entry.name}: 语言包不存在或跳出插件目录：${rel}`);
            langBad = true;
            continue;
          }
          try {
            const check = checkLangPack(JSON.parse(fs.readFileSync(p, "utf-8")));
            if (!check.ok || !check.pack) {
              errors.push(`${entry.name}: 语言包 ${rel} — ${check.issues.join("；")}`);
              langBad = true;
              continue;
            }
            packs.push(check.pack);
          } catch {
            errors.push(`${entry.name}: 语言包 ${rel} 不是合法 JSON`);
            langBad = true;
          }
        }
        if (langBad) continue;
        if (packs.length) view.langs = packs;
      }

      plugins.push(view);
    }
    return { plugins, errors };
  }

  setEnabled(id: string, enabled: boolean): void {
    const state = this.readState();
    state[id] = enabled;
    this.writeState(state);
  }

  /** 解析插件目录与 manifest（L1 运行时与面板用） */
  manifestOf(id: string): { dir: string; manifest: PluginManifest } | null {
    const dir = this.dirOf(id);
    if (!dir) return null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8")) as PluginManifest;
      return { dir, manifest: m };
    } catch {
      return null;
    }
  }

  /** L1 加载器的启动清单：enabled 判定与 scan 一致（第三方默认关、安全模式全关） */
  listL1Entries(): { id: string; dir: string; manifest: PluginManifest; enabled: boolean }[] {
    const out: { id: string; dir: string; manifest: PluginManifest; enabled: boolean }[] = [];
    if (!fs.existsSync(this.pluginsDir)) return out;
    const state = this.readState();
    const safeMode = new PluginSetStore(this.dataRoot).isSafeMode();
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const file = path.join(this.pluginsDir, entry.name, "plugin.json");
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as PluginManifest;
        if (raw.tier !== "L1" || !checkManifest(raw).ok) continue;
        const official = (raw as { source?: string }).source === "official";
        out.push({
          id: raw.id,
          dir: path.join(this.pluginsDir, entry.name),
          manifest: raw,
          enabled: safeMode ? official : (state[raw.id] ?? !official),
        });
      } catch {
        // 坏 manifest 不进启动清单（scan 会报错）
      }
    }
    return out;
  }

  /**
   * 找到插件目录（试装 / 卸载时用）。
   *
   * 2026-11-17 P8-2：从 private 改为公开——`uninstall_plugin` 需要它把目录移进回收站。
   * 公开而不是在 kernel 里重写一遍：这里有几条容易漏的纪律（跳过 `_` 前缀、
   * 坏 manifest 不算匹配），复制一份迟早会漂移。
   */
  dirOf(id: string): string | null {
    if (!fs.existsSync(this.pluginsDir)) return null;
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      /**
       * 跳过 `_` 前缀（`_state.json`、`_drafts`、`_updating-*` 这类内部目录）
       * 与 `.` 前缀（`.versions` 历史版本归档）。
       *
       * 2026-11-18 P12-1 修：原来只跳 `_`。加入版本归档后，`.versions/<id>/<ts>/`
       * 里也有 `plugin.json`，`dirOf` 会把它当成候选——卸载时可能删到归档而不是生效中的那份。
       */
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const file = path.join(this.pluginsDir, entry.name, "plugin.json");
      if (!fs.existsSync(file)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(file, "utf-8")) as { id?: string };
        if (m.id === id) return path.join(this.pluginsDir, entry.name);
      } catch {
        // 坏 manifest 跳过
      }
    }
    return null;
  }

  /**
   * 隔离试装（§4.11.3）：先在一次性进程里把它跑起来、调用一次、再杀干净。
   * - L0：纯数据，视为通过；
   * - L2：按 recipe 起 MCP server 做真实 initialize 握手；
   * - L1：需要在进程内用 jiti 加载 TS，当前未接，如实返回不可试装。
   */
  async probe(id: string): Promise<{ ok: boolean; detail: string }> {
    const dir = this.dirOf(id);
    if (!dir) return { ok: false, detail: "插件不存在" };
    const m = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8")) as PluginManifest;

    if (m.tier === "L0") return { ok: true, detail: "L0 纯声明，无需试装" };
    if (m.tier === "U") return { ok: true, detail: "U 档由渲染层 iframe 沙箱加载" };
    if (m.tier === "L1") {
      if (!this.l1) return { ok: false, detail: "L1 运行时未就绪（内核尚未装配）" };
      if (this.l1.activeIds().includes(id)) return { ok: true, detail: "已在运行中" };
      try {
        // 试装 = 真激活一次拿到工具面，随即反注册——进程内不留残留
        const r = await this.l1.activate(id);
        if (r.ok) this.l1.deactivate(id);
        return r;
      } catch (err) {
        return { ok: false, detail: `试装失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const recipeRel = m.mcp?.recipe;
    if (!recipeRel) return { ok: false, detail: "L2 缺少 mcp.recipe" };
    const recipePath = path.resolve(dir, recipeRel);
    if (!recipePath.startsWith(path.resolve(dir)) || !fs.existsSync(recipePath)) {
      return { ok: false, detail: "recipe 文件不存在或跳出插件目录" };
    }
    let recipe: { command?: string; args?: string[]; env?: Record<string, string> };
    try {
      recipe = JSON.parse(fs.readFileSync(recipePath, "utf-8"));
    } catch {
      return { ok: false, detail: "recipe.json 不是合法 JSON" };
    }
    if (!recipe.command) return { ok: false, detail: "recipe 缺少 command" };

    const r = await probeMcpServer({
      command: recipe.command,
      args: recipe.args ?? [],
      env: recipe.env,
      cwd: dir,
      timeoutMs: 8000,
      listTools: true,
    });
    if (!r.ok) return { ok: false, detail: `试装失败：${r.error ?? `exit ${r.code}`}` };
    return {
      ok: true,
      detail: `握手成功（${r.ms}ms）· ${r.serverInfo?.name ?? "server"} · ${r.tools?.length ?? 0} 个工具`,
    };
  }
}
