// 评测专用 Electron 入口：把 userData 指到临时目录后再加载真实主进程。
// 这样 localStorage / safeStorage / 单实例锁都不碰用户日常实例。
const { app } = require("electron");
const path = require("node:path");

if (process.env.LYNN_EVAL_USER_DATA) {
  app.setPath("userData", process.env.LYNN_EVAL_USER_DATA);
}
// 实验：单进程 / 关闭网络服务进程，只用于评测内存下限，不代表产品默认配置
if (process.env.LYNN_EVAL_SINGLE_PROCESS === "1") {
  app.commandLine.appendSwitch("single-process");
}
if (process.env.LYNN_EVAL_NO_NETWORK_SERVICE === "1") {
  app.commandLine.appendSwitch("disable-features", "NetworkService,NetworkServiceInProcess");
}
require(path.join(__dirname, "..", "..", "dist", "main", "main.js"));
