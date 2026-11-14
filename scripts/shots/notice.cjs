// 走查模式：notice
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "notice",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const g = document.querySelector('.gnotice');
      if (!g) return { present: false };
      const clamp = document.querySelector('.gnotice-t.clamp');
      const more = document.querySelector('.gnotice-more');
      return {
        present: true,
        hasClamp: !!clamp,
        hasExpandBtn: !!more,
        moreText: more ? more.textContent.trim() : null,
      };
    })()`);
    console.log("NOTICE", JSON.stringify(info));
  },
};
