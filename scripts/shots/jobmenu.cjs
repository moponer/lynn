// 走查模式：jobmenu
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "jobmenu",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const ok = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.job');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 24 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "JOBMENU",
      ok,
      "items:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.jobmenu-item').length`),
    );
  },
};
