const { _electron: electron } = require("playwright-core");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ui-smoke-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ui-ud-"));
  const at = new Date().toISOString();
  const entry = { id: "m-mock", label: "Mock", provider: "Mock", baseUrl: "http://127.0.0.1:1/v1", model: "mock-1", apiKey: { encrypted: false, data: "k" }, updatedAt: at };
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ model: entry, models: [entry], defaultModelId: "m-mock", prefs: { heartbeat: false, supervisor: false, autoStart: false, trayOnClose: false } }, null, 2),
    "utf-8",
  );
  console.log("launching");
  const app = await electron.launch({
    args: [".", `--user-data-dir=${ud}`],
    cwd: path.resolve(__dirname, "..", ".."),
    env: { ...process.env, LYNN_HOME: home, LYNN_PROJECT_DIR: home, NODE_TEST_CONTEXT: "eval", LYNN_UPDATE_FEED: "" },
    timeout: 60000,
  });
  console.log("launched");
  await new Promise((r) => setTimeout(r, 5000));
  const wins = app.windows();
  console.log("windows", wins.map((w) => w.url()));
  const win = wins[0];
  if (win) {
    const info = await win.evaluate(() => ({
      composer: document.querySelectorAll(".composer-in").length,
      rail: document.querySelectorAll(".rail-seg").length,
      wiz: document.querySelectorAll(".wiz").length,
      text: document.body.innerText.slice(0, 300),
    }));
    console.log("DOM", JSON.stringify(info));
  }
  await app.close();
  console.log("closed");
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
