// M3-07 插件工坊（§4.11）：规格 → 派"插件工程师" → 草稿区 → 准入 → 启用。
//  硬规则（写死在代码里，不靠自觉）：
//  1. 成员产物只能落在草稿区 <dataRoot>/plugins/_drafts/<id>/（`_` 前缀目录
//     被 plugin-host / plugin-set 扫描天然跳过——草稿永不自动生效）；
//  2. 她不得给自己的产物提权（Q6 定稿 C）：L0 技能可自启用（记审计 + 告知），
//     L1/L2 只能 review + 呈报，promote 必须带 byUser（用户点的那一下）；
//  3. 工坊产物必为自研：manifest.source=self-authored + generatedBy 可追溯（§4.11.6）；
//  4. 准入按档位分强度：L0 无代码校验、L1 禁项扫描命中即拒、L2 recipe 命令形状；
//  5. 冲突即拒并报明双方（§4.11.5：不自作主张改名）。
import * as fs from "node:fs";
import * as path from "node:path";
import { checkManifest, type PluginManifest } from "./plugin-manifest";
import { checkPluginCss, checkThemeFile } from "./plugin-host";

export const WORKSHOP_KINDS = ["L0", "L1", "L2"] as const;
export type WorkshopKind = (typeof WORKSHOP_KINDS)[number];

export interface DraftMeta {
  draftId: string;
  title: string;
  kind: WorkshopKind;
  taskId?: string;
  spec: string;
  createdAt: string;
  status: "draft" | "reviewed" | "enabled";
}

export interface ReviewFinding {
  ok: boolean;
  text: string;
}

export interface ReviewResult {
  ok: boolean;
  verdict: "approved" | "rejected";
  tier: WorkshopKind;
  findings: ReviewFinding[];
  /** Q6 定稿 C：只有 L0 允许她自启用 */
  selfEnable: boolean;
  manifest?: PluginManifest;
}

export function draftsDir(dataRoot: string): string {
  return path.join(dataRoot, "plugins", "_drafts");
}

const DRAFT_ID_RE = /^d-[a-z0-9]+(-[a-z0-9]+)*$/;

function assertSafeDraftId(draftId: string): void {
  if (!DRAFT_ID_RE.test(draftId)) throw new Error(`非法草稿 id：${draftId}`);
}

function draftDir(dataRoot: string, draftId: string): string {
  assertSafeDraftId(draftId);
  return path.join(draftsDir(dataRoot), draftId);
}

function readMeta(dataRoot: string, draftId: string): DraftMeta {
  try {
    return JSON.parse(fs.readFileSync(path.join(draftDir(dataRoot, draftId), "_meta.json"), "utf-8")) as DraftMeta;
  } catch {
    throw new Error(`草稿 ${draftId} 不存在或元数据损坏`);
  }
}

