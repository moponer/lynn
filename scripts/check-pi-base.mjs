/**
 * Pi 基座红线守卫（架构约束：基座完整不变，新功能一律插件式接入）
 *
 * 校验四件事，任何一件不满足即 exit 1：
 *  1. 没有 patchedDependencies / patches 目录 / git 依赖等「动基座」的痕迹；
 *  2. package-lock.json 里 @earendil-works/pi-* 的 integrity 与基线一致（换版本要显式 --update）；
 *  3. node_modules 里各包运行时代码的聚合哈希与基线一致（有人改了 dist/*.js 立刻红）；
 *  4. 项目源码不 import Pi 包的内部路径（只允许包根入口）。
 *
 * 用法：
 *   node scripts/check-pi-base.mjs              离线，对照仓库内基线清单
 *   node scripts/check-pi-base.mjs --tarball   额外从 npm 官方 tarball 重算（CI 用）
 *   node scripts/check-pi-base.mjs --update    升级 Pi 版本后重新生成基线（需 review diff）
 *
 * --tarball 用 package-lock 的 SRI integrity 校验下载到的 tarball；镜像 tarball 只要
 * 内容哈希与官方 SRI 一致即视为同一份官方发布物，不要求 resolved 域名是 npmjs.org。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "scripts", "pi-base-manifest.json");
const LOCK = path.join(ROOT, "package-lock.json");
const NODE_MODULES = path.join(ROOT, "node_modules");
const PKG_PREFIX = "@earendil-works/";
const RUNTIME_EXT = [".js", ".mjs", ".cjs"];

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** 收集一个包目录下所有运行时代码文件（排除 .map / .d.ts / 文档），相对路径统一用 / */
export function collectRuntimeFiles(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      // 嵌套依赖是 npm 安装时生成的，不属于这个包的发布物
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile() && RUNTIME_EXT.some((ext) => entry.name.endsWith(ext))) {
        out.push({ rel: relPath, hash: sha256(fs.readFileSync(full)) });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 聚合摘要：路径 + 文件哈希一起进摘要，防「只换内容不换文件名」 */
export function digestOf(files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(f.rel).update("\0").update(f.hash).update("\n");
  }
  return h.digest("hex");
}

/** 按前两级目录分组，校验失败时能定位到「哪一块被改了」 */
export function groupDigests(files) {
  const groups = {};
  for (const f of files) {
    const parts = f.rel.split("/");
    const key = parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "(root)";
    (groups[key] ??= []).push(f);
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, digestOf(v)]));
}

export function readLockPackages() {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf-8"));
  const out = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf(`node_modules/${PKG_PREFIX}`);
    if (at === -1) continue;
    const name = key.slice(at + "node_modules/".length);
    if (name.includes("/node_modules/")) continue; // 嵌套依赖不算基座包
    out[name] = {
      version: entry.version ?? "",
      integrity: entry.integrity ?? "",
      resolved: entry.resolved ?? "",
    };
  }
  return out;
}

