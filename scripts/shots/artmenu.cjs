// 走查模式：artmenu
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "artmenu",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    // 频道默认只展开"你最近一次说话"之后的往来：先点开历史，产物 chip 才在 DOM 里
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/上回合|历史|展开/.test(x.textContent||'')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 350));
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.rp-file');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: Math.round(r.x + 16), clientY: Math.round(r.y + 8),
      }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const info = await win.webContents.executeJavaScript(`(() => ({
      items: [...document.querySelectorAll('.jobmenu-item')].map(b => b.textContent.trim()),
      title: document.querySelector('.jobmenu-title')?.textContent.trim() ?? null,
      files: document.querySelectorAll('.rp-file').length,
    }))()`);
    console.log("ARTMENU", JSON.stringify({ clicked, ...info }));
  },
};
