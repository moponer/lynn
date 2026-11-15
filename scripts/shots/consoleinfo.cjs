// 走查模式：consoleinfo —— 控制台与值台的信息面对齐（2026-11-15）
// 校验：本群隔离后的读数、项目身份、卡住/别群计数、流水是否回填了权威 feed、
//       产出柜是否含归档单的交付物、处置抽屉里验收凭证与契约读数是否在。
// 需要 LYNN_PREVIEW_CONSOLE=1（假桥里 stage.console 插件才启用）。
module.exports = {
  mode: "consoleinfo",
  async run({ win }) {
    const head = await win.webContents.executeJavaScript(`(() => {
      const txt = (sel) => (document.querySelector(sel)?.textContent || "").replace(/\\s+/g, " ").trim();
      return {
        readouts: [...document.querySelectorAll('.cs-readout')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
        project: txt('.cs-proj'),
        live: txt('.cs-live'),
        alert: txt('.cs-alert'),
        projTitle: document.querySelector('.cs-proj')?.getAttribute('title') ?? null,
        stream: [...document.querySelectorAll('.cs-stream .cs-line-tx')].map((e) => e.textContent.trim()).filter(Boolean),
        streamLeft: [...document.querySelectorAll('.cs-flow.left .cs-fl-text')].map((e) => e.textContent.trim()),
        streamRight: [...document.querySelectorAll('.cs-flow.right .cs-fl-text')].map((e) => e.textContent.trim()),
        outputs: [...document.querySelectorAll('.cs-out .cs-oname')].map((e) => e.textContent.trim()),
        outputAll: [...document.querySelectorAll('.cs-panel-h .cs-linkbtn')].map((e) => e.textContent.trim()),
        tasks: [...document.querySelectorAll('.cs-task')].map((e) => ({
          note: e.querySelector('.cs-t-note')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
          foot: e.querySelector('.cs-t-foot')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
          id: e.getAttribute('data-task'),
        })),
      };
    })()`);

    // 产出柜「全部 N 件」：柜面只铺 6 件，抽屉必须真的列出全部（与柜面同一口径）
    await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('.cs-panel-h .cs-linkbtn')].find((x) => x.textContent.includes('全部'));
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const allOutputs = await win.webContents.executeJavaScript(`(() => ({
      title: (document.querySelector('.cs-drawer-h h2')?.textContent || '').trim(),
      cap: (document.querySelector('.cs-drawer-h .cs-cap')?.textContent || '').trim(),
      rows: [...document.querySelectorAll('.cs-drawer .cs-ev-n')].map((e) => e.textContent.trim()),
      cells: [...document.querySelectorAll('.cs-drawer .cs-cell')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
    }))()`);
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.cs-x');
      if (b) b.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));

    // 打开处置抽屉：验收凭证 / 契约读数只在这里
    await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('.cs-alert-acts button')][0];
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 500));

    const drawer = await win.webContents.executeJavaScript(`(() => {
      const txt = (sel) => (document.querySelector(sel)?.textContent || "").replace(/\\s+/g, " ").trim();
      return {
        title: txt('.cs-drawer-h h2'),
        proofs: [...document.querySelectorAll('.cs-dj-proof')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
        files: [...document.querySelectorAll('.cs-dj-files')].map((e) => e.textContent.trim()),
        decidMeta: [...document.querySelectorAll('.cs-dec-meta')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
        decidQ: [...document.querySelectorAll('.cs-dec-q')].map((e) => e.textContent.trim()).slice(0, 3),
        acts: [...document.querySelectorAll('.cs-dj-acts .cs-act, .cs-dec-acts .cs-act')].map((e) => e.textContent.trim()),
      };
    })()`);

    console.log("CONSOLEINFO", JSON.stringify({ head, allOutputs, drawer }, null, 2));
  },
};
