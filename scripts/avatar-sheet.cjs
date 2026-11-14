// 头像画风对比图（走查用）：把 DiceBear 的候选画风用同一批种子画出来，方便挑一款。
// 只读不改配置；真正切换画风是 renderer/desk/MemberAvatar.tsx 里那一行 import。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createAvatar } = require("@dicebear/core");
const C = require("@dicebear/collection");

// 与 shared/avatars.ts 的 a01–a12 同源种子：换画风不动种子，老档案不会突然换人
const SEEDS = [
  { n: "顾明", s: "顾明-01" },
  { n: "林晚", s: "林晚-02" },
  { n: "阿黎", s: "阿黎-03" },
  { n: "阿计", s: "阿计-04" },
  { n: "阿元", s: "阿元-05" },
  { n: "周禾", s: "周禾-07" },
];

const PEOPLE = [
  "notionists",
  "lorelei",
  "adventurer",
  "avataaars",
  "openPeeps",
  "micah",
  "miniavs",
  "personas",
  "bigSmile",
  "bigEars",
  "croodles",
  "dylan",
  "toonHead",
  "notionistsNeutral",
  "loreleiNeutral",
  "adventurerNeutral",
  "avataaarsNeutral",
  "bigEarsNeutral",
  "croodlesNeutral",
];

const ODD = [
  "bottts",
  "botttsNeutral",
  "funEmoji",
  "pixelArt",
  "pixelArtNeutral",
  "thumbs",
  "shapes",
  "rings",
  "glass",
  "identicon",
  "initials",
  "icons",
];

const PAPER = ["f5f4ed", "f0eee6", "eef0e9", "f3ece0"];
const NOTE = {
  notionists: "（现在用的这款）",
  notionistsNeutral: "同款线稿，五官更淡",
  lorelei: "细线手绘，最像手画的",
  micah: "扁平彩色，气质最稳",
  openPeeps: "线稿半身，留白多",
  bottts: "机器人（最不像人）",
};

function uri(style, seed, size) {
  try {
    return createAvatar(C[style], {
      seed,
      size,
      radius: 10,
      backgroundColor: PAPER,
      backgroundType: ["solid"],
    }).toDataUri();
  } catch {
    return "";
  }
}

function row(style, size) {
  const cells = SEEDS.map(
    (x) =>
      `<div class="c"><img src="${uri(style, x.s, size)}" width="${size}" height="${size}" alt=""/><b>${x.n}</b></div>`,
  ).join("");
  return `<section><h2>${style}<span>${NOTE[style] ?? ""}</span></h2><div class="row">${cells}</div></section>`;
}

function page(title, sub, styles, size) {
  return `<!doctype html><meta charset="utf-8"/><style>
  *{box-sizing:border-box}
  body{margin:0;padding:22px 26px 26px;background:#fbfaf6;color:#22201c;
       font-family:"Microsoft YaHei",system-ui,sans-serif}
  h1{font-size:17px;margin:0 0 4px;font-weight:600}
  p.sub{margin:0 0 16px;font-size:11.5px;color:#7d766a}
  section{margin:0 0 12px;padding:11px 14px 9px;background:#fff;border-radius:9px}
  h2{font-size:12.5px;margin:0 0 8px;font-weight:600;color:#4a4438}
  h2 span{font-weight:400;color:#a09786;margin-left:8px;font-size:11px}
  .row{display:flex;gap:14px;flex-wrap:wrap}
  .c{display:flex;flex-direction:column;align-items:center;gap:4px}
  .c img{border-radius:9px;display:block}
  .c b{font-size:10.5px;font-weight:400;color:#7d766a}
  </style><h1>${title}</h1><p class="sub">${sub}</p>
  ${styles.map((s) => row(s, size)).join("")}`;
}

const chunk = (arr, n) => arr.reduce((out, x, i) => (i % n ? out[out.length - 1].push(x) : out.push([x]), out), []);

app.disableHardwareAcceleration();
const OUT = path.join(__dirname, "..", "shots");
const SIZE = 78;

const jobs = [
  ...chunk(PEOPLE, 7).map((group, i) => ({
    file: `avatar-styles-p${i + 1}.png`,
    title: `头像画风 · 人物向 ${i + 1}/${chunk(PEOPLE, 7).length}`,
    sub: "同一批种子（顾明-01 … 周禾-07），暖纸底。当前用的是 notionists。",
    styles: group,
  })),
  ...chunk(ODD, 6).map((group, i) => ({
    file: `avatar-styles-o${i + 1}.png`,
    title: `头像画风 · 风格化 ${i + 1}/${chunk(ODD, 6).length}`,
    sub: "偏符号 / 机械感的画风：放工作群里更像工具，不太像人。",
    styles: group,
  })),
];

// 先把 HTML 全写出来，再逐个开窗截图（上一版边写边截，第二个窗口偶发 ERR_FAILED）
for (const j of jobs) {
  j.html = path.join(OUT, `.${j.file}.html`);
  fs.writeFileSync(j.html, page(j.title, j.sub, j.styles, SIZE), "utf-8");
}

// 一次进程只开一个窗：连续 destroy/create 离屏窗口在 Windows 上偶发直接退出
const only = process.argv[2];
const runJobs = only === undefined ? jobs : [jobs[Number(only)]].filter(Boolean);

app.whenReady().then(async () => {
  for (const j of runJobs) {
    try {
      const win = new BrowserWindow({ width: 820, height: 900, show: false, webPreferences: { offscreen: true } });
      await win.loadFile(j.html);
      await new Promise((r) => setTimeout(r, 400));
      const h = await win.webContents.executeJavaScript("document.documentElement.scrollHeight");
      win.setContentSize(820, Math.ceil(h));
      await new Promise((r) => setTimeout(r, 350));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, j.file), img.toPNG());
      console.log("AVATAR_SHEET", j.file, JSON.stringify(img.getSize()));
      win.destroy();
    } catch (err) {
      console.log("AVATAR_SHEET_FAIL", j.file, String(err));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const j of runJobs) {
    try {
      fs.unlinkSync(j.html);
    } catch {
      /* 已经清掉 */
    }
  }
  app.quit();
});
