// 走查模式：about ——「我的风铃」→ 导航底部「关于」：定义段 / 版本行 / 五组清单是否真的渲染
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 里给 win（BrowserWindow）。
module.exports = {
  mode: "about",
  async run({ win }) {
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1100));
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.sf-nav-foot .sf-nav-item'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const info = await win.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector('.sf-pane');
      const rows = [...document.querySelectorAll('.sf-pane .sf-row')].map(r => ({
        k: r.querySelector('.sf-about-k')?.textContent.trim() ?? null,
        v: (r.querySelector('.sf-about-v')?.textContent.trim() ?? '').slice(0, 16),
      }));
      return {
        opened: !!pane,
        navOn: !!document.querySelector('.sf-nav-foot .sf-nav-item.on'),
        title: document.querySelector('.sf-about-head h3')?.textContent.trim() ?? null,
        lead: (document.querySelector('.sf-about-lead')?.textContent.trim() ?? '').slice(0, 24),
        meta: document.querySelector('.sf-about-meta')?.textContent.trim() ?? null,
        heads: [...document.querySelectorAll('.sf-pane .sf-group-head b')].map(x => x.textContent.trim()),
        hints: document.querySelectorAll('.sf-pane .sf-group-head small').length,
        rows,
        lines: [...document.querySelectorAll('.sf-about-line')].map(x => x.textContent.trim().slice(0, 14)),
        cards: document.querySelectorAll('.sf-about-cell').length,
        scroll: pane ? { content: pane.scrollHeight, view: pane.clientHeight } : null,
      };
    })()`);
    console.log("ABOUT", JSON.stringify({ opened, clicked, ...info }));
    // LYNN_SHOT_SCROLL=bottom：滚到页尾，单看"已知边界 / 第三方与许可"
    if (process.env.LYNN_SHOT_SCROLL === "bottom") {
      const moved = await win.webContents.executeJavaScript(
        `(() => { const p = document.querySelector('.sf-pane'); if (!p) return null; p.scrollTop = p.scrollHeight; return { top: p.scrollTop, max: p.scrollHeight - p.clientHeight }; })()`,
      );
      console.log("ABOUT_SCROLL", JSON.stringify(moved));
      await new Promise((r) => setTimeout(r, 400));
    }
  },
};
