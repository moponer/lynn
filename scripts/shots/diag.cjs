// 走查模式：diag
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "diag",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        mcard: q('.mcard'), threadRow: q('.thread-row'), right: q('.right'),
        roster: q('.roster'), gnotice: q('.gnotice'),
        bodyClasses: document.body.className, htmlLen: document.body.innerHTML.length,
        sampleDivs: [...document.querySelectorAll('div')].slice(0,40).map(d=>d.className.split(' ')[0]).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i),
      };
    })()`);
    console.log("DIAG", JSON.stringify(info));
  },
};
