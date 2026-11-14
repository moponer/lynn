// 走查模式：palette
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "palette",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const items = await win.webContents.executeJavaScript(`document.querySelectorAll('.cmdk-item').length`);
    console.log("PALETTE", await win.webContents.executeJavaScript(`!!document.querySelector('.cmdk')`), "items:", items);
  },
};
