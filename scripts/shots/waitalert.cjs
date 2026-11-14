// 走查模式：waitalert
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "waitalert",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const a = document.querySelector('.cs-alert');
      return {
        alert: !!a,
        top: a ? (a.querySelector('.cs-alert-top')?.textContent || '').trim() : null,
        title: a ? (a.querySelector('.cs-alert-t')?.textContent || '').trim() : null,
        detail: a ? (a.querySelector('.cs-alert-d')?.textContent || '').trim() : null,
        acts: a ? [...a.querySelectorAll('.cs-alert-acts button')].map(b => b.textContent.trim()) : [],
        sealMini: (document.querySelector('.cs-seal-mini')?.textContent || '').trim(),
        seal: (document.querySelector('.cs-seal .s-cn')?.textContent || '').trim(),
        readouts: [...document.querySelectorAll('.cs-readout')].map(x => x.textContent.trim()),
      };
    })()`);
    console.log("WAITALERT", info);
  },
};
