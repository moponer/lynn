/**
 * 插件包导入（2026-11-17 P9-2）。
 *
 * 用户的三个要求在这里落地：
 *  1. **手动安装标准插件文件包** —— 用户拖一个 `.zip`（或目录）进来就能装；
 *  2. **风铃自己开发后加载** —— 她走工坊起草，产物也是同一个包结构，走同一条导入路径；
 *  3. **错误必须直接拦截显示** —— 校验失败要给出**具体到字段**的原因，不是"导入失败"。
 *
 * 为什么不做"解压到 plugins/ 就完事"：
 *  - zip 里有 `../` 路径会写出 plugins/ 之外（zip slip），必须逐条校验；
 *  - 一个包里可能带多个插件，得先看清再决定装哪个；
 *  - manifest 不过 `checkManifest` 的包装进去只会让 `scan()` 每次报错。
 *
 * 所以流程是：**解到临时目录 → 校验 → 原子移入**。任何一步失败，plugins/ 里不留垃圾。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { checkManifest, type PluginManifest } from "./plugin-manifest";
import { insideBase } from "./path-guard";
import { updatePluginFromDir } from "./plugin-versions";

/** 一个待装插件包的内容 */
export interface PluginPackage {
  /** 包根目录（解压后的临时目录） */
  dir: string;
  manifest: PluginManifest;
  /** manifest 里声明的入口文件是否存在 */
  entryOk: boolean;
  /** 包内文件清单（相对路径） */
  files: string[];
  /** 总体积（字节） */
  bytes: number;
}

export interface ImportIssue {
  /** 哪一步失败：unpack / layout / manifest / entry / size / conflict */
  stage: string;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  /** 装好的插件 id（ok=true 时） */
  id?: string;
  /** 落点目录 */
  dir?: string;
  /** 更新后的版本号（override 更新时） */
  version?: string;
  /** 被归档的旧版本目录名（override 更新时，可用于回滚） */
  archived?: string;
  issues: ImportIssue[];
}

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024; // 32MB：插件包里不该有视频/大模型
const MAX_FILES = 2000;

/**
 * 极简 zip 解包（只支持 stored/deflate，够读我们自己打的包）。
 *
 * 为什么不用 jszip：它是 `@js-preview/excel` 的**传递依赖**，不是直接依赖。
 * 直接 require 一个没写进 package.json 的包，等哪天上游换依赖就会突然崩——
 * 这类"幽灵依赖"事故很难查。项目里 `docx-read.ts` 已经有同样手法的实现。
 */
