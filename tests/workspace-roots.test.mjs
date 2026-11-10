// 工作区模型（2026-11-10）：会话根集合、默认工作区、零阻断入口、多目录只读授权。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { ThreadStore } from "../dist/main/threads.js";

const tmp = (p = "lynn-roots-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("ThreadStore：RootSet 落盘；旧 projectRoot 兼容；无主根时镜像清掉", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const primary = path.join(root, "a");
  const ro = path.join(root, "ro");
  const a = s.create("甲", {
    primary,
    extras: [{ path: ro, mode: "ro", scope: "session", addedAt: new Date().toISOString(), addedBy: "user" }],
  });
  const meta = s.get(a.id);
  assert.equal(meta.roots.primary, path.resolve(primary));
  assert.equal(meta.projectRoot, path.resolve(primary), "主根镜像要同步，旧代码照常可读");
  assert.equal(meta.roots.extras.length, 1);
  assert.equal(meta.roots.extras[0].path, path.resolve(ro));

  // 旧用法：传字符串仍然可用
  const b = s.create("乙", path.join(root, "b"));
  assert.equal(s.get(b.id).projectRoot, path.resolve(root, "b"));

  // 显式无主根：镜像必须清掉，不能留下旧目录
  s.setRoots(a.id, { extras: [] });
  assert.equal(s.get(a.id).projectRoot, undefined);
  assert.equal(s.get(a.id).roots.primary, undefined);
});

test("Kernel：隔离环境默认工作区在数据根内；删光会话后直接发消息沿用默认根", async () => {
  const root = tmp("lynn-roots-k-");
  const k = new Kernel(root);
  try {
    await k.init();
    const defaultRoot = path.join(root, "workspace");
    assert.equal(k.handle("session.snapshot").project.root, defaultRoot);
    assert.ok(fs.existsSync(defaultRoot), "默认工作区要真的建出来");

    // 删掉唯一会话 → 空场；此时直接发消息（不点新建）要就地开一条且落默认根
    const first = k.handle("session.snapshot").thread.id;
    k.handle("thread.remove", { id: first });
    assert.equal(k.handle("session.snapshot").thread.id, "");
    k.handle("feed.send", { text: "在吗" });
    const snap = k.handle("session.snapshot");
    assert.ok(snap.thread.id, "第一句话要能直接说，不被'先建会话'拦住");
    assert.equal(snap.project.root, defaultRoot);
  } finally {
    await k.dispose();
  }
});

test("Kernel：新会话继承当前根；换一个会话的根不会串到别的会话", async () => {
  const root = tmp("lynn-roots-k2-");
  const k = new Kernel(root);
  const dirA = tmp("lynn-roots-a-");
  try {
    await k.init();
    const first = k.handle("session.snapshot").thread.id;
    const defaultRoot = k.handle("session.snapshot").project.root;

    // 新会话不传根 = 继承当前（默认工作区）
    const created = k.handle("session.new", {});
    assert.equal(k.handle("session.snapshot").project.root, defaultRoot);

    // 只改新会话的根
    assert.equal(k.handle("project.setRoot", { root: dirA }).ok, true);
    assert.equal(k.handle("session.snapshot").project.root, path.resolve(dirA));

    // 切回旧会话 → 回到它自己的根，不被新会话带走
    k.handle("thread.switch", { id: first });
    assert.equal(k.handle("session.snapshot").project.root, defaultRoot, "旧会话不能被新会话的目录污染");
    assert.ok(created.threadId);
  } finally {
    await k.dispose();
  }
});

test("project.setRoot：盘符根不可作为可写工作区", async () => {
  const root = tmp("lynn-roots-k3-");
  const k = new Kernel(root);
  try {
    await k.init();
    const driveRoot = path.parse(root).root; // 如 C:\
    const r = k.handle("project.setRoot", { root: driveRoot });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /整个盘|盘符|具体项目目录/);
  } finally {
    await k.dispose();
  }
});

