// 走查模式：rosterrun
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "rosterrun",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.mcard[data-state="running"]');
      const ping = card?.querySelector('.mcard-ping');
      const prog = card?.querySelector('.mcard-prog');
      const bar = prog?.querySelector('i');
      return {
        running: !!card,
        name: card?.querySelector('.mcard-name')?.textContent.trim() ?? null,
        pingAnim: ping ? getComputedStyle(ping).animationName : null,
        pingDur: ping ? getComputedStyle(ping).animationDuration : null,
        progW: prog ? getComputedStyle(prog).width : null,
        barW: bar ? getComputedStyle(bar).width : null,
        indet: prog ? prog.className.includes('indet') : null,
        idleHasProg: !!document.querySelector('.mcard[data-state="running"] ~ .mcard .mcard-prog'),
      };
    })()`);
    console.log("ROSTERRUN", JSON.stringify(info));
    // 顺手把那张运行中的成员卡放大存一份：动效在 1600 宽的全图里看不清
    const rect = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.mcard[data-state="running"]');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 };
    })()`);
    if (rect) {
      win.showInactive();
      await new Promise((r) => setTimeout(r, 300));
      const shot = await win.webContents.capturePage(rect);
      const big = shot.resize({ width: rect.width * 2 });
      const cropPath = path.join(path.dirname(out), path.basename(out, path.extname(out)) + "-crop.png");
      fs.writeFileSync(cropPath, big.toPNG());
      console.log("SHOT_CROP", cropPath, big.getSize());
    }
  },
};
