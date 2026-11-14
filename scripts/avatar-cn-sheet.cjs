// 「更适合国人」的头像方案对比（走查用）：
// A. DiceBear 现有画风 · 默认 vs 约束成黑发+暖肤色
// B. 「姓氏首字」字头像（国内产品默认做法，36px 下最认得出人）
// 只生成对比图，不改任何配置。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createAvatar } = require("@dicebear/core");
const C = require("@dicebear/collection");

// 与 shared/avatars.ts 同源种子
const SEEDS = [
  { n: "顾明", s: "顾明-01" },
  { n: "阿黎", s: "阿黎-03" },
  { n: "阿元", s: "阿元-05" },
];

const STYLES = ["lorelei", "micah", "personas", "miniavs", "toonHead", "bigSmile"];

// 东亚向约束：黑发（纯黑/深棕）+ 暖中性肤色
const CN = {
  hairColor: ["0a0a0a", "1b1b1b", "2c1b18"],
  skinColor: ["f2d6c2", "ecc9ad", "e0ac8c"],
};

const PAPER = ["f5f4ed", "f0eee6", "eef0e9", "f3ece0"];

function uri(style, seed, size, opts) {
  try {
    return createAvatar(C[style], {
      seed,
      size,
      radius: 10,
      backgroundColor: PAPER,
      backgroundType: ["solid"],
      ...(opts || {}),
    }).toDataUri();
  } catch {
    return "";
  }
}

const strip = (style, size, opts) =>
  SEEDS.map(
    (x) =>
      `<div class="c"><img src="${uri(style, x.s, size, opts)}" width="${size}" height="${size}" alt=""/><b>${x.n}</b></div>`,
  ).join("");

function styleBlock(style, size) {
  return `<section><h2>${style}<span>上＝默认　下＝黑发+暖肤色</span></h2>
    <div class="row">${strip(style, size, null)}</div>
    <div class="row cn">${strip(style, size, CN)}</div></section>`;
}

// B 方案：姓氏首字头像（不依赖任何插画库）
const CHARS = [
  { z: "顾", c: "#6fa892" },
  { z: "林", c: "#c9a227" },
  { z: "黎", c: "#c8443a" },
  { z: "计", c: "#5c9b83" },
  { z: "元", c: "#d08a4e" },
  { z: "禾", c: "#9a8f7a" },
];

function charRow(kind, size) {
  return CHARS.map((x) => {
    if (kind === "paper") {
      return `<div class="c"><div class="zig paper" style="--c:${x.c};width:${size}px;height:${size}px">${x.z}</div><b>纸底墨字</b></div>`;
    }
    if (kind === "wash") {
      return `<div class="c"><div class="zig wash" style="--c:${x.c};width:${size}px;height:${size}px">${x.z}</div><b>岗位色淡底</b></div>`;
    }
    return `<div class="c"><div class="zig solid" style="--c:${x.c};width:${size}px;height:${size}px">${x.z}</div><b>实底反白</b></div>`;
  }).join("");
}

function charBlock(size) {
  return `<section><h2>姓氏首字<span>不依赖插画库 · 每人一字 · 36px 也能认出</span></h2>
    <div class="row">${charRow("paper", size)}</div>
    <div class="row">${charRow("wash", size)}</div>
    <div class="row">${charRow("solid", size)}</div>
    <div class="row small">${CHARS.map(
      (x) => `<div class="c"><div class="zig wash" style="--c:${x.c};width:28px;height:28px;font-size:15px">${x.z}</div><b>28px</b></div>`,
    ).join("")}</div></section>`;
}

const SIZE = 74;

function page(title, sub, body) {
  return `<!doctype html><meta charset="utf-8"/><style>
  *{box-sizing:border-box}
  body{margin:0;padding:22px 26px 26px;background:#fbfaf6;color:#22201c;
       font-family:"Microsoft YaHei",system-ui,sans-serif}
  h1{font-size:17px;margin:0 0 4px;font-weight:600}
  p.sub{margin:0 0 16px;font-size:11.5px;color:#7d766a}
  section{margin:0 0 12px;padding:11px 14px 9px;background:#fff;border-radius:9px}
  h2{font-size:12.5px;margin:0 0 8px;font-weight:600;color:#4a4438}
  h2 span{font-weight:400;color:#a09786;margin-left:8px;font-size:11px}
  .row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  .row.cn{padding-top:6px;border-top:1px dashed #eee6d8}
  .c{display:flex;flex-direction:column;align-items:center;gap:4px}
  .c img{border-radius:9px;display:block}
  .c b{font-size:10.5px;font-weight:400;color:#7d766a}
  .zig{display:grid;place-items:center;border-radius:9px;
        font-family:"Songti SC",SimSun,"Noto Serif CJK SC",serif;
        font-size:34px;font-weight:500;letter-spacing:0}
  .zig.paper{background:#f5f4ed;color:#3a352c}
  .zig.wash{background:color-mix(in srgb, var(--c) 26%, #f7f5ee);color:#2f2a22}
  .zig.solid{background:var(--c);color:#fbfaf6}
  </style><h1>${title}</h1><p class="sub">${sub}</p>${body}`;
}

app.disableHardwareAcceleration();
const OUT = path.join(__dirname, "..", "shots");

const chunkStyles = (arr, n) =>
  arr.reduce((out, x, i) => (i % n ? out[out.length - 1].push(x) : out.push([x]), out), []);
const jobs = [
  ...chunkStyles(STYLES, 3).map((group, i, all) => ({
    file: `avatar-cn-a${i + 1}.png`,
    title: `更适合国人 · A${i + 1}/${all.length}：现有画风加约束`,
    sub: "同一批种子。上排是 DiceBear 默认（偏欧美），下排强制黑发 + 暖肤色。",
    body: group.map((s) => styleBlock(s, SIZE)).join(""),
  })),
  {
    file: "avatar-cn-b.png",
    title: "更适合国人 · B：姓氏首字头像",
    sub: "不依赖插画库：一个字 + 岗位色。飞书/钉钉/企微的默认头像就是这一类，小尺寸认人最准。",
    body: charBlock(74),
  },
];

const only = process.argv[2];
const runJobs = only === undefined ? jobs : [jobs[Number(only)]].filter(Boolean);

for (const j of runJobs) {
  j.html = path.join(OUT, `.${j.file}.html`);
  fs.writeFileSync(j.html, page(j.title, j.sub, j.body), "utf-8");
}

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
      console.log("AVATAR_CN", j.file, JSON.stringify(img.getSize()));
      win.destroy();
    } catch (err) {
      console.log("AVATAR_CN_FAIL", j.file, String(err));
    }
    try {
      fs.unlinkSync(j.html);
    } catch {
      /* 已清 */
    }
  }
  app.quit();
});
