// 走查模式：outdrawer
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "outdrawer",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.cs-linkbtn')].find(x=>x.textContent.includes('全部')); if(b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const info = await win.webContents.executeJavaScript(`(() => ({
      secs: [...document.querySelectorAll('.cs-drawer .cs-sec')].map(x=>x.textContent.trim()),
      rows: [...document.querySelectorAll('.cs-drawer .cs-ev-row')].map(r => ({
        n: (r.querySelector('.cs-ev-n')?.textContent||'').trim(),
        p: (r.querySelector('.cs-ev-p')?.textContent||'').trim(),
        clickable: r.tagName === 'BUTTON',
      })),
      counts: [...document.querySelectorAll('.cs-drawer .cs-cell')].map(x=>x.textContent.trim()),
    }))()`);
    console.log("OUTDRAWER", JSON.stringify(info, null, 1));
  },
};
