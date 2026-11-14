// 项目身份（2026-11-12）：目录升格为项目——同一个目录 = 同一个项目，
// 改名跟着项目走，对话里（风铃 system prompt / 成员 prompt）都要看得见是哪个项目。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { ProjectStore } from "../dist/main/projects.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-proj-"));

test("ProjectStore：同一个目录复用同一个项目；新目录新建，名字取 basename", () => {
  const root = tmp();
  const store = new ProjectStore(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-work-"));
  const a = store.ensureByPath(dir);
  const b = store.ensureByPath(dir);
  assert.equal(a.id, b.id, "同一目录必须是同一个项目");
  assert.equal(a.name, path.basename(dir));

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-work2-"));
  const c = store.ensureByPath(other);
  assert.notEqual(c.id, a.id, "不同目录是不同的项目");

  // 改名后复用同一 id，名字跟着走
  const renamed = store.rename(a.id, "深拷贝");
  assert.equal(renamed?.name, "深拷贝");
  assert.equal(store.ensureByPath(dir).name, "深拷贝", "再按路径找回来，名字仍是改过的");
  assert.equal(store.list().length, 2);
});

test("Kernel：选目录 = 绑项目；群里显示项目名；改名跟着项目走", async () => {
  const root = tmp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-work-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const set = kernel.handle("project.setRoot", { root: dir });
    assert.equal(set.ok, true);
    assert.ok(set.project?.id, "选目录后要有项目身份");

    const snap = kernel.handle("session.snapshot");
    assert.equal(snap.workspace.projectName, path.basename(dir));
    assert.equal(snap.workspace.projectId, set.project.id);
    assert.ok(
      snap.threads.some((t) => t.projectName === path.basename(dir)),
      "群列表里要能看出这个群在做哪个项目",
    );

    // 改名：项目级改，所有绑它的群一起变
    const renamed = kernel.handle("project.rename", { id: set.project.id, name: "深拷贝项目" });
    assert.equal(renamed.ok, true);
    const snap2 = kernel.handle("session.snapshot");
    assert.equal(snap2.workspace.projectName, "深拷贝项目");
    assert.ok(snap2.threads.some((t) => t.projectName === "深拷贝项目"));

    // 换目录 = 换项目
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-other-"));
    const set2 = kernel.handle("project.setRoot", { root: dir2 });
    assert.notEqual(set2.project.id, set.project.id, "换目录 = 换项目");
  } finally {
    await kernel.dispose();
  }
});

test("Kernel：两个会话选同一个目录 = 同一个项目（身份跨群共享）", async () => {
  const root = tmp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-work-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const a = kernel.handle("project.setRoot", { root: dir });
    const firstId = kernel.handle("session.snapshot").thread.id;
    kernel.handle("session.new", {});
    const b = kernel.handle("project.setRoot", { root: dir });
    assert.equal(a.project.id, b.project.id, "同一目录在不同群里也是同一个项目");

    // 改名后，另一个群里也显示新名字（显示名来自项目，不是群）
    kernel.handle("project.rename", { id: a.project.id, name: "共享项目" });
    kernel.handle("thread.switch", { id: firstId });
    assert.equal(kernel.handle("session.snapshot").workspace.projectName, "共享项目");
  } finally {
    await kernel.dispose();
  }
});

test("对话里知道是哪个项目：风铃 system prompt 带项目名与目录", async () => {
  const root = tmp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-work-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("project.setRoot", { root: dir });
    const prompt = kernel.systemPrompt();
    assert.match(prompt, /【当前项目】/, "system prompt 里必须有项目段");
    assert.ok(prompt.includes(path.basename(dir)), "要写项目名");
    assert.ok(prompt.includes(path.resolve(dir)), "要写项目目录（派单不用再猜路径）");

    // 不用工作区时如实说，不假装有项目
    kernel.handle("project.clearRoot");
    const prompt2 = kernel.systemPrompt();
    assert.match(prompt2, /本次不用项目目录/, "没有项目时要如实说");
  } finally {
    await kernel.dispose();
  }
});
