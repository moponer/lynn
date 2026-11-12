// 独立进程跑 mock 模型：让被测内核的 CPU/内存不被 mock HTTP 服务污染。
const { startMock } = require("./mock-model.cjs");

(async () => {
  const opts = JSON.parse(process.argv[2] || "{}");
  const m = await startMock(opts);
  console.log(JSON.stringify({ baseUrl: m.baseUrl, port: m.port }));
  const bye = () => m.close().then(() => process.exit(0));
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
})();
