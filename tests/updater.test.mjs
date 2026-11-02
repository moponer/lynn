// M1-23：更新器纯逻辑 —— feed 解析 + 状态机
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFeedUrl, transition } from "../dist/main/updater.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-upd-"));

test("resolveFeedUrl：env 优先，其次 updater.json，都没有 → null", () => {
  const root = tmp();
  assert.equal(resolveFeedUrl({}, root), null, "未配置如实返回 null");
  fs.writeFileSync(path.join(root, "updater.json"), JSON.stringify({ feedUrl: "https://dl.example.com/lynn/" }), "utf-8");
  assert.equal(resolveFeedUrl({}, root), "https://dl.example.com/lynn/");
  assert.equal(resolveFeedUrl({ LYNN_UPDATE_FEED: "https://env.example.com/" }, root), "https://env.example.com/", "env 优先");
  fs.writeFileSync(path.join(root, "updater.json"), "{broken", "utf-8");
  assert.equal(resolveFeedUrl({}, root), null, "坏配置不算配置");
});

const base = () => ({ supported: true, version: "0.1.0", phase: "idle" });

test("transition：available → downloading → downloaded；error 如实带 message", () => {
  const a = transition(base(), { type: "available", version: "0.2.0" });
  assert.equal(a.phase, "available");
  assert.equal(a.latest, "0.2.0");

  const p = transition({ ...a, phase: "downloading" }, { type: "progress", percent: 150 });
  assert.equal(p.percent, 100, "进度夹在 0-100");
  const p2 = transition({ ...a }, { type: "progress", percent: 50 });
  assert.equal(p2.percent, undefined, "非下载态不接进度（不谎报）");

  const d = transition({ ...a, phase: "downloading" }, { type: "downloaded" });
  assert.equal(d.phase, "downloaded");
  assert.equal(d.percent, 100);

  const e = transition(base(), { type: "error", message: "网络不通" });
  assert.equal(e.error, "网络不通");
  assert.equal(e.phase, "idle", "出错不动阶段");

  const n = transition(base(), { type: "not-available" });
  assert.equal(n.phase, "none");
  assert.equal(n.latest, undefined);
});
