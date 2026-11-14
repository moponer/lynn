// 走查模式：jobs
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "jobs",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    console.log("JOBS", ok, "rows:", await win.webContents.executeJavaScript(`document.querySelectorAll('.job').length`));
  },
};
