// 走查模式：reporttable（2026-11-15）
// 成员把自检结果写成 Markdown 表格时：表头是否被压成竖排、单词是否被切两半、
// 「展开全文」是否真的解除限高、双击正文能否展开/收起。
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用。
module.exports = {
  mode: "reporttable",
  async run({ win, fs, path, writeJson, out }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 回报在"你最近一次说话"之前时会被折进历史行
    await win.webContents.executeJavaScript(
      `(() => { const h = document.querySelector('.feed-history'); if (h) h.click(); return !!h; })()`,
    );
    await wait(400);

    // 只认对话流正文里的那张卡（报告预览块里也可能有表，别测错对象）
    const findBodyJs = `(() => {
      const wraps = [...document.querySelectorAll('.md-table-wrap')];
      const w = wraps.find((x) => x.closest('.feed-body')) || null;
      return w ? w.closest('.feed-body') : null;
    })()`;

    const probe = `(() => {
      const wraps = [...document.querySelectorAll('.md-table-wrap')];
      const inFeed = wraps.filter((w) => w.closest('.feed-body'));
      const wrap = inFeed[0] || null;
      if (!wrap) return { table: false, wraps: wraps.length, wrapsInFeed: inFeed.length };
      const fold = wrap.closest('.feed-fold');
      const body = wrap.closest('.feed-body');
      const tbl = wrap.querySelector('table');
      const ths = [...wrap.querySelectorAll('th')];
      const firstRow = [...wrap.querySelectorAll('tbody tr')][0];
      const firstCells = firstRow ? [...firstRow.children] : [];
      const bcs = body ? getComputedStyle(body) : null;
      const lineOf = (el) => parseFloat(getComputedStyle(el).lineHeight) || 1;
      // 行数要扣掉上下 padding：直接拿 clientHeight 会把它算成半行，报"表头折行"的假警
      const lines = (el) => {
        const cs = getComputedStyle(el);
        const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        return Math.max(1, Math.round(inner / lineOf(el)));
      };
      return {
        table: true,
        wraps: wraps.length,
        wrapsInFeed: inFeed.length,
        fold: !!fold,
        long: fold ? fold.classList.contains('long') : null,
        open: fold ? fold.classList.contains('open') : null,
        hint: document.querySelector('.feed-fold-hint')?.textContent?.trim() ?? null,
        moreLabel: document.querySelector('.feed-fold-bar .feed-more')?.textContent?.trim() ?? null,
        bodyH: body ? Math.round(body.clientHeight) : null,
        bodyScrollH: body ? body.scrollHeight : null,
        bodyMaxH: bcs ? bcs.maxHeight : null,
        bodyOverflow: bcs ? bcs.overflow : null,
        bodyFont: bcs ? bcs.fontFamily.split(',')[0] : null,
        bodyFontSize: bcs ? bcs.fontSize : null,
        tableW: tbl ? Math.round(tbl.getBoundingClientRect().width) : null,
        tableScrollW: Math.round(wrap.scrollWidth),
        tableClientW: Math.round(wrap.clientWidth),
        headerLines: ths.map((th) => lines(th)),
        headerWidths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
        cellLines: firstCells.map((td) => lines(td)),
        cellWidths: firstCells.map((td) => Math.round(td.getBoundingClientRect().width)),
        cellWrap: firstCells[0] ? getComputedStyle(firstCells[0]).overflowWrap : null,
        cellFontSize: firstCells[0] ? getComputedStyle(firstCells[0]).fontSize : null,
      };
    })()`;

    const collapsed = await win.webContents.executeJavaScript(probe);

    // 收起态也留一张（看渐隐与开关行对不对）
    win.showInactive();
    await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      body?.closest('.feed-item')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await wait(450);
    const foldRect = await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      const card = body ? body.closest('.feed-item') : null;
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: Math.floor(r.x) - 6, y: Math.max(0, Math.floor(r.y) - 6), width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 };
    })()`);
    if (foldRect && foldRect.height > 0) {
      const shot = await win.webContents.capturePage(foldRect);
      const foldOut = path.join(path.dirname(out), path.basename(out, path.extname(out)) + "-fold.png");
      fs.writeFileSync(foldOut, shot.resize({ width: Math.min(1600, foldRect.width * 2) }).toPNG());
      console.log("SHOT_FOLD", foldOut);
    }

    // 双击正文（不是按钮）应展开全文
    const dbl = await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      if (!body) return false;
      const r = body.getBoundingClientRect();
      body.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + 20),
      }));
      return true;
    })()`);
    await wait(350);
    const expanded = await win.webContents.executeJavaScript(probe);

    // 先滚到这张卡，等贴底跟随停下，再量矩形——否则量到的是滚动前的位置（裁出别的卡）
    await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      body?.closest('.feed-item')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await wait(500);
    // 隐藏窗口下 capturePage(rect) 常拿到旧帧：走查截图前先显形并重绘一次（rosterrun 同法）
    win.showInactive();
    await wait(400);
    win.webContents.invalidate();
    await wait(250);
    const rect = await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      const card = body ? body.closest('.feed-item') : null;
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: Math.floor(r.x) - 6, y: Math.max(0, Math.floor(r.y) - 6), width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 };
    })()`);
    if (rect && rect.height > 0) {
      const shot = await win.webContents.capturePage(rect);
      const crop = path.join(path.dirname(out), path.basename(out, path.extname(out)) + "-crop.png");
      fs.writeFileSync(crop, shot.resize({ width: Math.min(1600, rect.width * 2) }).toPNG());
      console.log("SHOT_CROP", crop);
    }

    // 再双击一次应收起（用户要的是"双击区域就能开关"，不用找按钮）
    await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      if (!body) return false;
      const r = body.getBoundingClientRect();
      body.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.x + 40), clientY: r.y + 20,
      }));
      return true;
    })()`);
    await wait(300);
    const recollapsed = await win.webContents.executeJavaScript(probe);

    // 留给最后那张整窗截图：展开态才是这次要给人看的样子
    await win.webContents.executeJavaScript(`(() => {
      const body = ${findBodyJs};
      const r = body.getBoundingClientRect();
      body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: Math.round(r.x + 40), clientY: r.y + 20 }));
      body.closest('.feed-item')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await wait(350);
    const reopened = await win.webContents.executeJavaScript(probe);

    const result = { doubleClicked: dbl, collapsed, expanded, recollapsed, reopened };
    writeJson("REPORTTABLE", result);
    console.log("REPORTTABLE", JSON.stringify(result));
  },
};
