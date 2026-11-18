/**
 * 成员编译闸（G2，2026-11-17 P3-1b / 07 章 §4）。
 *
 * 时机：`dispatchMember` 之前。检查三件事，任何一项不成立就标 `promptFallback`：
 *  1. **role×domain 有没有模板**——注册表里这个角色声明了模板文件、且文件真的在；
 *  2. **限额合规**——轮次/预算/时限在允许区间内（出界就夹到区间，并记原因）；
 *  3. **工具面对得上**——本次分到的执行工具必须都是成员可用工具（防御纵深，另一处在 create_member）。
 *
 * 为什么失败不拒单：把单拒掉是最差的选择——成员明明可以干，只是拿不到该岗位的专门纪律。
 * 所以走 fallback：**照派，但标记出来**（界面标注 + 审计），让风铃知道"这个成员这次是通用模板"。
 * 悄悄 fallback 才是最糟的：她以为成员带着岗位纪律在干活。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { roleSpec, isKnownRoleId, type RoleDomain } from "./role-registry";

/** 成员可用的执行工具（与 member-runner 的 MEMBER_EXEC_TOOLS 同源；这里只做校验） */
const KNOWN_EXEC_TOOLS = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "glob",
  "grep",
  "repo_map",
  "find_symbol",
  "read_symbol",
  "find_references",
  "run_command",
  "office_read_table",
  "office_write_table",
  "office_write_docx",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_extract",
  "browser_close",
  "kb_add",
  "app_api",
  "ssh_run",
]);

/** 回报与发言通道：不占白名单，但也不算"未知工具" */
const CHANNEL_TOOLS = new Set(["submit_report", "post_message"]);

/** 限额允许区间（07 章 §4「限额合规」；夹层而不是拒单，理由见文件头） */
export const LIMIT_BOUNDS = {
  maxTurns: { min: 8, max: 40 },
  budgetTokens: { min: 50_000, max: 2_000_000 },
  wallClockMin: { min: 10, max: 240 },
};

export type TemplateSource = "vendor" | "adapter" | "profile" | "none";

export interface CompileGate {
  /** 模板可用、限额合规、工具合法 → true */
  ok: boolean;
  /** 需要界面标注：这次没拿到该岗位的专门纪律 */
  promptFallback: boolean;
  roleId: string;
  domain: RoleDomain;
  templateSource: TemplateSource;
  /** 模板文件（相对 prompts/）；自研角色为 null */
  templatePath: string | null;
  /** 给日志/界面看的原因，第一条最关键 */
  reasons: string[];
  /** 夹层后的限额（调用方应当用这份，而不是原始值） */
  limits: { maxTurns: number; budgetTokens: number; wallClockMin: number };
}

export interface CompileGateInput {
  roleId?: string | null;
  domain?: string | null;
  /** 档案正文：自研角色的"模板"就是它 */
  body?: string | null;
  tools?: readonly string[];
  limits?: { maxTurns?: number; budgetTokens?: number; wallClockMin?: number };
  /** 模板根目录（测试注入用）；默认仓库根的 prompts/ */
  promptsDir?: string;
}

function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * 判定这个成员这次能不能拿到岗位专门纪律。
 * 纯函数（只读 prompts 目录判断文件在不在），不写任何东西。
 */
export function gateMemberCompile(input: CompileGateInput, defaultPromptsDir: string): CompileGate {
  const roleId = String(input.roleId ?? "");
  const spec = isKnownRoleId(roleId) ? roleSpec(roleId) : undefined;
  const domain: RoleDomain = (spec?.domains.includes(String(input.domain ?? "") as RoleDomain)
    ? (input.domain as RoleDomain)
    : (spec?.domains[0] ?? "general")) as RoleDomain;

  const reasons: string[] = [];
  let templatePath: string | null = null;
  let templateSource: TemplateSource = "none";

  if (!spec) {
    reasons.push(`角色不在注册表（${roleId || "未填"}）→ 没有岗位模板`);
  } else if (spec.template) {
    const dir = input.promptsDir ?? defaultPromptsDir;
    const full = path.join(dir, spec.template);
    if (fs.existsSync(full)) {
      templatePath = spec.template;
      templateSource = spec.template.startsWith("adapters/") ? "adapter" : "vendor";
    } else {
      reasons.push(`注册表说这个角色有模板 ${spec.template}，但文件不在 → 模板缺失`);
    }
  } else if (String(input.body ?? "").trim().length >= 20) {
    // 自研角色（writer / analyst / presenter）：岗位方法在档案正文里，这不是缺陷
    templateSource = "profile";
  } else {
    reasons.push(`这个角色没有上游模板，档案正文也空着 → 只有通用纪律`);
  }

  const bounds = LIMIT_BOUNDS;
  const rawLimits = input.limits ?? {};
  const limits = {
    maxTurns: clamp(rawLimits.maxTurns, bounds.maxTurns.min, bounds.maxTurns.max, 15),
    budgetTokens: clamp(rawLimits.budgetTokens, bounds.budgetTokens.min, bounds.budgetTokens.max, 300_000),
    wallClockMin: clamp(rawLimits.wallClockMin, bounds.wallClockMin.min, bounds.wallClockMin.max, 30),
  };
  if (Number(rawLimits.maxTurns) !== limits.maxTurns) {
    reasons.push(`轮次 ${rawLimits.maxTurns ?? "未设"} 不在 ${bounds.maxTurns.min}–${bounds.maxTurns.max}，已夹到 ${limits.maxTurns}`);
  }
  if (Number(rawLimits.budgetTokens) !== limits.budgetTokens) {
    reasons.push(`预算 ${rawLimits.budgetTokens ?? "未设"} 不在允许区间，已夹到 ${limits.budgetTokens}`);
  }
  if (Number(rawLimits.wallClockMin) !== limits.wallClockMin) {
    reasons.push(
      `时限 ${rawLimits.wallClockMin ?? "未设"} 不在 ${bounds.wallClockMin.min}–${bounds.wallClockMin.max}，已夹到 ${limits.wallClockMin}`,
    );
  }

  const unknown = (input.tools ?? []).filter((t) => !KNOWN_EXEC_TOOLS.has(t) && !CHANNEL_TOOLS.has(t));
  if (unknown.length) reasons.push(`工具面里有未知工具：${unknown.join("、")}`);

  // 「ok」只看**能不能拿到岗位纪律**这一条；限额与工具是"记录并夹层"的旁证。
  // 混在一起会让每次派单都因为一条夹层而标 fallback，标记就失去意义了。
  const hasTemplate = templateSource !== "none";
  return {
    ok: hasTemplate,
    promptFallback: !hasTemplate,
    roleId: spec?.roleId ?? (roleId || "unknown"),
    domain,
    templateSource,
    templatePath,
    reasons,
    limits,
  };
}