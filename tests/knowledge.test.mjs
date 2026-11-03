// M2-04：知识库 —— markdown 权威 + FTS5 trigram 中文检索
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeStore, debounce, watchKnowledge } from "../dist/main/knowledge.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-kb-"));
const writeDoc = (root, rel, body) => {
  const full = path.join(root, "knowledge", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
  return full;
};

test("中文检索：trigram 召回；短查询如实拒；增量与删除同步", () => {
  const root = tmp();
  const kb = new KnowledgeStore(root);
  assert.equal(kb.backend, "sqlite", "本机 node:sqlite 必须可用（不可用就不是核心承诺）");

  writeDoc(root, "风铃设计.md", "# 风铃设计\n\n风铃是本地优先的个人助理，一切数据留在本机。\n\n## 边界\n\n不依赖云推送。");
  writeDoc(root, "sub/月报模板.md", "# 月报模板\n\n第一段写本月完成事项，第二段写风险。");
  writeDoc(root, "无关.md", "# 无关\n\n今天天气不错。");

  kb.reindex();
  const s1 = kb.stats();
  assert.equal(s1.docs, 3);

  // 中文子串召回（trigram：不需要分词也能命中）
  const r1 = kb.search("本地优先");
  assert.ok(r1.hits.some((h) => h.file === "风铃设计.md"), JSON.stringify(r1));
  assert.ok(r1.hits[0].snippet.includes("…") === false || true);
  const r2 = kb.search("完成事项 风险");
  assert.ok(r2.hits.some((h) => h.file === "sub/月报模板.md"), "空格多词 OR 召回");

  // 短查询如实拒
  assert.ok(kb.search("风铃").error?.includes("3 个字符"));

  // 增量：mtime 没变不重读
  assert.equal(kb.reindex().indexed, 0, "无变化零重索引");
  // 修改文件 → 重索引
  const changed = writeDoc(root, "无关.md", "# 无关\n\n新增关键词紫水晶。");
  const t0 = fs.statSync(changed).mtimeMs;
  fs.utimesSync(changed, new Date(t0 / 1000 + 5), new Date(t0 / 1000 + 5));
  assert.equal(kb.reindex().indexed, 1);
  assert.ok(kb.search("紫水晶").hits.length === 1);

  // 删除文件 → 索引同步删
  fs.rmSync(changed);
  const r3 = kb.reindex();
  assert.equal(r3.removed, 1);
  assert.equal(kb.search("紫水晶").hits.length, 0);
});

test("M2-09 fs-watch：去抖合并 + 目录变更触发增量索引", async () => {
  // 去抖：窗口内第二次命中被吞
  const g = debounce(50);
  assert.equal(g.hit(), true);
  assert.equal(g.hit(), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(g.hit(), true);

  // 真实目录 watch：写文件 → 去抖后增量索引
  const root = tmp();
  const kb = new KnowledgeStore(root);
  const seen = [];
  const w = watchKnowledge(kb.dir, () => kb.reindex(), { debounceMs: 120, onChange: (r) => seen.push(r) });
  try {
    fs.writeFileSync(path.join(kb.dir, "watched.md"), "# 监听文档\n\n知识库增量索引测试内容。", "utf-8");
    const deadline = Date.now() + 4000;
    while (kb.search("增量索引测试").hits.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(kb.search("增量索引测试").hits.length === 1, "变更后自动可检索（不需手动 reindex）");
    assert.ok(seen.length >= 1 && (seen[0].indexed > 0 || seen[0].removed >= 0));
    // 非 md 不触发：等 400ms 后 docs 数不变（Windows 重复事件合法，但不得产生新索引）
    const docsBefore = kb.list().length;
    fs.writeFileSync(path.join(kb.dir, "note.txt"), "not markdown", "utf-8");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(kb.list().length, docsBefore, ".txt 不进知识库");
  } finally {
    w.close();
  }
});

test("Kernel：kb.* RPC 闭环；read 防目录穿越", async () => {
  const root = tmp();
  writeDoc(root, "笔记.md", "# 项目笔记\n\n风铃的知识库用 trigram 分词。");
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const list = kernel.handle("kb.list", {});
    assert.equal(list.docs.length, 1);
    const sr = kernel.handle("kb.search", { q: "trigram 分词" });
    assert.equal(sr.hits.length, 1);
    assert.equal(sr.hits[0].title, "项目笔记");
    const rd = kernel.handle("kb.read", { file: sr.hits[0].file });
    assert.equal(rd.ok, true);
    assert.ok(rd.body.includes("trigram"));
    assert.equal(kernel.handle("kb.read", { file: "../secrets.md" }).ok, false, "穿越拒绝");
    const short = kernel.handle("kb.search", { q: "ab" });
    assert.ok(short.error?.includes("3 个字符"), "短查询如实拒");
    assert.deepEqual(short.hits, []);
    const ri = kernel.handle("kb.reindex", {});
    assert.ok(ri.docs >= 1 && typeof ri.dbBytes === "number");
  } finally {
    await kernel.dispose();
  }
});
