// 走查模式：outputs
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "outputs",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')].find(x=>(x.textContent||'').includes('交付箱')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const info = await win.webContents.executeJavaScript(`(() => ({
      rows: [...document.querySelectorAll('.out-row')].map(r => ({
        name: r.querySelector('b')?.textContent.trim(),
        who: r.querySelector('small')?.textContent.trim(),
        meta: r.querySelector('.out-meta')?.textContent.trim() ?? null,
        h: Math.round(r.getBoundingClientRect().height),
      })),
      badge: [...document.querySelectorAll('.rail-seg-item')].find(x=>(x.textContent||'').includes('交付箱'))?.textContent.trim(),
    }))()`);
    console.log("OUTPUTS", JSON.stringify(info));
  },
};
