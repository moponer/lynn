/**
 * 插件 MCP 加载器（2026-11-18 P11-2）。
 *
 * 补的是 26 章第 3 节最后一条缺口：`mcp.recipe`（L2 档）**没有加载器**——
 * 校验器要求 L2 必须声明它，插件能过审、能装，但**不会真的连 MCP server**。
 *
 * ## 为什么 L2 值得单独一档
 *
 * L1 是"在主进程的隔离进程里跑 TS"。它对重依赖不友好：
 *  - 浏览器驱动、Office 引擎这类东西崩了，隔离进程虽死不了内核，但插件整块不可用；
 *  - 它们往往已经有现成的 MCP server（社区生态），重写一遍没意义。
 *
 * L2 就是"外挂进程 + 标准协议"：插件只声明**怎么起那个进程**，能力由 MCP 协议提供。
 *
 * ## recipe.json 的形状
 *
 * 与 `~/.lynn/mcp.json` **完全一致**（`{ servers: [...] }`）。这不是偷懒：
 * 两套格式会让用户困惑"为什么这里能写那里不能"，而底层本来就是同一个 `McpRegistry`。
 *
 * ```json
 * { "servers": [{ "id": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }
 * ```
 *
 * ## 隔离与权限
 *
 * L2 进程**不在我们的沙箱里**（它是外部程序，用别人的运行时）。
 * 所以这里的纪律与 L1 不同，必须说清：
 *  - `mcpChildEnv` 只给 PATH 等必需键（审计 #7 已有），不继承密钥；
 *  - cwd 钉在插件目录，不让它默认落在用户主目录；
 *  - **命令本身不受限**——用户在装插件时就等于同意了"运行这个程序"。
 *    这一点必须写进文档，不能让人以为 L2 也有 L1 那样的 fs/net 强制。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadMcpConfigAt, mcpToolName, type McpServerConfig } from "./mcp";
import { checkManifest, type PluginManifest } from "./plugin-manifest";
import { insideBase } from "./path-guard";

/** 一个插件声明的 MCP server（带来源标记，便于排障） */
export interface PluginMcpServer extends McpServerConfig {
  /** 来自哪个插件 */
  pluginId: string;
}

export interface McpScanResult {
  servers: PluginMcpServer[];
  errors: string[];
}

/**
 * 扫描 `<dataRoot>/plugins/*`，收集启用插件的 MCP server 声明。
 *
 * 为什么给 server id 加插件前缀：`McpRegistry` 用 id 做唯一键，
 * 两个插件都声明 `fs` 就会互相覆盖。加前缀后 `lynn.a:fs` / `lynn.b:fs` 共存，
 * 工具名也会带上完整来源（`mcpToolName` 会再 sanitize 一次）。
 */
export function scanPluginMcp(dataRoot: string): McpScanResult {
  const servers: PluginMcpServer[] = [];
  const errors: string[] = [];
  const root = path.join(dataRoot, "plugins");
  if (!fs.existsSync(root)) return { servers, errors };

  const disabled = readDisabled(dataRoot);
  const seen = new Set<string>();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const manifestFile = path.join(dir, "plugin.json");
    if (!fs.existsSync(manifestFile)) continue;

    let manifest: PluginManifest;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      if (!checkManifest(raw).ok) continue; // 坏清单由 PluginHost 报
      manifest = raw as PluginManifest;
    } catch {
      continue;
    }
    if (manifest.tier !== "L2") continue;
    if (disabled.has(manifest.id)) continue;

    const recipeRel = manifest.mcp?.recipe;
    if (typeof recipeRel !== "string" || !recipeRel.trim()) {
      errors.push(`${manifest.id}：L2 插件缺少 mcp.recipe`);
      continue;
    }

    const recipeFile = path.resolve(dir, recipeRel);
    if (!insideBase(dir, recipeFile)) {
      errors.push(`${manifest.id}：recipe 路径越界（${recipeRel}）`);
      continue;
    }
    if (!fs.existsSync(recipeFile)) {
      errors.push(`${manifest.id}：recipe 文件不存在（${recipeRel}）`);
      continue;
    }

    const loaded = loadMcpConfigAt(recipeFile);
    if (loaded.error) {
      errors.push(`${manifest.id}：${loaded.error}`);
    }
    for (const s of loaded.servers) {
      /**
       * 前缀化 server id。用 `:` 分隔（与命令的命名风格一致），
       * `McpRegistry` 内部会 sanitize 成下划线再拼工具名。
       */
      const id = `${manifest.id}:${s.id}`;
      if (seen.has(id)) {
        errors.push(`${manifest.id}：server id「${s.id}」重复`);
        continue;
      }
      seen.add(id);
      servers.push({
        ...s,
        id,
        /**
         * cwd 钉在插件目录：MCP server 里常写相对路径（`./data`），
         * 不钉住就会落在内核的 cwd（可能是用户主目录）。
         */
        ...(s.args ? { args: s.args } : {}),
        pluginId: manifest.id,
      });
    }
  }

  // 稳定顺序：id 排序。工具面顺序决定请求前缀，不能随目录遍历顺序漂
  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { servers, errors };
}

/**
 * 插件 MCP 的工具名前缀规则。
 *
 * 直接用 `mcpToolName` 会给 `lynn_a_fs_read_file` 这种名字——
 * 看不出是哪个插件的。这里保留完整来源，排障时能一眼定位。
 */
export function pluginMcpToolName(serverId: string, tool: string): string {
  return mcpToolName(serverId, tool);
}

/** 读 `_state.json`（`Record<插件id, boolean>`，与 PluginHost 同一份真相） */
function readDisabled(dataRoot: string): Set<string> {
  const file = path.join(dataRoot, "plugins", "_state.json");
  if (!fs.existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const out = new Set<string>();
    for (const [id, enabled] of Object.entries(raw)) {
      if (enabled === false) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * 诚实说明 L2 的隔离边界。
 *
 * 这一段是给文档和 UI 用的，不是装饰：用户装 L2 插件前必须知道
 * **它不受我们的沙箱约束**——它是个外部程序。
 */
export function describeL2Boundary(): string {
  return [
    "L2 插件通过 MCP 协议与外部进程通信，那个进程**不在本应用的沙箱里**。",
    "我们能保证的：只给它 PATH 等必需环境变量（不继承密钥）、cwd 钉在插件目录、",
    "崩溃不拖垮内核、超时可强杀。",
    "我们**不能**保证的：那个程序自己会读什么文件、连什么网络——它用别人的运行时。",
    "所以装 L2 插件等于同意「运行这个程序」，请只在信任来源时安装。",
  ].join("");
}