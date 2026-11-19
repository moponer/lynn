/**
 * 工作区敏感子路径写保护（2026-11-19，借鉴 Codex allow.rs 的 deny 逻辑）。
 *
 * resolveWithin 只保证"在工作区内"，但工作区里也有不该让成员写的东西：
 * .git（篡改历史）、.env/凭据（泄密）、.ssh/.aws 等（越权）。
 * 只拒**写**，读仍允许（成员常需读 .env 才知道配置键）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-deny-"));

async function tryWrite(tk, rel, content = "x") {
  try {
    return { ok: true, out: await tk.execute("write_file", { path: rel, content }) };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

test("写工作区内的 .git 被拒（防篡改版本历史）", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const tk = new Toolkit(root);
  const r = await tryWrite(tk, ".git/config");
  assert.equal(r.ok, false, "写 .git 必须被拒");
  assert.match(r.msg, /拒绝写入|受保护|敏感/);
});

test("写 .env / 凭据文件被拒（防泄密）", async () => {
  const tk = new Toolkit(tmp());
  for (const f of [".env", ".npmrc", ".git-credentials", "id_rsa"]) {
    const r = await tryWrite(tk, f);
    assert.equal(r.ok, false, `写 ${f} 必须被拒`);
  }
});

test("子目录里的敏感目录也拒（任何层级）", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "app", ".ssh"), { recursive: true });
  const tk = new Toolkit(root);
  const r = await tryWrite(tk, "app/.ssh/id_ed25519");
  assert.equal(r.ok, false, "深层 .ssh 也必须拒");
});

test("正常文件可写（不误伤）", async () => {
  const root = tmp();
  const tk = new Toolkit(root);
  const r = await tryWrite(tk, "notes.md", "hello");
  assert.equal(r.ok, true, `正常文件应可写：${r.msg ?? ""}`);
  assert.ok(fs.existsSync(path.join(root, "notes.md")));
  // 带 .env 字样的正常名（如 env-notes.md）不该误伤
  const r2 = await tryWrite(tk, "env-notes.md", "x");
  assert.equal(r2.ok, true, "env-notes.md 是正常文件，不该拒");
});

test("敏感文件仍可读（只拒写，不拒读——成员常需读 .env 知配置键）", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, ".env"), "API_KEY=dummy");
  const tk = new Toolkit(root);
  const out = await tk.execute("read_file", { path: ".env" });
  assert.match(String(out), /API_KEY=dummy/, "读 .env 应成功");
});