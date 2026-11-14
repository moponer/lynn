/**
 * 真 Pi 会话路径的缓存 A/B 对照（2026-11-14）。
 *
 * 与 live-usage-probe.cjs 的区别：那个是自己拼 messages 走直连 fetch；
 * 这个**实例化真 Kernel + 真 PiRpcHost 子进程 + 真 systemPrompt()/turnFacts()**，
 * 走生产主力路径（host.updateSystemPrompt → host.prompt → host.stats → usage_round）。
 *
 * 用 `electron scripts/live-pi-usage-probe.cjs` 跑：需要 safeStorage 解密已配置的 Key。
 * 临时数据根 + 临时 userData，不碰用户的 .lynn，也不与运行中的 app 抢 GPU 缓存。
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL_USER_DATA = path.join(os.homedir(), "AppData", "Roaming", "lynn");
const PROBE_USER_DATA = path.join(os.tmpdir(), "lynn-pi-probe-userdata");
fs.mkdirSync(PROBE_USER_DATA, { recursive: true });
const localState = path.join(REAL_USER_DATA, "Local State");
if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(PROBE_USER_DATA, "Local State"));
app.setName("Lynn");
app.setPath("userData", PROBE_USER_DATA);
app.disableHardwareAcceleration();

const REAL_SETTINGS = path.join(os.homedir(), ".lynn", "settings.json");
const { Kernel } = require("../dist/main/kernel.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rowsOf(root) {
  const f = path.join(root, "logs", "usage.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
}

async function waitNewRow(root, prev, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = rowsOf(root);
    if (rows.length > prev) return { row: rows[rows.length - 1], count: rows.length };
    await sleep(300);
  }
  return { row: null, count: prev };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-probe-"));
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.copyFileSync(REAL_SETTINGS, path.join(root, "settings.json"));

  const kernel = new Kernel(root);
  kernel.setEncryptors(
    (p) => safeStorage.encryptString(p),
    () => safeStorage.isEncryptionAvailable(),
    (b) => safeStorage.decryptString(b),
  );

  console.log("\n=== 真 Pi 会话路径：缓存 A/B 对照 ===");
  try {
    await kernel.init();
    console.log(`piReady=${kernel.piReady}  projectRoot=${kernel.projectRoot || "(none)"}`);
    if (!kernel.piReady) {
      console.log("Pi 运行时不可用，无法做本对照（不降级成直连冒充）");
      await kernel.dispose();
      return;
    }
    kernel.handle("config.prefs", { autoStart: false, advisorEnabled: false });

    const question = "请只回复 OK，不要解释，不要调用任何工具。";
    const steps = [
      ["r1 稳定前缀", null],
      ["r2 稳定前缀(重复)", null],
      ["r3 改群公告(新方案：system 不变)", "notice-A"],
      ["r4 再改群公告(新方案)", "notice-B"],
      ["r5 改 persona(阳性对照：system 变)", "persona"],
      ["r6 稳定", null],
    ];

    const results = [];
    for (const [name, action] of steps) {
      const before = rowsOf(root).length;
      const sysBefore = kernel.systemPrompt ? kernel.systemPrompt().length : -1;

      if (action === "notice-A" || action === "notice-B") {
        const text =
          action === "notice-A"
            ? "整体：审月报；接缝：数据员交给审计员；共享写入点归审计员。"
            : "整体：审月报；接缝：数据员交给复核员；共享写入点归复核员。";
        kernel.handle("thread.announcement", { id: kernel.currentThreadId, text });
      } else if (action === "persona") {
        kernel.handle("persona.save", { text: "你是风铃，一个多智能体指挥助理。回答简短，只回复事实，不要寒暄。" });
      }

      const sent = kernel.handle("feed.send", { text: question });
      const { row, count } = await waitNewRow(root, before);
      const sysAfter = kernel.systemPrompt ? kernel.systemPrompt().length : -1;
      const u = kernel.usage ?? {};
      const r = {
        name,
        sent: sent?.queued ? "queued" : "ok",
        source: row?.source ?? "(none)",
        rowIn: row?.in ?? null,
        rowCacheRead: row?.cacheRead ?? null,
        breakReason: row?.cacheBreakReason ?? null,
        turnHitRate: u.turnHitRate ?? null,
        sessionIn: u.sessionIn ?? null,
        cacheRead: u.cacheRead ?? null,
        sysLenChanged: sysBefore !== sysAfter,
        gotRow: !!row,
      };
      results.push(r);
      console.log(
        `  ${name.padEnd(34)} src=${String(r.source).padEnd(7)} ` +
          `row(in=${String(r.rowIn).padStart(5)} read=${String(r.rowCacheRead).padStart(5)}) ` +
          `turnHit=${String(r.turnHitRate).padStart(6)}% 累计Hit=${String(r.cacheRead).padStart(7)} ` +
          `system变=${r.sysLenChanged} reason=${r.breakReason ?? "-"}`,
      );
      if (!row) console.log("    ⚠ 90s 内没等到 usage 行（可能降级/超时）");
      await sleep(600);
    }

    const out = path.join(__dirname, "..", "shots", "live-pi-usage-probe.json");
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), piReady: true, results }, null, 2), "utf8");
    console.log(`\n结果已写 ${out}`);
  } finally {
    await kernel.dispose().catch(() => undefined);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error("Pi 对照探针失败：", err?.stack ?? err);
  } finally {
    app.exit(0);
  }
});