test("只读授权：一次多个目录；整盘要确认；系统盘根永久拒", async () => {
  const root = tmp("lynn-roots-k4-");
  const k = new Kernel(root);
  const ro1 = tmp("lynn-roots-ro1-");
  const ro2 = tmp("lynn-roots-ro2-");
  try {
    await k.init();
    k.taskStore.create({ id: "t1", title: "审查单", teamId: "team" });

    const multi = k.handle("task.grantRead", { taskId: "t1", dirs: [ro1, ro2] });
    assert.equal(multi.ok, true);
    assert.equal(multi.roots.length, 2, "一次可选多个目录，不用一个个点");

    if (process.platform === "win32") {
      const dataDrive = path.parse(root).root;
      const sysDrive = path.parse(process.env.SystemRoot || "C:\\Windows").root;
      if (dataDrive.toLowerCase() !== sysDrive.toLowerCase()) {
        const unconfirmed = k.handle("task.grantRead", { taskId: "t1", dirs: [dataDrive] });
        assert.equal(unconfirmed.ok, false);
        assert.match(unconfirmed.error ?? "", /二次确认/);
      }
      const confirmed = k.handle("task.grantRead", { taskId: "t1", dirs: [sysDrive], allowDriveRoot: true });
      assert.equal(confirmed.ok, false);
      assert.match(confirmed.error ?? "", /系统盘根/, "系统盘根即使确认也不许授权");
    }
  } finally {
    await k.dispose();
  }
});

test("project.clearRoot：主根清空后快照如实说「临时」；再设根可恢复", async () => {
  const root = tmp("lynn-roots-k6-");
  const k = new Kernel(root);
  const dirA = tmp("lynn-roots-a2-");
  try {
    await k.init();
    k.handle("project.setRoot", { root: dirA });
    assert.equal(k.handle("session.snapshot").project.root, path.resolve(dirA));
    const cleared = k.handle("project.clearRoot");
    assert.equal(cleared.ok, true);
    const snap = k.handle("session.snapshot");
    assert.equal(snap.project.root, "", "清空后没有主根");
    assert.equal(snap.workspace.project, "临时");
    k.handle("project.setRoot", { root: dirA });
    assert.equal(k.handle("session.snapshot").project.root, path.resolve(dirA));
  } finally {
    await k.dispose();
  }
});

test("workspace.prefs：默认工作区与常用只读根可存可读；数据根被拒", async () => {
  const root = tmp("lynn-roots-k7-");
  const k = new Kernel(root);
  const def = tmp("lynn-roots-def-");
  const ro = tmp("lynn-roots-ro4-");
  try {
    await k.init();
    const saved = k.handle("workspace.savePrefs", { defaultWorkspace: def, knownReadRoots: [ro] });
    assert.equal(saved.ok, true);
    const got = k.handle("workspace.prefs");
    assert.equal(got.defaultWorkspace, path.resolve(def));
    assert.deepEqual(got.knownReadRoots, [path.resolve(ro)]);

    const bad = k.handle("workspace.savePrefs", { knownReadRoots: [path.join(root, "threads")] });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /数据子目录|数据目录/);
  } finally {
    await k.dispose();
  }
});

test("data.usage / data.cleanup RPC：用量可读，清理只减少过程文件", async () => {
  const root = tmp("lynn-roots-k8-");
  const k = new Kernel(root);
  try {
    await k.init();
    const taskDir = path.join(root, "tasks", "t9");
    fs.mkdirSync(path.join(taskDir, "scratch"), { recursive: true });
    fs.mkdirSync(path.join(taskDir, "artifacts"), { recursive: true });
    const old = path.join(taskDir, "scratch", "old.bin");
    fs.writeFileSync(old, "x".repeat(100), "utf-8");
    const oldTime = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(old, oldTime, oldTime);
    fs.writeFileSync(path.join(taskDir, "artifacts", "keep.txt"), "keep", "utf-8");

    const usage = k.handle("data.usage");
    assert.ok(usage.usage.scratchBytes >= 100);
    assert.equal(usage.retention.scratchDays, 14);

    const cleaned = k.handle("data.cleanup", {});
    assert.equal(cleaned.ok, true);
    assert.ok(cleaned.removed >= 1);
    assert.ok(!fs.existsSync(old));
    assert.ok(fs.existsSync(path.join(taskDir, "artifacts", "keep.txt")), "证据不动");
  } finally {
    await k.dispose();
  }
});

test("会话附加根：addRoot 进可读列表；removeRoot 撤掉；主根不会被当成附加根重复", async () => {
  const root = tmp("lynn-roots-k5-");
  const k = new Kernel(root);
  const ro = tmp("lynn-roots-ro3-");
  try {
    await k.init();
    const primary = k.handle("session.snapshot").project.root;
    const added = k.handle("workspace.addRoot", { path: ro, mode: "ro" });
    assert.equal(added.ok, true);
    const got = k.handle("workspace.get");
    assert.equal(got.primary, primary);
    assert.deepEqual(got.readable, [primary, path.resolve(ro)]);
    assert.deepEqual(got.writable, [primary], "ro 附加根不进可写列表");

    const removed = k.handle("workspace.removeRoot", { path: ro });
    assert.equal(removed.ok, true);
    assert.deepEqual(k.handle("workspace.get").readable, [primary]);
  } finally {
    await k.dispose();
  }
});
