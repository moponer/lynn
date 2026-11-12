// 评测用 OpenAI 兼容 mock 模型：可控延迟、失败、重试、缓存字段。
const http = require("node:http");

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * @param {object} opts
 * @param {"ok"|"fail500"|"retry429"|"slow"} [opts.mode]
 * @param {number} [opts.failTimes]  retry429 模式：前 N 次返回 429
 * @param {number} [opts.chunkDelayMs]
 * @param {number} [opts.chunks]
 * @param {object} [opts.usage]
 */
async function startMock(opts = {}) {
  const mode = opts.mode ?? "ok";
  const failTimes = opts.failTimes ?? 1;
  const chunkDelay = opts.chunkDelayMs ?? 0;
  const chunks = opts.chunks ?? 3;
  const usage = opts.usage ?? {
    prompt_tokens: 1200,
    completion_tokens: 24,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300,
  };
  let requests = 0;
  let currentMode = mode;
  let currentReply = opts.reply ?? "收到。";
  let limited = 0;
  const seen = [];

  const server = http.createServer((req, res) => {
    if (req.url === "/__control") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          if (p.mode) {
            currentMode = p.mode;
            limited = 0;
          }
          if (p.reply) currentReply = p.reply;
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: currentMode, requests }));
      });
      return;
    }
    if (!req.url || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      requests += 1;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      seen.push({ at: Date.now(), messages: parsed.messages?.length ?? 0, tools: parsed.tools?.length ?? 0 });

      if (currentMode === "fail500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock upstream exploded" } }));
        return;
      }
      if (currentMode === "retry429" && limited < failTimes) {
        limited += 1;
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sse(res, { choices: [{ delta: { role: "assistant" } }] });
      const text = currentReply;
      for (let i = 0; i < chunks; i += 1) {
        if (chunkDelay > 0) await new Promise((r) => setTimeout(r, chunkDelay));
        const start = Math.floor((text.length * i) / chunks);
        const end = Math.floor((text.length * (i + 1)) / chunks);
        sse(res, { choices: [{ delta: { content: text.slice(start, end) } }] });
      }
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sse(res, { choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests: () => requests,
    seen: () => seen.slice(),
    setMode: (m) => {
      currentMode = m;
      limited = 0;
    },
    setReply: (t) => {
      currentReply = t;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { startMock };
