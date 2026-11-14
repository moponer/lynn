// 走查模式：rosterinfo —— 右栏编制区：chip 计数、组头、群公告是否渲染
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 里给 win（BrowserWindow）。
module.exports = {
  mode: "rosterinfo",
  async run({ win }) {
    const info = await win.webContents.executeJavaScript(`(() => ({
      chips: [...document.querySelectorAll('.rf-chip')].map(c => c.textContent.trim()),
      head: document.querySelector('.panel-h')?.textContent.trim(),
      others: [...document.querySelectorAll('.tgroup-others-h')].map(h => h.textContent.trim()),
      goto: [...document.querySelectorAll('.tg-goto')].map(h => h.textContent.trim()),
      gnotice: !!document.querySelector('.gnotice'),
      hint: document.querySelector('.roster-note-quiet')?.textContent.trim() ?? null,
    }))()`);
    console.log("ROSTERINFO", JSON.stringify(info));
  },
};
