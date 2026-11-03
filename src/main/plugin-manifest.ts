import type { RpcMethod } from "../shared/contract";

/**
 * 插件 manifest v1（§4.2.2）—— 类型 + 校验器。
 * 校验先行：任何插件进不了准入流水线，先过不了这一关。
 * 纯函数、无 Electron 依赖，可被单测直接覆盖。
 */

export const MANIFEST_API_VERSION = 1;

export const PLUGIN_TIERS = ["L0", "L1", "L2", "U"] as const;
export type PluginTier = (typeof PLUGIN_TIERS)[number];

/** U 档允许注册的卡槽白名单（§4.2.4） */
export const UI_SLOTS = [
  "theme.tokens",
  "stage.view",
  "card.renderer",
  "avatar.driver",
  "sidebar.item",
  "settings.section",
  "status.bar",
  "composer.action",
] as const;
export type UiSlot = (typeof UI_SLOTS)[number];

/** L1 插件权限声明（安装时必须逐项展示给用户，§4.2.2） */
export interface PluginPermissions {
  /** 允许读写的路径 glob；`$HOME` 前缀会展开到用户目录 */
  fs?: string[];
  /** 允许出站的域名 */
  net?: string[];
  /** 是否允许启动子进程（第三方默认必须 false） */
  proc?: boolean;
  /** 需要的凭据名（经内核凭据代理按需下发，插件永不直读） */
  secrets?: string[];
}

export interface PluginManifest {
  /** 反向域名，全局唯一：lynn.<作者>.<插件名> */
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  tier: PluginTier;
  /** 版本闸门：不满足则禁用并提示（§4.2.5） */
  engines: { kernel: string };
  /** L1 必填（jiti 直跑）；L0/U 可为组件路径 */
  entry?: string;
  contributes?: {
    theme?: string;
    skills?: string[];
    commands?: { name: string; description: string }[];
    tools?: string[];
    slots?: UiSlot[];
    /** M3-08：语言包文件（相对路径，JSON 结构见 shared/i18n.ts）——L0 声明式，无代码 */
    langs?: string[];
  };
  permissions?: PluginPermissions;
  mcp?: { recipe: string };
  /** 自研插件追溯（§4.11.6） */
  source?: "official" | "marketplace" | "local" | "self-authored";
  generatedBy?: string;
}

export interface ManifestIssue {
  field: string;
  message: string;
}

