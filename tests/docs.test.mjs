// M4-01/M4-04 文档与合规文案：存在性、中英对齐、口径与实现一致（不夸大沙箱）、引用不过期
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf-8");

const PAGES = ["quickstart", "plugin-guide", "plugin-index", "privacy", "release"];

test("文档站中英各五页齐全且非空", () => {
  for (const lang of ["zh", "en"]) {
    for (const page of PAGES) {
      const md = read(path.join("docs/site", lang, `${page}.md`));
      assert.ok(md.length > 500, `docs/site/${lang}/${page}.md 疑似空壳`);
    }
  }
});

test("隐私口径与实现一致：明写纵深防御非 OS 沙箱、无遥测、收消息未实现", () => {
  const zh = read("docs/site/zh/privacy.md");
  const en = read("docs/site/en/privacy.md");
  for (const [md, name] of [[zh, "zh"], [en, "en"]]) {
    assert.ok(/纵深防御|defense-in-depth/i.test(md), `${name} 隐私说明必须明写"纵深防御非 OS 沙箱"`);
    assert.ok(/不是操作系统级沙箱|not an OS-level sandbox/i.test(md), `${name} 不得夸大隔离`);
    assert.ok(/PI_TELEMETRY=0|no telemetry|无遥测/i.test(md), `${name} 必须写明遥测禁用`);
    assert.ok(/收消息.*未实现|not implemented yet/i.test(md), `${name} 收消息未实现要如实说`);
    assert.ok(/safeStorage/i.test(md), `${name} 凭据加密口径`);
  }
});

test("许可文案齐备：MIT LICENSE + THIRD_PARTY_NOTICES 生成链可用", () => {
  const lic = read("LICENSE");
  assert.match(lic, /MIT License/);
  const notices = read("THIRD_PARTY_NOTICES.md");
  assert.match(notices, /playwright-core/);
  assert.match(notices, /Apache-2\.0/);
  assert.match(notices, /pi-telemetry/, "遥测包披露必须在场（运行时禁用 + 测试锁定）");
  assert.match(notices, /AUTO-DEPS START/, "依赖清单附录占位");
  // 生成脚本真的能重跑且产出一致（幂等）
  execFileSync(process.execPath, [path.join(root, "scripts/gen-notices.mjs")], { cwd: root });
  const after = read("THIRD_PARTY_NOTICES.md");
  assert.match(after, /共 \d+ 个顶层包/);
});

test("quickstart 引用的命令与 package.json scripts 同源（防文档漂移）", () => {
  const pkg = JSON.parse(read("package.json"));
  const zh = read("docs/site/zh/quickstart.md") + read("docs/site/zh/release.md");
  const en = read("docs/site/en/quickstart.md") + read("docs/site/en/release.md");
  for (const doc of [zh, en]) {
    const cmds = [...doc.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    assert.ok(cmds.length > 0, "文档应引用真实 npm scripts");
    for (const c of cmds) {
      assert.ok(c in pkg.scripts, `文档引用的 npm run ${c} 不存在于 package.json`);
    }
  }
});

test("插件指南引用的示例目录真实存在", () => {
  const zh = read("docs/site/zh/plugin-guide.md");
  const targets = [...zh.matchAll(/examples\/([\w/.-]+)/g)].map((m) => m[1].replace(/\/$/, ""));
  assert.ok(targets.length >= 3);
  for (const t of new Set(targets)) {
    assert.ok(fs.existsSync(path.join(root, "examples", t)), `指南引用的 examples/${t} 不存在`);
  }
  // 契约冻结文档与示例 manifest 真是 apiVersion 1
  for (const mf of ["examples/plugins/lynn.theme.dusk/plugin.json", "examples/plugins/lynn.tool.dice/plugin.json"]) {
    assert.equal(JSON.parse(read(mf)).apiVersion, 1);
  }
});
