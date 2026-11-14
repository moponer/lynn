// 走查模式：board
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "board",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.usage-board');
      return {
        present: !!b,
        cap: b?.querySelector('.usage-cap')?.textContent.trim() ?? null,
        rows: [...(b?.querySelectorAll('.usage-row') ?? [])].map((r) => r.textContent.trim().replace(/\\s+/g, " ")),
      };
    })()`);
    console.log("BOARD", JSON.stringify(info));
  },
};
