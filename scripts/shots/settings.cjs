// 走查模式：settings
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "settings",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.sf-overlay')`);
    console.log("SETTINGS", ok, overlay);
  },
};
