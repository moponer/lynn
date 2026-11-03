// M3-08 中英 i18n：语言包即 L0 插件（校验/解析/覆盖）、zh 源语言回退、prefs.lang 持久化
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkLangPack, translate, mergeStrings } from "../dist/shared/i18n.js";
import { ZH_STRINGS, EN_STRINGS } from "../dist/shared/i18n-strings.js";
import { checkManifest } from "../dist/main/plugin-manifest.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-i18n-"));

test("语言包校验：结构坏拒并列出全部问题；合法过审", () => {
  assert.equal(checkLangPack(null).ok, false);
  const bad = checkLangPack({ lang: "fr", strings: { a: "ok", b: 42 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.includes("lang")));
  assert.ok(bad.issues.some((i) => i.includes("strings.b")));

  const ok = checkLangPack({ lang: "en", strings: { "nav.model": "Model" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.pack.lang, "en");
});

test("translate：占位替换；缺 key 返回 undefined 由调用方回退", () => {
  assert.equal(translate({ a: "你好 {name}" }, "a", { name: "风铃" }), "你好 风铃");
  assert.equal(translate({ a: "undo: {files}" }, "a", { files: "x.md" }), "undo: x.md");
  assert.equal(translate({ a: "{missing} 原样" }, "a"), "{missing} 原样");
  assert.equal(translate({}, "nope"), undefined);
  // 源语言纪律：zh 必须覆盖 en 的全部 key（en 只能缺、不能多出没有源文案的 key）
  for (const k of Object.keys(EN_STRINGS)) {
    assert.ok(k in ZH_STRINGS, `en 多出 zh 没有的 key：${k}`);
  }
});

test("manifest：contributes.langs 形状校验（数组、.json 结尾）", () => {
  const base = {
    id: "lynn.self.langpack",
    name: "langpack",
    version: "1.0.0",
    apiVersion: 1,
    tier: "L0",
    engines: { kernel: ">=0.0.1" },
    source: "self-authored",
    generatedBy: "t",
  };
  const bad = checkManifest({ ...base, contributes: { langs: "en.json" } });
  assert.equal(bad.ok, false);
  const bad2 = checkManifest({ ...base, contributes: { langs: ["en.txt"] } });
  assert.equal(bad2.ok, false);
  const ok = checkManifest({ ...base, contributes: { langs: ["en.json"] } });
  assert.equal(ok.ok, true);
});

test("内核 i18n.get：默认 zh=内置源语言；lang=en 用英文字典；语言包插件按 lang 覆盖；prefs.lang 持久化", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();

    const zh = kernel.handle("i18n.get", {});
    assert.equal(zh.lang, "zh");
    assert.equal(zh.strings["nav.model"], ZH_STRINGS["nav.model"]);
    assert.deepEqual(zh.sources, []);

    // 切英文：字典换成 en
    const saved = kernel.handle("config.prefs", { autoStart: false, lang: "en" });
    assert.equal(saved.lang, "en");
    const en = kernel.handle("i18n.get", {});
    assert.equal(en.lang, "en");
    assert.equal(en.strings["nav.model"], EN_STRINGS["nav.model"]);

    // 非法语言如实拒
    const bad = kernel.handle("config.prefs", { autoStart: false, lang: "fr" });
    assert.equal(bad.ok, false);

    // 语言包 L0 插件（enabled 默认开）：en 包覆盖内置 en 词条
    const plugDir = path.join(root, "plugins", "lynn.community.fancy-strings");
    fs.mkdirSync(plugDir, { recursive: true });
    fs.writeFileSync(
      path.join(plugDir, "plugin.json"),
      JSON.stringify({
        id: "lynn.community.fancy-strings",
        name: "Fancy Strings",
        version: "1.0.0",
        apiVersion: 1,
        tier: "L0",
        engines: { kernel: ">=0.0.1" },
        source: "marketplace",
        contributes: { langs: ["en.json"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugDir, "en.json"),
      JSON.stringify({ lang: "en", strings: { "nav.model": "Brain" } }),
      "utf-8",
    );
    const merged = kernel.handle("i18n.get", {});
    assert.equal(merged.strings["nav.model"], "Brain", "插件语言包覆盖内置");
    assert.equal(merged.strings["nav.look"], EN_STRINGS["nav.look"], "未覆盖词条仍用内置");
    assert.deepEqual(merged.sources, ["lynn.community.fancy-strings"]);

    // zh 模式下该插件不参与（它只带 en 包）
    kernel.handle("config.prefs", { autoStart: false, lang: "zh" });
    const zh2 = kernel.handle("i18n.get", {});
    assert.equal(zh2.strings["nav.model"], ZH_STRINGS["nav.model"]);
    assert.deepEqual(zh2.sources, []);

    // 持久化：重启读回（同 root 新 Kernel）
    await kernel.dispose();
    const kernel2 = new Kernel(root);
    await kernel2.init();
    assert.equal(kernel2.handle("i18n.get", {}).lang, "zh");
    await kernel2.dispose();
  } finally {
    // dispose 已在上面走（kernel2 也 dispose）
  }
});

test("mergeStrings：over 覆盖 base，不动 base 本体", () => {
  const base = { a: "甲" };
  const out = mergeStrings(base, { a: "乙", b: "丙" });
  assert.deepEqual(out, { a: "乙", b: "丙" });
  assert.deepEqual(base, { a: "甲" });
});