export interface ManifestCheck {
  ok: boolean;
  issues: ManifestIssue[];
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TOOLNAME_RE = /^[a-z][a-z0-9_]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验 manifest。返回全部问题（不抛异常），调用方决定如何处置。
 * 硬规则全部来自计划书：
 *  - id 反向域名格式、version 语义化、apiVersion === MANIFEST_API_VERSION
 *  - engines.kernel 必填（版本闸门）
 *  - L1 必须有 entry 与 permissions（进程内 = 高信任，必须显式声明权限）
 *  - U 的 slots 必须在卡槽白名单内
 *  - 命名空间：tools 只声明短名，运行时统一为 lynn.<plugin>.<tool>（§4.2.2 约定）
 *  - L2 必须有 mcp.recipe
 *  - 自研插件（source=self-authored）必须带 generatedBy（§4.11.6 可追溯）
 */
export function checkManifest(raw: unknown): ManifestCheck {
  const issues: ManifestIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ field: "(root)", message: "manifest 必须是 JSON 对象" }] };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    fail("id", "必须是反向域名格式（如 lynn.theme.lingqing，2–4 段小写）");
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    fail("name", "name 必填");
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    fail("version", "必须是语义化版本（如 1.0.0）");
  }
  if (m.apiVersion !== MANIFEST_API_VERSION) {
    fail("apiVersion", `必须为 ${MANIFEST_API_VERSION}（本内核仅认 apiVersion=1）`);
  }
  if (typeof m.tier !== "string" || !(PLUGIN_TIERS as readonly string[]).includes(m.tier)) {
    fail("tier", `必须是 ${PLUGIN_TIERS.join(" | ")} 之一`);
  }
  const engines = m.engines;
  if (!isPlainObject(engines) || typeof engines.kernel !== "string" || !engines.kernel.trim()) {
    fail("engines.kernel", "必填（版本闸门：不满足则禁用并提示）");
  }

  const tier = m.tier as PluginTier | undefined;

  if (tier === "L1") {
    if (typeof m.entry !== "string" || !m.entry.endsWith(".ts")) {
      fail("entry", "L1 必须指向 .ts 入口（jiti 直跑，无需编译）");
    }
    const perms = m.permissions;
    if (!isPlainObject(perms)) {
      fail("permissions", "L1 必须显式声明权限（fs/net/proc/secrets 至少出现一层）");
    } else {
      const declared =
        Array.isArray(perms.fs) ||
        Array.isArray(perms.net) ||
        typeof perms.proc === "boolean" ||
        Array.isArray(perms.secrets);
      if (!declared) fail("permissions", "至少声明 fs/net/proc/secrets 之一");
      if (perms.proc === true) {
        // 进程内扩展 + 子进程 = 任意执行；必须走 L2
        fail("permissions.proc", "L1 不得启动子进程（需要子进程请改用 L2 MCP）");
      }
    }
  }

  if (tier === "L2" && !(isPlainObject(m.mcp) && typeof m.mcp.recipe === "string")) {
    fail("mcp.recipe", "L2 必须指向 recipe.json（能力装配配方）");
  }

  if (isPlainObject(m.permissions) && Array.isArray(m.permissions.fs)) {
    for (const g of m.permissions.fs) {
      if (typeof g !== "string" || !g.trim()) fail("permissions.fs", "fs 白名单项必须是非空字符串 glob");
    }
  }

  const contributes = m.contributes;
  if (contributes !== undefined && !isPlainObject(contributes)) {
    fail("contributes", "必须是对象");
  } else if (isPlainObject(contributes)) {
    if (Array.isArray(contributes.tools)) {
      for (const t of contributes.tools) {
        if (typeof t !== "string" || !TOOLNAME_RE.test(t)) {
          fail("contributes.tools", `工具短名 "${String(t)}" 不合法（运行时统一加前缀 lynn.<插件>.）`);
        }
      }
    }
    if (Array.isArray(contributes.slots)) {
      for (const s of contributes.slots) {
        if (!(UI_SLOTS as readonly string[]).includes(s)) {
          fail("contributes.slots", `"${String(s)}" 不是已声明的卡槽（U 插件只能注册到白名单卡槽）`);
        }
      }
    }
    if (contributes.theme !== undefined && tier === "L0" && typeof contributes.theme !== "string") {
      fail("contributes.theme", "L0 主题必须指向 theme.json");
    }
    if (contributes.langs !== undefined) {
      if (!Array.isArray(contributes.langs)) {
        fail("contributes.langs", "必须是相对路径数组");
      } else {
        for (const p of contributes.langs) {
          if (typeof p !== "string" || !p.trim()) fail("contributes.langs", "语言包路径必须是非空字符串");
          else if (!p.endsWith(".json")) fail("contributes.langs", `语言包必须是 .json 文件：${String(p)}`);
        }
      }
    }
  }

  if (m.source === "self-authored" && typeof m.generatedBy !== "string") {
    fail("generatedBy", "自研插件必须标注 generatedBy=<task-id>（可追溯到哪次任务生成）");
  }

  return { ok: issues.length === 0, issues };
}

/** 便捷：解析 + 校验，失败抛错（主进程加载器用） */
export function loadManifestOrThrow(raw: unknown): PluginManifest {
  const check = checkManifest(raw);
  if (!check.ok) {
    const detail = check.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    throw new Error(`插件 manifest 校验失败 — ${detail}`);
  }
  return raw as unknown as PluginManifest;
}

/** 版本闸门：engines.kernel 语义化区间匹配（^1.2.0 / 1.4.x / 精确版本）。 */
export function satisfiesKernelRange(kernelVersion: string, range: string): boolean {
  const parse = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const [kMajor, kMinor] = parse(kernelVersion);
  const caret = range.startsWith("^");
  const tilde = range.startsWith("~");
  const spec = range.replace(/^[~^]/, "");
  const [rMajor, rMinor] = parse(spec);
  if (caret) {
    return kMajor === rMajor && (kMinor > rMinor || (kMinor === rMinor && true));
  }
  if (tilde) {
    return kMajor === rMajor && kMinor === rMinor;
  }
  if (spec.endsWith(".x")) {
    const [a, b] = parse(spec.replace(".x", ".0"));
    return kMajor === a && kMinor === b;
  }
  const [vMajor, vMinor, vPatch] = parse(kernelVersion);
  const [, , rP = 0] = parse(spec);
  return vMajor === rMajor && vMinor === rMinor && vPatch >= rP;
}

/** 防呆：避免未使用的导入告警（RpcMethod 保留给后续工具面扩展） */
export type KernelRpcMethod = RpcMethod;