export function unzipToDir(zip: Buffer, destDir: string): { files: string[]; issues: ImportIssue[] } {
  const files: string[] = [];
  const issues: ImportIssue[] = [];
  let offset = 0;
  let count = 0;

  while (offset < zip.length - 4) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // 不是本地文件头：到中央目录了
    if (++count > MAX_FILES) {
      issues.push({ stage: "unpack", message: `包内文件超过 ${MAX_FILES} 个上限` });
      break;
    }
    const method = zip.readUInt16LE(offset + 8);
    const compSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    offset = dataStart + compSize;

    // 目录项：建目录即可
    if (name.endsWith("/")) {
      const dir = path.join(destDir, name);
      if (!insideBase(destDir, dir)) {
        issues.push({ stage: "unpack", message: `包内路径越界：${name}` });
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }

    /**
     * zip slip 防护：`../../x` 或绝对路径会写到 destDir 之外。
     * 这是解压类功能的头号漏洞，必须在**写之前**判断，不是写完再删。
     */
    const target = path.resolve(destDir, name);
    if (!insideBase(destDir, target)) {
      issues.push({ stage: "unpack", message: `包内路径越界（zip slip）：${name}` });
      continue;
    }

    let content: Buffer;
    try {
      content = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    } catch (e) {
      issues.push({ stage: "unpack", message: `${name} 解压失败：${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files.push(name);
  }

  if (!files.length && !issues.length) {
    issues.push({ stage: "unpack", message: "这个 zip 里没有文件（或格式不支持）" });
  }
  return { files, issues };
}

/** 在目录里找插件（包根就是插件，或包内有一层目录是插件） */
export function locatePluginRoot(dir: string): { root: string; manifestFile: string } | null {
  const direct = path.join(dir, "plugin.json");
  if (fs.existsSync(direct)) return { root: dir, manifestFile: direct };
  // 允许包内套一层目录（用户从 GitHub 下载的 zip 常带一层）
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const sub = path.join(dir, entry.name, "plugin.json");
    if (fs.existsSync(sub)) return { root: path.join(dir, entry.name), manifestFile: sub };
  }
  return null;
}

function walkFiles(root: string, base = root): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/**
 * 从解压后的目录读出一个插件包（只校验，不安装）。
 * 这一步是"错误必须直接拦截显示"的关键：所有问题在这里一次列全，而不是装到一半才报。
 */
export function readPackage(dir: string): { pkg: PluginPackage | null; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const found = locatePluginRoot(dir);
  if (!found) {
    return { pkg: null, issues: [{ stage: "layout", message: "包里没有 plugin.json（不是插件包，或者少了清单）" }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(found.manifestFile, "utf8"));
  } catch (e) {
    return {
      pkg: null,
      issues: [{ stage: "manifest", message: `plugin.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  const check = checkManifest(raw);
  if (!check.ok) {
    return {
      pkg: null,
      issues: check.issues.map((i) => ({ stage: "manifest", message: `${i.field}：${i.message}` })),
    };
  }
  const manifest = raw as PluginManifest;

  // 入口文件必须真的在（L1 声明了 entry 却没有文件 = 装上就报错）
  let entryOk = true;
  if (manifest.entry) {
    const entryPath = path.join(found.root, manifest.entry);
    if (!insideBase(found.root, entryPath) || !fs.existsSync(entryPath)) {
      entryOk = false;
      issues.push({ stage: "entry", message: `manifest 声明的入口不存在：${manifest.entry}` });
    }
  }

  const files = walkFiles(found.root);
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(found.root, f)).size, 0);
  if (bytes > MAX_PACKAGE_BYTES) {
    issues.push({ stage: "size", message: `包体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_PACKAGE_BYTES / 1024 / 1024}MB 上限` });
  }

  return { pkg: { dir: found.root, manifest, entryOk, files, bytes }, issues };
}

/**
 * 导入一个插件包（zip 文件或目录），装进 `<dataRoot>/plugins/<id>/`。
 *
 * 原子性：先解到临时目录、校验通过后**整体移入**。中途任何失败都不在 plugins/ 留垃圾。
 * 冲突：目标 id 已存在就拒（不覆盖）——覆盖会丢掉"能不能回滚"这件事，
 * 要更新得走 24 章第 6 节那条还没做的可回滚路径。
 */
export function importPluginPackage(
  source: string,
  dataRoot: string,
  opts: { override?: boolean } = {},
): ImportResult {
  const issues: ImportIssue[] = [];
  const pluginsRoot = path.join(dataRoot, "plugins");
  fs.mkdirSync(pluginsRoot, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pkg-"));
  let workDir = tmp;
  try {
    const st = fs.statSync(source);
    if (st.isFile()) {
      if (st.size > MAX_PACKAGE_BYTES) {
        return { ok: false, issues: [{ stage: "size", message: `包体积超过 ${MAX_PACKAGE_BYTES / 1024 / 1024}MB 上限` }] };
      }
      const un = unzipToDir(fs.readFileSync(source), tmp);
      issues.push(...un.issues);
      if (un.issues.some((i) => i.stage === "unpack" && /越界/.test(i.message))) {
        return { ok: false, issues }; // 有越界就别继续了
      }
    } else if (st.isDirectory()) {
      workDir = source;
    } else {
      return { ok: false, issues: [{ stage: "layout", message: "只接受 .zip 文件或插件目录" }] };
    }

    const { pkg, issues: readIssues } = readPackage(workDir);
    issues.push(...readIssues);
    if (!pkg || issues.some((i) => i.stage === "manifest" || i.stage === "layout" || i.stage === "entry" || i.stage === "size")) {
      return { ok: false, issues };
    }

    const id = pkg.manifest.id;
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id.includes("..")) {
      return { ok: false, issues: [...issues, { stage: "manifest", message: `插件 id 不合法：${id}` }] };
    }
    const dest = path.join(pluginsRoot, id);
    if (!insideBase(pluginsRoot, dest)) {
      return { ok: false, issues: [...issues, { stage: "manifest", message: `落点越界：${id}` }] };
    }
    /**
     * 冲突处理（P12-1）：默认拒；显式 `override` 时走**版本化更新**。
     *
     * 不直接覆盖的原因：覆盖会同时丢掉回滚能力与审计线索。
     * `updatePluginFromDir` 会先归档旧版再落新版，任一步失败旧版还在。
     */
    if (fs.existsSync(dest)) {
      if (!opts.override) {
        return {
          ok: false,
          issues: [
            ...issues,
            {
              stage: "conflict",
              message: `插件库已有 ${id}。要换成新版本请用「更新」（会先归档旧版，可回滚），或用「卸载」后再装`,
            },
          ],
        };
      }
      const updated = updatePluginFromDir(dataRoot, id, pkg.dir);
      if (!updated.ok) {
        return { ok: false, issues: [...issues, ...updated.issues] };
      }
      return {
        ok: true,
        id,
        dir: dest,
        ...(updated.version ? { version: updated.version } : {}),
        ...(updated.archived ? { archived: updated.archived } : {}),
        issues,
      };
    }

    // 原子移入：先拷到 plugins/ 下的临时名，再 rename（同盘 rename 是原子的）
    const staging = path.join(pluginsRoot, `_importing-${id}-${Date.now()}`);
    fs.cpSync(pkg.dir, staging, { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    return { ok: true, id, dir: dest, issues };
  } catch (e) {
    return { ok: false, issues: [...issues, { stage: "io", message: e instanceof Error ? e.message : String(e) }] };
  } finally {
    // 临时目录只在"我们从 zip 解出来"时才清；用户给的目录不动
    if (workDir === tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 留给系统清理 */
      }
    }
  }
}