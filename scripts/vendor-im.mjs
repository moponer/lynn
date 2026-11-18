#!/usr/bin/env node
/**
 * 拉取 dsh-im 的渠道实现到 vendor 目录（2026-11-18 P15-1）。
 *
 * 为什么用脚本而不是手工复制：
 *  - 76 个文件，手工漏一个就是运行时缺依赖；
 *  - 要记录上游 commit，将来升级时能知道从哪来；
 *  - 要**只取需要的**：跳过测试、跳过 ru/en 语言包（我们只用中文）。
 *
 * 只取国内渠道 + shared 公共层。国外渠道（telegram/discord/slack/whatsapp/
 * matrix/imessage/email/office）不取——用户要的是国内渠道。
 *
 * 用法：node scripts/vendor-im.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const DEST = path.join(repo, "src", "main", "im", "vendor");

const OWNER = "xmanrui";
const REPO = "dsh-im";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

/** 要取的渠道（国内） */
const CHANNELS = ["feishu", "dingtalk", "qq", "wecom", "wecom-app", "weixin"];

/**
 * 跳过规则。
 *
 * 注意：**不能跳过 i18n-ru / i18n-en**。第一版我按"只用中文"把它们排除了，
 * 结果 `i18n.mjs` 在顶层 `import { EN } from './i18n-en.mjs'`，整个 vendor 加载失败。
 *
 * 它们体积不小（几百 KB），但是**必需依赖**——`t()` 的语言回退链要用。
 * 这是"不要自己造轮子"的一个具体含义：轮子的零件也是轮子的一部分。
 */
function shouldSkip(p) {
  if (p.includes(".test.")) return true;
  if (p.endsWith(".md")) return true;
  return false;
}

async function main() {
  console.log("拉取 dsh-im 渠道实现到 vendor/\n");

  // 1) 取文件树
  const treeUrl = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
  let tree = null;
  for (let attempt = 1; attempt <= 3 && !tree; attempt += 1) {
    try {
      const res = await fetch(treeUrl, { headers: { "user-agent": "lynn-vendor-script" } });
      const j = await res.json();
      if (j.tree) tree = j.tree;
      else console.log(`  第 ${attempt} 次取树失败：${j.message ?? "?"}`);
    } catch (e) {
      console.log(`  第 ${attempt} 次取树出错：${String(e.message).slice(0, 80)}`);
    }
  }
  if (!tree) {
    console.error("取不到文件树，放弃");
    process.exit(1);
  }

  // 2) 筛出要的文件
  const wanted = tree.filter((t) => {
    if (t.type !== "blob") return false;
    if (!t.path.startsWith("src/channels/")) return false;
    if (shouldSkip(t.path)) return false;
    const seg = t.path.split("/")[2]; // src/channels/<seg>/...
    if (!seg) return false;
    return seg === "shared" || CHANNELS.includes(seg);
  });
  console.log(`待取 ${wanted.length} 个文件，共 ${Math.round(wanted.reduce((s, t) => s + (t.size ?? 0), 0) / 1024)} KB\n`);

  // 3) 逐个下载
  fs.rmSync(DEST, { recursive: true, force: true });
  let ok = 0;
  const failed = [];
  for (const t of wanted) {
    const rel = t.path.replace(/^src\/channels\//, "");
    const dest = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
      try {
        const res = await fetch(`${RAW}/${t.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        done = true;
        ok += 1;
      } catch (e) {
        if (attempt === 3) failed.push(`${rel}（${String(e.message).slice(0, 60)}）`);
      }
    }
    if (ok % 20 === 0) process.stdout.write(`  ${ok}/${wanted.length}\r`);
  }
  console.log(`\n完成：${ok} 个成功，${failed.length} 个失败`);
  for (const f of failed.slice(0, 10)) console.log(`  ✖ ${f}`);

  // 4) 记录上游信息 + 许可
  const meta = {
    upstream: `https://github.com/${OWNER}/${REPO}`,
    branch: BRANCH,
    fetchedAt: new Date().toISOString(),
    license: "MIT",
    copyright: "Copyright (c) 2026 xmanrui",
    note: "只取国内渠道 + shared；跳过测试与 ru/en 语言包。vendor 内容不改一行，升级时整体覆盖。",
    channels: CHANNELS,
    files: ok,
  };
  fs.writeFileSync(path.join(DEST, "UPSTREAM.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(DEST, "LICENSE"),
    `MIT License\n\nCopyright (c) 2026 xmanrui\n\n` +
      `本目录下的代码来自 ${meta.upstream}（MIT 许可）。\n` +
      `原样保留，未做修改；改动只发生在本项目自己的适配层。\n\n` +
      `完整许可文本见仓库根目录的 THIRD_PARTY_NOTICES.md。\n`,
    "utf8",
  );
  console.log(`\n已写 UPSTREAM.json 与 LICENSE`);
  if (failed.length) process.exit(1);
}

await main();
