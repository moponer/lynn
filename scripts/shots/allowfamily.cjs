// 走查模式：allowfamily —— 审批卡：读卡片文案与三个按钮（含「这类以后都允许」）
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 里给 win（BrowserWindow）。
module.exports = {
  mode: "allowfamily",
  async run({ win }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector(".sealcard");
      if (!card) return { found: false };
      return { found: true, text: card.textContent.replace(/\\s+/g, " ").trim().slice(0, 140), btns: [...card.querySelectorAll("button")].map((b) => b.textContent.trim()) };
    })()`);
    console.log("ALLOWFAM", JSON.stringify(info));
  },
};
