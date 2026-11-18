// 走查模式：versions —— 设置 → 人设 → 版本历史（2026-11-16 收紧成一行一版）
// 读每行的时间 / 字符差 / 总字符 / 最近标 / 回滚按钮宽度与行高，
// 再 2 倍放大截「版本」这一组，用来判断一行能不能读、有没有把按钮挤掉。
module.exports = {
  mode: "versions",
  async run({ win, fs, out }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>(x.textContent||'').includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await wait(900);
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>(x.textContent||'').trim()==='人设'); if (b) b.click(); return !!b; })()`,
    );
    await wait(900);

    const info = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.ver-row')];
      return {
        count: rows.length,
        rows: rows.map((r) => ({
          when: r.querySelector('.ver-when')?.textContent.trim() ?? null,
          delta: r.querySelector('.ver-delta')?.textContent.trim() ?? null,
          chars: r.querySelector('.ver-chars')?.textContent.trim() ?? null,
          latest: r.querySelector('.ver-tag')?.textContent.trim() ?? null,
          act: r.querySelector('.ver-act')?.textContent.trim() ?? null,
          h: Math.round(r.getBoundingClientRect().height),
          actOverflow: (() => {
            const a = r.querySelector('.ver-act');
            if (!a) return null;
            return Math.round(a.getBoundingClientRect().right - r.getBoundingClientRect().right);
          })(),
        })),
        // 旧版的两行大字：确认已不存在
        legacySub: document.querySelectorAll('.sf-row-sub').length,
      };
    })()`);
    console.log("VERSIONS", JSON.stringify({ opened, navOk, info }, null, 1));

    const rect = await win.webContents.executeJavaScript(`(() => {
      const g = [...document.querySelectorAll('.sf-group')].find((x) => {
        const b = x.querySelector('.sf-group-head b');
        return b && b.textContent.includes('版本');
      });
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.min(Math.round(r.height), 480) };
    })()`);
    if (rect && rect.width > 40) {
      win.showInactive();
      await new Promise((r) => setTimeout(r, 300));
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 250));
      const img = await win.webContents.capturePage(rect);
      fs.writeFileSync(String(out).replace(/\.png$/, "-crop.png"), img.resize({ width: rect.width * 2 }).toPNG());
    }
  },
};
