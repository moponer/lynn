// 走查模式：avatars
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "avatars",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.includes('团队')); if (b) b.click(); })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.team-av-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "AVATARS",
      ok,
      "options:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-av-opt').length`),
    );
    // 12 格 40px 太小看不清画风差别：把整个相册放大 2 倍存一份
    const rect = await win.webContents.executeJavaScript(`(() => {
      const p = document.querySelector('.team-av-pick');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: Math.floor(r.x) - 10, y: Math.floor(r.y) - 10, width: Math.ceil(r.width) + 20, height: Math.ceil(r.height) + 20 };
    })()`);
    if (rect) {
      win.showInactive();
      await new Promise((r) => setTimeout(r, 300));
      const shot = await win.webContents.capturePage(rect);
      const big = shot.resize({ width: rect.width * 2 });
      const cropPath = path.join(path.dirname(out), path.basename(out, path.extname(out)) + "-crop.png");
      fs.writeFileSync(cropPath, big.toPNG());
      console.log("AVATARS_CROP", cropPath, big.getSize());
    }
  },
};
