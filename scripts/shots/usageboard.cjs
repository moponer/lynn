// 走查模式：usageboard —— 右栏消耗看板（2026-11-15：一张表、一人一行）
// 读出列头、每行的名字/消耗/命中率与条形实际像素宽，把看板单独 2 倍放大截一张，
// 用来判断「层次分不分得清」（整图 1584 宽时这块只有 300px，肉眼判不了）。
module.exports = {
  mode: "usageboard",
  async run({ win, fs, path, out }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const board = document.querySelector('.usage-board');
      if (!board) return { rendered: false };
      const box = board.getBoundingClientRect();
      const px = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
      const head = [...board.querySelectorAll('.ub-head > *')].map((el) => el.textContent.trim());
      const rows = [...board.querySelectorAll('.ub-row')].map((row) => {
        const cs = getComputedStyle(row);
        const nameEl = row.querySelector('.ub-name');
        const barEl = row.querySelector('.ub-bar > i');
        return {
          name: nameEl?.textContent.trim() ?? '',
          lead: row.classList.contains('lynn'),
          leadTag: !!row.querySelector('.ub-lead-tag'),
          bg: cs.backgroundColor,
          nameColor: nameEl ? getComputedStyle(nameEl).color : null,
          nameWeight: nameEl ? getComputedStyle(nameEl).fontWeight : null,
          barColor: barEl ? getComputedStyle(barEl).backgroundColor : null,
          token: row.querySelector('.ub-val')?.textContent.trim() ?? '',
          hit: row.querySelector('.ub-hit')?.textContent.trim() ?? '',
          barPx: px(row.querySelector('.ub-bar')),
          fillPx: px(barEl),
        };
      });
      return {
        rendered: true,
        head,
        rows,
        oldModules: board.querySelectorAll('.ub-mod, .ub-sub').length,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    })()`);
    console.log("USAGEBOARD", JSON.stringify(info, null, 1));

    // 2 倍放大：看板太小，靠整图判不了名字字重、条形明度、行底色的差别
    if (info.rendered) {
      const r = info.rect;
      // 隐藏窗口下 capturePage(rect) 会拿到全黑旧帧：先显形、重绘一次（rosterrun 同法）
      win.showInactive();
      await new Promise((res) => setTimeout(res, 300));
      win.webContents.invalidate();
      await new Promise((res) => setTimeout(res, 250));
      const image = await win.webContents.capturePage({
        x: Math.round(r.x) - 8,
        y: Math.round(r.y) - 26,
        width: Math.round(r.width) + 16,
        height: Math.round(r.height) + 34,
      });
      const cropPath = out.replace(/\.png$/i, "") + "-crop.png";
      fs.writeFileSync(cropPath, image.resize({ width: Math.round(r.width) * 2 }).toPNG());
      console.log("SHOT_CROP", path.basename(cropPath));
    }
  },
};
