// 走查模式：perm
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "perm",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.seg-item.danger'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.perm-overlay')`);
    console.log("PERM", clicked, overlay);
  },
};
