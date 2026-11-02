// M1-18：托盘/通知偏好 —— 默认值、部分更新、快照透传
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prefs-"));

test("prefs：默认关窗进托盘+通知开；部分更新落盘并进快照", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const snap = () => kernel.handle("session.snapshot");
    assert.equal(snap().prefs.trayOnClose, true, "关窗进托盘默认开");
    assert.equal(snap().prefs.notify, true, "通知默认开");

    const r = kernel.handle("config.prefs", { autoStart: false, trayOnClose: false });
    assert.equal(r.trayOnClose, false);
    assert.equal(r.notify, true, "没改的字段保持原值");

    // 重启仍在（settings.json 持久化）
    await kernel.dispose();
  } catch (err) {
    await kernel.dispose();
    throw err;
  }

  const kernel2 = new Kernel(root);
  try {
    await kernel2.init();
    assert.equal(kernel2.handle("session.snapshot").prefs.trayOnClose, false, "重启后保留");
    assert.equal(kernel2.getPrefs().notify, true);
  } finally {
    await kernel2.dispose();
  }
});
