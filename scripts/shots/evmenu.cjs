// 走查模式：evmenu
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "evmenu",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    // 证据页签只在"选中一张单"时出现：先切到工单视图、点开第一张单
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')].find(x=>(x.textContent||'').includes('工单')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 350));
    await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.job'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 450));
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.tab')].find(x=>(x.textContent||'').includes('交付')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.evr');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 10),
      }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const info = await win.webContents.executeJavaScript(`(() => ({
      items: [...document.querySelectorAll('.jobmenu-item')].map(b => b.textContent.trim()),
      title: document.querySelector('.jobmenu-title')?.textContent.trim() ?? null,
      sub: document.querySelector('.jobmenu-sub')?.textContent.trim() ?? null,
      diag: {
        jobs: document.querySelectorAll('.job').length,
        tabs: [...document.querySelectorAll('.tab')].map(x => x.textContent.trim()),
        evr: document.querySelectorAll('.evr').length,
        spines: document.querySelectorAll('.spine-empty').length,
      },
    }))()`);
    console.log("EVMENU", JSON.stringify({ clicked, ...info }));
  },
};