function writeMeta(dataRoot: string, draftId: string, meta: DraftMeta): void {
  fs.mkdirSync(draftDir(dataRoot, draftId), { recursive: true });
  fs.writeFileSync(path.join(draftDir(dataRoot, draftId), "_meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

/** 开一张草稿：落规格 + 元数据。产物目录由"插件工程师"成员在派单时写（workdir=草稿区） */
export function createDraft(
  dataRoot: string,
  input: { title: string; kind: WorkshopKind; spec: string; taskId?: string },
): DraftMeta {
  if (!(WORKSHOP_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`未知档位：${input.kind}（工坊只造 L0/L1/L2，U 档走皮肤包投稿规范）`);
  }
  if (!input.spec.trim()) throw new Error("规格必填：解决什么、输入输出、边界、最小权限集、验收用例（§4.11.2）");
  const draftId = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const meta: DraftMeta = {
    draftId,
    title: input.title.trim() || draftId,
    kind: input.kind,
    taskId: input.taskId,
    spec: input.spec,
    createdAt: new Date().toISOString(),
    status: "draft",
  };
  writeMeta(dataRoot, draftId, meta);
  fs.writeFileSync(
    path.join(draftDir(dataRoot, draftId), "spec.md"),
    `# 规格 · ${meta.title}\n\n- 档位：${meta.kind}\n- 来源任务：${meta.taskId ?? "无（用户直接提出）"}\n\n${meta.spec}\n`,
    "utf-8",
  );
  return meta;
}

export function listDrafts(dataRoot: string): DraftMeta[] {
  const dir = draftsDir(dataRoot);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: DraftMeta[] = [];
  for (const id of entries) {
    try {
      out.push(readMeta(dataRoot, id));
    } catch {
      /* 坏目录跳过，不拖垮列表 */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- 禁项扫描（§4.11.3：L1 最严，命中即拒） ----------

const FORBIDDEN = [
  { re: /\beval\s*\(/, why: "eval" },
  { re: /new\s+Function\s*\(/, why: "new Function" },
  { re: /child_process/, why: "child_process" },
  { re: /postinstall/, why: "postinstall 钩子" },
  { re: /node-gyp|\.node['"]\s*\)/, why: "原生模块加载" },
  { re: /[0-9a-fA-F]{64,}/, why: "长十六进制串（混淆/内嵌载荷嫌疑）" },
] as const;

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const MAX_SOURCE_BYTES = 256 * 1024; // 源码可读：单文件体积上限（§4.11.6）

function listCodeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "state") continue;
        walk(full);
      } else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* 读不了当没有 */
  }
  return out;
}

/** 工坊产物里允许出现的文件（草稿自留文件之外全部算产物） */
const DRAFT_OWNED = new Set(["_meta.json", "spec.md", "_brief.md"]);

function productFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !DRAFT_OWNED.has(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// ---------- 准入审查（静态流水线；隔离试装见 plugin-host.probe） ----------

export function reviewDraft(
  dataRoot: string,
  draftId: string,
  existing: { pluginIds: string[]; skillNames: string[] },
): ReviewResult {
  const meta = readMeta(dataRoot, draftId);
  const dir = draftDir(dataRoot, draftId);
  const findings: ReviewFinding[] = [];
  const fail = (text: string) => findings.push({ ok: false, text });

  const products = productFiles(dir);
  if (!products.length) fail("草稿区没有任何产物：插件工程师还没交付（应有 plugin.json 与档位要求的内容）");

  let manifest: PluginManifest | undefined;
  const manifestPath = path.join(dir, "plugin.json");
  if (fs.existsSync(manifestPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      fail(`plugin.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (raw !== undefined) {
      const check = checkManifest(raw);
      if (!check.ok) {
        for (const i of check.issues) fail(`manifest 不合规格：${i.field} — ${i.message}`);
      } else {
        manifest = raw as PluginManifest;
        findings.push({ ok: true, text: `manifest 校验通过（${manifest.id}@${manifest.version}，${manifest.tier}）` });
        // 档位一致：规格说造 L0，交付 L1 就是提权，拒
        if (manifest.tier !== meta.kind) {
          fail(`档位不一致：规格是 ${meta.kind}，交付 manifest.tier=${manifest.tier}——按规格档位交付，或重开规格`);
        }
        // 工坊产物必为自研且可追溯（§4.11.6）
        if (manifest.source !== "self-authored") {
          fail("工坊产物必须标 source=self-authored（可追溯是自研插件的准入前提）");
        }
        if (!manifest.generatedBy) {
          fail("工坊产物必须标 generatedBy（哪个任务/哪次生成产出的，§4.11.6）");
        }
        // 冲突检测：id 与现有插件冲突（§4.11.5：报明双方，不改名）
        if (existing.pluginIds.includes(manifest.id)) {
          fail(`插件 id 冲突：${manifest.id} 已存在于插件库——换 id 或先卸载旧插件`);
        }
        // L0：无代码红线——有 entry 或任何代码文件都拒
        if (manifest.tier === "L0") {
          if (manifest.entry) fail("L0 是声明式产物（无代码）：manifest 不得声明 entry");
          const code = listCodeFiles(dir).filter((f) => !f.endsWith("_meta.json"));
          if (code.length) fail(`L0 不得携带代码文件：${code.map((f) => path.basename(f)).join("、")}`);
          for (const s of manifest.contributes?.skills ?? []) {
            if (existing.skillNames.includes(s)) fail(`技能名冲突：「${s}」已有同名技能（§4.11.5）`);
          }
          // L0 技能插件必须真带技能产物（spec ↔ 交付对账）
          const skills = manifest.contributes?.skills ?? [];
          for (const s of skills) {
            if (!fs.existsSync(path.join(dir, s, "SKILL.md"))) {
              fail(`技能 ${s} 缺 SKILL.md（声明了目录就要有内容）`);
            }
          }
          // L0 形态层（theme / style / langs）：声明式产物，同样逐项对账 + 静态检查
          const themeRel = manifest.contributes?.theme;
          if (themeRel) {
            const themePath = path.join(dir, themeRel);
            if (!fs.existsSync(themePath)) {
              fail(`contributes.theme 指向的文件不存在：${themeRel}`);
            } else {
              let parsed: unknown;
              try {
                parsed = JSON.parse(fs.readFileSync(themePath, "utf-8"));
              } catch (err) {
                parsed = null;
                fail(`theme 文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
              }
              if (parsed !== null) {
                const tc = checkThemeFile(parsed);
                if (!tc.ok) for (const i of tc.issues) fail(`theme 不合规格：${i}`);
              }
            }
          }
          const styleRel = manifest.contributes?.style;
          if (styleRel) {
            const stylePath = path.join(dir, styleRel);
            if (!fs.existsSync(stylePath)) {
              fail(`contributes.style 指向的文件不存在：${styleRel}`);
            } else {
              let body = "";
              try {
                body = fs.readFileSync(stylePath, "utf-8");
              } catch (err) {
                fail(`形态层读不出：${err instanceof Error ? err.message : String(err)}`);
              }
              const sc = checkPluginCss(body);
              if (!sc.ok) for (const i of sc.issues) fail(`形态层不合规格：${i}`);
            }
          }
          const langs = manifest.contributes?.langs ?? [];
          for (const l of langs) {
            if (!fs.existsSync(path.join(dir, l))) fail(`contributes.langs 指向的文件不存在：${l}`);
          }
          // L0 别只交个空的 manifest：至少要有一种声明式产物（技能 / 主题 / 形态层 / 语言包 / 卡槽视图）
          const slotView = (manifest.contributes?.slots ?? []).length > 0;
          if (!skills.length && !themeRel && !styleRel && !langs.length && !slotView) {
            fail("L0 插件至少要交一种声明式产物：contributes.skills / theme / style / langs / slots（§4.11.1）");
          }
        }
        // L1：禁项扫描，命中即拒；entry 必须真实存在
        if (manifest.tier === "L1") {
          if (!manifest.entry) {
            fail("L1 必须声明 entry");
          } else if (!fs.existsSync(path.join(dir, manifest.entry))) {
            fail(`entry 不存在：${manifest.entry}`);
          }
          for (const f of listCodeFiles(dir)) {
            let body: string;
            try {
              body = fs.readFileSync(f, "utf-8");
            } catch {
              continue;
            }
            if (Buffer.byteLength(body, "utf-8") > MAX_SOURCE_BYTES) {
              fail(`${path.basename(f)} 超过单文件体积上限（256KB）——源码必须可读可 diff（§4.11.6）`);
              continue;
            }
            for (const p of FORBIDDEN) {
              if (p.re.test(body)) fail(`${path.basename(f)} 命中禁项「${p.why}」——L1 崩的是内核进程，命中即拒（§4.11.3）`);
            }
          }
        }
        // L2：recipe 命令形状（白名单形状：单一命令 + 参数数组，禁 shell 元字符）
        if (manifest.tier === "L2") {
          const recipe = manifest.mcp?.recipe;
          if (!recipe) {
            fail("L2 必须声明 mcp.recipe");
          } else {
            try {
              const r = JSON.parse(fs.existsSync(path.join(dir, recipe))
                ? fs.readFileSync(path.join(dir, recipe), "utf-8")
                : recipe) as { command?: unknown; args?: unknown };
              if (typeof r.command !== "string" || !r.command.trim()) {
                fail("L2 recipe.command 必须是可执行名");
              } else if (/[|;&`><]/.test(r.command)) {
                fail(`L2 recipe.command 含 shell 元字符：${r.command}`);
              }
              if (r.args !== undefined && !Array.isArray(r.args)) fail("L2 recipe.args 必须是数组");
            } catch {
              fail(`mcp.recipe 不是合法 JSON（内联或文件 ${recipe}）`);
            }
          }
        }
      }
    }
  } else {
    fail("缺 plugin.json（manifest 是准入第一关）");
  }

  const ok = findings.every((f) => f.ok);
  const verdict = ok ? "approved" : "rejected";
  if (ok) {
    meta.status = "reviewed";
    writeMeta(dataRoot, draftId, meta);
  }
  return { ok, verdict, tier: meta.kind, findings, selfEnable: ok && meta.kind === "L0", manifest };
}

// ---------- 启用（影子 → 正式的落点） ----------

/**
 * 把通过审的草稿迁入插件库（影子/正式由档位与 byUser 决定）：
 *  - L0 + 她自启用（byUser=false）：允许（Q6 定稿 C），调用方负责记审计 + 告知用户；
 *  - L1/L2：必须 byUser=true（用户点的那一下），否则拒——她不得给自己的产物提权；
 *  - 迁入后文件在 plugins/<id>/，是否 enabled 由 plugin-host 默认规则 + 插件面板接管
 *    （L1/L2 第三方默认 disabled = 影子态；用户在面板点启用才进全局工具面）。
 */
export function promoteDraft(dataRoot: string, draftId: string, byUser: boolean): { id: string; tier: WorkshopKind; byUser: boolean } {
  const meta = readMeta(dataRoot, draftId);
  if (meta.status !== "reviewed") {
    throw new Error(`草稿 ${draftId} 尚未过审（status=${meta.status}）：先 review，产物没过准入不进插件库`);
  }
  if (meta.kind !== "L0" && !byUser) {
    throw new Error("L1/L2 必须由用户点启用（Q6 定稿 C：她不得给自己的产物提权）。请让用户在插件面板确认。");
  }
  const dir = draftDir(dataRoot, draftId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8")) as PluginManifest;
  const dest = path.join(dataRoot, "plugins", manifest.id);
  if (fs.existsSync(dest)) throw new Error(`插件库已有 ${manifest.id}，不能覆盖（冲突即拒，§4.11.5）`);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (DRAFT_OWNED.has(name)) continue;
    fs.cpSync(path.join(dir, name), path.join(dest, name), { recursive: true });
  }
  meta.status = "enabled";
  writeMeta(dataRoot, draftId, meta);
  return { id: manifest.id, tier: meta.kind, byUser };
}

export function discardDraft(dataRoot: string, draftId: string): void {
  const dir = draftDir(dataRoot, draftId);
  if (!fs.existsSync(dir)) throw new Error(`草稿 ${draftId} 不存在`);
  fs.rmSync(dir, { recursive: true, force: true });
}
