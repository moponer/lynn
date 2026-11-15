// 走查模式：fileicons
// 交付箱彩色类型图标（2026-11-15）+ 音频内置播放（点开会议录音那一行）。
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "fileicons",
  async run({ win }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')].find(x=>(x.textContent||'').includes('交付箱')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const rows = await win.webContents.executeJavaScript(`(() => ({
      rows: [...document.querySelectorAll('.out-row')].map(r => ({
        name: r.querySelector('b')?.textContent.trim(),
        kind: r.querySelector('.fic')?.dataset.kind ?? null,
        color: r.querySelector('.fic rect')?.getAttribute('fill') ?? null,
        size: (() => { const n = r.querySelector('.fic'); const b = n?.getBoundingClientRect(); return b ? [Math.round(b.width), Math.round(b.height)] : null; })(),
      })),
    }))()`);
    console.log("FILEICONS", JSON.stringify(rows));

    // 点开会录音：验证后端 kind=audio → 原生播放器出现在抽屉里
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.out-row')].find(r => (r.querySelector('b')?.textContent || '').includes('会议录音'));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    const audio = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.pv-audio');
      return {
        clicked: ${clicked ? "true" : "false"},
        hasAudio: !!el,
        srcPrefix: el?.getAttribute('src')?.slice(0, 22) ?? null,
        controls: el?.hasAttribute('controls') ?? false,
        meta: document.querySelector('.pv-media-meta')?.textContent.trim() ?? null,
        hint: document.querySelector('.pv-media .pv-hint')?.textContent.trim() ?? null,
        body: (document.querySelector('.pv-body')?.textContent || '').trim().slice(0, 120),
        headIcon: document.querySelector('.pv-name .fic')?.dataset.kind ?? null,
      };
    })()`);
    console.log("AUDIOPREVIEW", JSON.stringify(audio));

    // 真播一下：能出声才算"播放能力"，控件在但播不动等于没做
    const played = await win.webContents.executeJavaScript(`(async () => {
      const el = document.querySelector('.pv-audio');
      if (!el) return { played: false };
      try { await el.play(); } catch (e) { return { played: false, error: String(e) }; }
      await new Promise((r) => setTimeout(r, 450));
      const out = { played: true, currentTime: Math.round(el.currentTime * 100) / 100, duration: Math.round((el.duration || 0) * 100) / 100, paused: el.paused };
      el.pause();
      return out;
    })()`);
    console.log("AUDIOPLAY", JSON.stringify(played));
  },
};
