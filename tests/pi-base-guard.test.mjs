import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as zlib from "node:zlib";
import {
  collectRuntimeFiles,
  digestOf,
  groupDigests,
  filesFromTarball,
  readLockPackages,
  sha256,
} from "../scripts/check-pi-base.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 造一个最小 ustar + gzip，验证 tarball 解析路径（不依赖系统 tar） */
function miniTarGz(entries) {
  const chunks = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, "utf-8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf-8");
    header.write("0000644\0", 100, 8, "utf-8");
    header.write("0000000\0", 108, 8, "utf-8");
    header.write("0000000\0", 116, 8, "utf-8");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");
    header.write("00000000000\0", 136, 12, "utf-8");
    header.fill(32, 148, 156);
    header[156] = 48; // '0' 普通文件
    header.write("ustar\0", 257, 6, "utf-8");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test("红线守卫：仓库当前状态通过离线校验", () => {
  /**
   * 60s 是给"脚本本身跑多久"的窗口，不是"等资源"的窗口。
   *
   * 单跑时 `check-pi-base.mjs` 只要 0.7s；但全量跑时 `node --test` 会按 CPU 核数并发起
   * 195 个测试文件，`spawnSync` 起的这个子进程会被排在后面——2026-11-17 全量实测 60s 超时，
   * 单跑 8s 通过。放宽到 180s 是给测试环境留余量，不是掩盖脚本变慢。
   */
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/check-pi-base.mjs")], {
    cwd: ROOT, encoding: "utf-8", timeout: 180_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /完整未改动/);
});

test("基座清单覆盖 package-lock 里全部 Pi 包，且每项都有 integrity 与摘要", () => {
  const lock = readLockPackages();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/pi-base-manifest.json"), "utf-8"));
  assert.ok(Object.keys(lock).length >= 7);
  for (const [name, entry] of Object.entries(lock)) {
    assert.ok(entry.integrity.startsWith("sha512-"), `${name} 应有 SRI integrity`);
    const base = manifest.packages[name];
    assert.ok(base, `${name} 应在基线里`);
    assert.equal(base.version, entry.version);
    assert.equal(base.integrity, entry.integrity);
    assert.ok(base.files > 0 && /^[0-9a-f]{64}$/.test(base.digest));
  }
});

test("聚合摘要能发现任意一处运行时代码被改（含只改内容不改文件名）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-guard-"));
  try {
    fs.mkdirSync(path.join(dir, "dist", "core"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "a.js"), "const a = 1;\n");
    fs.writeFileSync(path.join(dir, "dist", "core", "b.js"), "const b = 2;\n");
    fs.writeFileSync(path.join(dir, "dist", "a.js.map"), "{}"); // 应被忽略
    const before = collectRuntimeFiles(dir);
    assert.equal(before.length, 2);
    const groups = groupDigests(before);
    assert.ok(groups["dist/core"]);

    fs.writeFileSync(path.join(dir, "dist", "core", "b.js"), "const b = 3;\n");
    const after = collectRuntimeFiles(dir);
    assert.notEqual(digestOf(before), digestOf(after));
    assert.notEqual(groups["dist/core"], groupDigests(after)["dist/core"]);
    assert.equal(groups["dist"], groupDigests(after)["dist"], "未改动的组不应变");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("npm tarball 解析：取出 package/dist 下的运行时文件并剥掉 package/ 前缀", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-tar-"));
  try {
    const tgz = path.join(dir, "pkg.tgz");
    fs.writeFileSync(tgz, miniTarGz({
      "package/package.json": "{}",
      "package/dist/index.js": "export const x = 1;\n",
      "package/dist/index.js.map": "{}",
      "package/README.md": "docs",
    }));
    const files = filesFromTarball(tgz);
    assert.deepEqual(files.map((f) => f.rel), ["dist/index.js"]);
    assert.equal(files[0].hash, sha256("export const x = 1;\n"));
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex").length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
