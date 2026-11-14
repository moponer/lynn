// 走查模式：feedfold
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "feedfold",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    // 频道默认只展开"你最近一次说话"之后的往来，更早的收在折叠行里：
    // 先点开历史，才看得到那张长回报卡
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/上回合|历史|收起|展开/.test(x.textContent||'')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const info = await win.webContents.executeJavaScript(`(() => {
      const more = [...document.querySelectorAll('.feed-more')];
      return {
        fold: more.length,
        labels: more.map(b => b.textContent.trim()),
        items: document.querySelectorAll('.feed-item').length,
        bodies: document.querySelectorAll('.feed-body').length,
        hasReport: document.body.textContent.includes('19 条隐患'),
      };
    })()`);
    console.log("FEEDFOLD", JSON.stringify(info));
  },
};
