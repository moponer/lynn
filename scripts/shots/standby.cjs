// 走查模式：standby
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "standby",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log("STANDBY", await win.webContents.executeJavaScript(`!!document.querySelector('.standby')`));
  },
};