/** 内部路径导入 = 把 Pi 的实现细节焊进壳里；只允许包根入口 */
export function findInternalImports() {
  const bad = [];
  // 只认真正的 import/require 语句，别把注释里提到的路径当违规
  const pattern = /\bfrom\s*["'][^"']*@earendil-works\/pi-[\w-]+\/(?:dist|core|src)\/|\brequire\(\s*["'][^"']*@earendil-works\/pi-[\w-]+\/(?:dist|core|src)\//;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:mjs|cjs|js|ts|tsx)$/.test(entry.name)) {
        fs.readFileSync(full, "utf-8").split(/\r?\n/).forEach((line, i) => {
          if (pattern.test(line)) bad.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
  };
  for (const r of ["agent", "src", "tests", "scripts"]) {
    const dir = path.join(ROOT, r);
    if (fs.existsSync(dir)) walk(dir);
  }
  return bad;
}

/** 打补丁 / fork 的痕迹：pnpm patchedDependencies、patches 目录、非 registry 依赖 */
export function findBaseMutations(lockPackages) {
  const bad = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  if (pkg.patchedDependencies || pkg.pnpm?.patchedDependencies) bad.push("package.json 声明了 patchedDependencies");
  const ws = path.join(ROOT, "pnpm-workspace.yaml");
  if (fs.existsSync(ws) && /patchedDependencies/i.test(fs.readFileSync(ws, "utf-8"))) {
    bad.push("pnpm-workspace.yaml 声明了 patchedDependencies");
  }
  const patchesDir = path.join(ROOT, "patches");
  if (fs.existsSync(patchesDir)) {
    for (const f of fs.readdirSync(patchesDir)) {
      if (/pi-|@earendil|tether/i.test(f)) bad.push(`patches/ 里有基座补丁：${f}`);
    }
  }
  for (const [name, entry] of Object.entries(lockPackages)) {
    if (!entry.integrity) bad.push(`${name} 缺少 integrity（可能是 git/file 依赖或 fork）`);
    else if (entry.resolved && !/^https?:\/\//.test(entry.resolved)) bad.push(`${name} 的 resolved 不是 registry tarball：${entry.resolved}`);
  }
  for (const script of ["postinstall", "preinstall"]) {
    const s = pkg.scripts?.[script];
    if (s && /patch|node_modules|pi-/.test(s)) bad.push(`package.json 的 ${script} 可能改写 node_modules：${s}`);
  }
  return bad;
}

/** 极简 ustar 解析：npm tarball 是 gzip + POSIX tar，dist 下的文件名不会触发 PAX 长名 */
function parseTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf-8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf-8").replace(/\0.*$/s, "").trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const start = off + 512;
    if (type === "0" || type === "\0") {
      out.push({ name: prefix ? `${prefix}/${name}` : name, data: buf.subarray(start, start + size) });
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** 从 npm tarball 取出运行时文件（不落盘、不解压到 node_modules） */
export function filesFromTarball(tgz) {
  return parseTar(zlib.gunzipSync(fs.readFileSync(tgz)))
    .filter((e) => /^package\/.+/.test(e.name) && !e.name.includes("/node_modules/") && RUNTIME_EXT.some((ext) => e.name.endsWith(ext)))
    .map((e) => ({ rel: e.name.slice("package/".length), hash: sha256(e.data) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 直接取 lock 里 resolved 的 tarball（不调用 npm CLI）：
 * Windows 下 .cmd 的引号/转义差异会让 npm pack 时好时坏，而 fetch 全平台一致。
 * 镜像不可达时回退 npmjs.org 的同一路径。
 */
async function downloadTarball(name, version, resolved, dest) {
  const file = path.basename(new URL(resolved).pathname) || `${name.split("/").pop()}-${version}.tgz`;
  const fallback = `https://registry.npmjs.org/${name}/-/${file}`;
  const urls = [...new Set([resolved, fallback])].filter((u) => /^https?:\/\//.test(u));
  let lastError = "";
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (err) {
      lastError = `${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`下载官方 tarball 失败（${lastError}）`);
}

function sriMatches(tgz, integrity) {
  const [algo, expected] = integrity.split("-", 2);
  if (!expected) return false;
  return crypto.createHash(algo).update(fs.readFileSync(tgz)).digest("base64") === expected;
}

function buildEntry(name, lockEntry, files) {
  return {
    version: lockEntry.version,
    integrity: lockEntry.integrity,
    files: files.length,
    digest: digestOf(files),
    groups: groupDigests(files),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const tarball = args.has("--tarball");
  const lockPackages = readLockPackages();
  const names = Object.keys(lockPackages).sort();
  if (!names.length) {
    console.error("[pi-base] package-lock.json 里没有 @earendil-works/pi-* 包");
    process.exit(1);
  }

  const problems = [
    ...findBaseMutations(lockPackages),
    ...findInternalImports().map((x) => `源码 import 了 Pi 内部路径：${x}`),
  ];

  const installed = {};
  for (const name of names) {
    const dir = path.join(NODE_MODULES, ...name.split("/"));
    const files = collectRuntimeFiles(dir);
    if (!files.length) problems.push(`${name} 的运行时代码不存在（node_modules 未安装或被清空）`);
    installed[name] = files;
  }

  let manifest = {
    note: "Pi 基座基线；升级版本用 node scripts/check-pi-base.mjs --update 生成并 review diff",
    packages: {},
  };
  if (fs.existsSync(MANIFEST)) manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));

  if (update) {
    manifest.packages = Object.fromEntries(
      names.map((name) => [name, buildEntry(name, lockPackages[name], installed[name])]),
    );
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    console.log(
      `[pi-base] 基线已更新：${names.length} 个包，${Object.values(manifest.packages).reduce((n, e) => n + e.files, 0)} 个运行时文件`,
    );
  } else {
    for (const name of names) {
      const base = manifest.packages?.[name];
      const now = buildEntry(name, lockPackages[name], installed[name]);
      if (!base) {
        problems.push(`${name} 不在基线里（新增基座包需 --update）`);
        continue;
      }
      if (base.version !== now.version || base.integrity !== now.integrity) {
        problems.push(`${name} 版本/来源 integrity 与基线不一致（升级 Pi 要显式 --update 并 review）`);
      }
      if (base.files !== now.files) problems.push(`${name} 运行时文件数变化：基线 ${base.files} → 当前 ${now.files}`);
      if (base.digest !== now.digest) {
        const changed = Object.keys({ ...base.groups, ...now.groups })
          .filter((g) => base.groups[g] !== now.groups[g])
          .join("、");
        problems.push(`${name} 运行时代码被改动（差异目录：${changed || "未知"}）`);
      }
    }
  }

  if (tarball) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot(), "lynn-pi-base-"));
    try {
      for (const name of names) {
        try {
          const tgz = path.join(tmp, `${name.replace("/", "_")}-${lockPackages[name].version}.tgz`);
          await downloadTarball(name, lockPackages[name].version, lockPackages[name].resolved, tgz);
          if (!sriMatches(tgz, lockPackages[name].integrity)) {
            problems.push(`${name} 的 npm tarball 与 package-lock 的 integrity 不一致（不是官方发布物）`);
            continue;
          }
          const official = filesFromTarball(tgz);
          const local = installed[name];
          if (digestOf(official) !== digestOf(local)) {
            const o = new Map(official.map((f) => [f.rel, f.hash]));
            const diff = local
              .filter((f) => o.get(f.rel) !== f.hash)
              .map((f) => f.rel)
              .concat(official.filter((f) => !local.some((x) => x.rel === f.rel)).map((f) => f.rel));
            problems.push(`${name} 与 npm tarball 不一致：${diff.slice(0, 10).join("、")}${diff.length > 10 ? ` …共 ${diff.length} 个` : ""}`);
          } else {
            console.log(`[pi-base] ${name} == 官方 tarball（${official.length} 个运行时文件）`);
          }
        } catch (err) {
          problems.push(`${name} 无法与 npm tarball 对账：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (problems.length) {
    console.error(`[pi-base] 红线校验失败（${problems.length} 项）：`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[pi-base] 通过：${names.length} 个 Pi 基座包完整未改动，无 patch / fork / 内部路径依赖${tarball ? "，且已与 npm tarball 对账" : ""}`);
}

function tmpRoot() {
  return fs.realpathSync(process.env.TMPDIR || process.env.TEMP || process.env.TMP || ".");
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error(`[pi-base] 守卫自身异常：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
