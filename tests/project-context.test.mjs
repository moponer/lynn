import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * 事故复现：风铃在对话里满口 "hermes / hermes-agent-rust / browser.rs"。
 *
 * 根因不是模型幻觉，是 Pi 的 resource loader **会顺着 cwd 的祖先目录**找 AGENTS.md /
 * CLAUDE.md 并塞进 system prompt；worker 当时用脚本所在目录当 cwd，
 * 于是把 F:\spiker\AGENTS.md（另一个 Rust 项目的开发指南，23KB）注入成了"项目说明"。
 *
 * 这两条用例锁住：① 这个泄漏确实存在（否则下面那条断言是空的）；
 * ② worker 用的 `noContextFiles` 选项能真正关掉它。
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctx-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "MARKER_FOREIGN_PROJECT_GUIDE\n", "utf-8");
  return { root, cwd, agentDir };
}

test("Pi 默认会顺祖先目录捡 AGENTS.md（这就是 hermes 串味的来源）", async () => {
  const { cwd, agentDir } = fixture();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const files = loader.getAgentsFiles().agentsFiles;
  assert.ok(files.length > 0, "不关的话祖先目录的 AGENTS.md 会被注入");
  assert.ok(files.some((f) => f.content.includes("MARKER_FOREIGN_PROJECT_GUIDE")));
});

test("worker 的配置关掉上下文文件：一个都不注入，system prompt 干净", async () => {
  const { cwd, agentDir } = fixture();
  // 与 agent/pi-rpc-entry.mjs 保持一致：默认 noContextFiles
  const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, [], "不许再捡任何 AGENTS.md");
});
