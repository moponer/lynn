// 走查模式：threads
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "threads",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.thread-cur'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    console.log("THREADS", ok, await win.webContents.executeJavaScript(`!!document.querySelector('.thread-panel')`));
  },
};
