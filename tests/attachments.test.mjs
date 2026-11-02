// M1-16：本轮随附 —— 文件注入/图片落盘/检索 + kernel 级随附卡
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTurnAttachments, searchProjectFiles, MAX_FILE_BYTES } from "../dist/main/attachments.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-attach-"));
const PNG = (n = 1) =>
  `data:image/png;base64,${Buffer.alloc(n, 7).toString("base64")}`;

test("buildTurnAttachments：文件内容进 fullText；越界截断并注明", () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.ts"), "const a = 1;\n", "utf-8");
  const big = "x".repeat(MAX_FILE_BYTES + 1000);
  fs.writeFileSync(path.join(project, "src", "big.txt"), big, "utf-8");

  const r = buildTurnAttachments(project, root, "看看这两个文件", {
    files: ["src/a.ts", "src/big.txt"],
  });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.pieces, [
    { kind: "file", label: "src/a.ts" },
    { kind: "file", label: "src/big.txt" },
  ]);
  assert.ok(r.fullText.startsWith("看看这两个文件"));
  assert.ok(r.fullText.includes("【本轮随附】"));
  assert.ok(r.fullText.includes("const a = 1;"));
  assert.ok(r.fullText.includes("只带了前 256KB"), "越界要注明，不静默");
  assert.ok(!r.fullText.includes("y".repeat(100)));
});

test("buildTurnAttachments：不存在/逃逸/非图片 如实报错不静默", () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });

  const r = buildTurnAttachments(project, root, "带一下", {
    files: ["没有的.ts", "../outside.txt"],
    images: [{ name: "坏图.png", data: "data:text/plain;base64,SGk=" }],
  });
  assert.equal(r.pieces.length, 0);
  assert.ok(r.errors.some((e) => e.includes("没有的.ts")));
  assert.ok(r.errors.some((e) => e.includes("../outside.txt")));
  assert.ok(r.errors.some((e) => e.includes("坏图.png")));
  assert.equal(r.fullText, "带一下", "全没带上就不该有附块");
});

test("buildTurnAttachments：图片按 data URL 落盘并给绝对路径", () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });

  const r = buildTurnAttachments(project, root, "看图", {
    images: [{ name: "截图/ Shot 1.png", data: PNG(32) }],
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.savedImages.length, 1);
  const saved = r.savedImages[0];
  assert.ok(fs.existsSync(saved), "图片真的落盘了");
  assert.equal(fs.readFileSync(saved).length, 32);
  assert.ok(r.fullText.includes(saved), "消息里给出落盘路径");
  assert.ok(r.fullText.includes("read_file"), "提示模型可读图");
});

test("searchProjectFiles：列相对路径、过滤关键词、排除 node_modules", () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "x", "utf-8");
  fs.writeFileSync(path.join(project, "src", "kernel.ts"), "x", "utf-8");
  fs.writeFileSync(path.join(project, "src", "kernel.test.ts"), "x", "utf-8");
  fs.writeFileSync(path.join(project, "node_modules", "pkg", "index.js"), "x", "utf-8");

  const all = searchProjectFiles(project, "");
  assert.ok(all.some((f) => f.path === "src/kernel.ts"));
  assert.ok(!all.some((f) => f.path.includes("node_modules")), "依赖目录不进补全");
  const hit = searchProjectFiles(project, "kernel");
  assert.equal(hit.length, 2);
  assert.ok(hit.every((f) => f.path.includes("kernel")));
  assert.equal(searchProjectFiles(project, "", 1).length, 1, "limit 生效");
});

test("Kernel：feed.send 带随附 → 用户卡标注随附片；读不到的如实出卡", async () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "note.md"), "# 附带内容\n", "utf-8");
  process.env.LYNN_PROJECT_DIR = project;

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("feed.send", {
      text: "帮我看看",
      attachments: { files: ["note.md", "ghost.md"] },
    });
    const feed = kernel.handle("session.snapshot").feed;
    const user = feed.filter((c) => c.kind === "user").pop();
    assert.ok(user?.meta?.includes("note.md"), "用户卡标注带上的片");
    const sys = feed.find((c) => c.kind === "system" && (c.text ?? "").includes("ghost.md"));
    assert.ok(sys, "读不到的随附要如实出卡，不静默丢");
  } finally {
    delete process.env.LYNN_PROJECT_DIR;
    await kernel.dispose();
  }
});
