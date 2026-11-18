#!/usr/bin/env node
/**
 * 插件包校验器（P9-3 / 25 章第 3 节）。
 *
 * 为什么单独一个 CLI：写插件的人（人、风铃、Codex、任何 agent）需要一个
 * **不用装依赖、不用起应用**就能跑的检查。装之前发现总比装上之后报错好。
 *
 * 它和 `importPluginPackage` 共用同一套校验逻辑（`readPackage`）——
 * 如果这里过了而导入时失败，那是 bug，不是"两套标准"。
 *
 * 用法：
 *   node scripts/check-plugin-package.mjs <目录或 .zip>
 *   node scripts/check-plugin-package.mjs plugins/_templates/theme-l0
 *   node scripts/check-plugin-package.mjs --all-templates
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const jiti = createJiti(import.meta.url);
const { readPackage, unzipToDir } = await jiti.import("../src/main/plugin-package.ts", { default: true });

/** 把一个目标（目录或 zip）解成临时目录再校验 */
function prepare(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) return { dir: target, cleanup: null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-check-"));
  const un = unzipToDir(fs.readFileSync(target), tmp);
  return { dir: tmp, cleanup: tmp, unzipIssues: un.issues };
}

function checkOne(target, label) {
  const problems = [];
  let prepared;
  try {
    prepared = prepare(target);
  } catch (e) {
    return { label, ok: false, problems: [`读不了这个目标：${e instanceof Error ? e.message : String(e)}`] };
  }
  try {
    if (prepared.unzipIssues?.length) {
      for (const i of prepared.unzipIssues) problems.push(`[${i.stage}] ${i.message}`);
    }
    const { pkg, issues } = readPackage(prepared.dir);
    for (const i of issues) problems.push(`[${i.stage}] ${i.message}`);
    if (pkg) {
      // 额外做两件导入器不做、但写插件的人应该知道的事
      if (!pkg.files.includes("README.md") && !pkg.files.some((f) => /^readme\.md$/i.test(f))) {
        problems.push("[建议] 缺 README.md：别人（和未来的你）需要知道这插件干什么");
      }
      if (pkg.bytes > 4 * 1024 * 1024) {
        problems.push(`[建议] 包体积 ${(pkg.bytes / 1024 / 1024).toFixed(1)}MB 偏大，检查是否误打包了依赖或素材`);
      }
      return {
        label,
        ok: !problems.some((p) => !p.startsWith("[建议]")),
        problems,
        pkg,
      };
    }
    return { label, ok: false, problems };
  } finally {
    if (prepared.cleanup) {
      try {
        fs.rmSync(prepared.cleanup, { recursive: true, force: true });
      } catch {
        /* 留给系统清理 */
      }
    }
  }
}

const argv = process.argv.slice(2);
const targets = [];

if (argv.includes("--all-templates")) {
  const dir = path.join(repo, "plugins", "_templates");
  if (!fs.existsSync(dir)) {
    console.error(`没有模板目录：${path.relative(repo, dir)}`);
    process.exit(1);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) targets.push({ target: path.join(dir, e.name), label: `模板 ${e.name}` });
  }
} else {
  const rest = argv.filter((a) => !a.startsWith("--"));
  if (!rest.length) {
    console.error("用法：node scripts/check-plugin-package.mjs <目录或 .zip> | --all-templates");
    process.exit(2);
  }
  for (const t of rest) targets.push({ target: path.resolve(t), label: t });
}

let bad = 0;
for (const { target, label } of targets) {
  const r = checkOne(target, label);
  if (!r.ok) bad += 1;
  const mark = r.ok ? "✅" : "✖ ";
  console.log(`${mark} ${label}`);
  if (r.pkg) {
    console.log(
      `     id=${r.pkg.manifest.id} tier=${r.pkg.manifest.tier} v${r.pkg.manifest.version} ` +
        `文件 ${r.pkg.files.length} 个 / ${(r.pkg.bytes / 1024).toFixed(1)}KB`,
    );
  }
  for (const p of r.problems) console.log(`     ${p}`);
}

if (bad) {
  console.log(`\n${bad} 个包没通过。上面每条都写清了是哪一步、什么原因。`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过（${targets.length} 个）。`);
}
