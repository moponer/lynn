// Pi 真 worker 路径失败注入：429 / 500 下看它会不会重试、多久收敛。
// 用法：PI_FAIL_MODE=retry429|fail500 npx electron scripts/eval/pi-fail.cjs
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { startMock } = require("./mock-model.cjs");

delete process.env.NODE_TEST_CONTEXT; // 必须走真 Pi worker，不能降级直连
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-fail-"));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pi-fail-ud-"));
app.setPath("userData", ud);
process.env.LYNN_HOME = home;

const outDir = path.join(__dirname, "..", "..", "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

const mode = process.env.PI_FAIL_MODE === "fail500" ? "fail500" : "retry429";

app.whenReady().then(async () => {
  const mock = await startMock({ mode, failTimes: 1, chunkDelayMs: 0, chunks: 3, reply: "收到" });
  const at = new Date().toISOString();
  const entry = {
    id: "m-pi-fail",
    label: "PiFailMock",
    provider: "Mock",
    baseUrl: mock.baseUrl,
    model: "mock-1",
    apiKey: { encrypted: false, data: "k" },
    updatedAt: at,
  };
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ model: entry, models: [entry], defaultModelId: "m-pi-fail", prefs: { heartbeat: false, supervisor: false, autoStart: false } }, null, 2),
    "utf-8",
  );

  const { Kernel } = require(path.join(__dirname, "..", "..", "dist", "main", "kernel.js"));
  const k = new Kernel(home);
  await k.init();
  const t0 = performance.now();
  const result = await new Promise((resolve) => {
    let settled = false;
    const off = k.onEvent((ev) => {
      if (ev.type === "done" || ev.type === "error") finish(ev.type, ev.message);
    });
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      const snap = k.handle("session.snapshot");
      const last = [...snap.feed].reverse().find((c) => c.kind === "lynn");
      resolve({
        status,
        error: error ?? null,
        totalMs: Math.round(performance.now() - t0),
        reply: (last?.text ?? "").slice(0, 120),
        busy: snap.turn.busy,
        requests: mock.requests(),
      });
    };
    const timer = setTimeout(() => finish("timeout", "120s"), 120_000);
    k.handle("feed.send", { text: "只回复两个字：收到" });
  });

  const payload = { at: new Date().toISOString(), mode, ...result };
  fs.writeFileSync(path.join(outDir, `pi-fail-${mode}-${stamp}.json`), JSON.stringify(payload, null, 2), "utf-8");
  console.log("PI-FAIL", JSON.stringify(payload));
  await k.dispose().catch(() => undefined);
  await mock.close();
  app.exit(0);
});

setTimeout(() => {
  console.log("PI-FAIL: HARD_TIMEOUT");
  app.exit(9);
}, 240_000);
