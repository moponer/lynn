// 走查模式：outcards
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "outcards",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.cs-out')];
      return {
        count: cards.length,
        names: cards.map(c => (c.querySelector('.cs-oname')?.textContent || '').trim()),
        metas: cards.map(c => (c.querySelector('.cs-ometa')?.textContent || '').trim()),
        thumbKind: cards.map(c => (c.className.match(/k-(\\w+)/) || [])[1]),
        hasImg: document.querySelectorAll('.cs-thumb-img').length,
        hasTxt: document.querySelectorAll('.cs-thumb-txt').length,
        hasExt: document.querySelectorAll('.cs-thumb-ext').length,
        noise: cards.filter(c => /未核|qnj|成员回报|成员自述/.test(c.textContent)).length,
      };
    })()`);
    console.log("OUTCARDS", info);
    // LYNN_PREVIEW_PLAIN=1：只截干净网格（不点开预览）
    if (process.env.LYNN_PREVIEW_PLAIN !== "1") {
      // 先点一张 docx：应真渲染成白纸 HTML（docx-read），而不是退回"没有内置预览"
      const doc = await win.webContents.executeJavaScript(
        `(() => { const c=document.querySelector('.cs-out.k-doc'); if (c) c.click(); return !!c; })()`,
      );
      await new Promise((r) => setTimeout(r, 700));
      const pvDoc = await win.webContents.executeJavaScript(`(() => {
        const d = document.querySelector('.pv-drawer');
        return d ? {
          name: (d.querySelector('.pv-name strong')?.textContent || '').trim(),
          hint: (d.querySelector('.pv-hint')?.textContent || '').trim().slice(0, 60),
          act: (d.querySelector('.pv-hint-act')?.textContent || '').trim(),
          docFrame: !!d.querySelector('iframe.pv-doc'),
        } : null;
      })()`);
      console.log("OUTCARD_DOC", doc, pvDoc);
      // 关抽屉走关闭按钮（合成 Esc 不可靠：遮罩层的 mousedown 会先吃掉下一次点击）
      await win.webContents.executeJavaScript(
        `(() => { const b=[...document.querySelectorAll('.pv-acts .ghost-btn')].pop(); if (b) b.click(); return !!b; })()`,
      );
      await new Promise((r) => setTimeout(r, 400));
      // 再点第一张（文本类）：应直接开内置预览（而不是跳到"这张单的战果"）
      await win.webContents.executeJavaScript(
        `(() => { const c=document.querySelector('.cs-out'); if (c) c.click(); return !!c; })()`,
      );
      await new Promise((r) => setTimeout(r, 900));
      const pv = await win.webContents.executeJavaScript(`(() => {
        const d = document.querySelector('.pv-drawer');
        return {
          drawer: !!d,
          name: d ? (d.querySelector('.pv-name strong')?.textContent || '').trim() : null,
          kind: d ? (d.querySelector('.pv-body')?.firstElementChild?.className || '') : null,
          hint: d ? (d.querySelector('.pv-hint')?.textContent || '').trim().slice(0, 40) : null,
        };
      })()`);
      console.log("OUTCARD_PREVIEW", pv);
    }
  },
};
