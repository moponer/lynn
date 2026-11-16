// 凭据打码统一（2026-11-16）：endpoint 与 memory 曾是两份规则，覆盖形态不同。
// 这里锁住合并后的行为，顺带锁住"计数类键不被误伤"。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../dist/shared/redact.js";
import { redactSecrets as endpointRedact } from "../dist/main/endpoint.js";
import { MemoryStore } from "../dist/main/memory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-redact-"));

test("带前缀的令牌全部打码：Bearer / Basic / PEM / sk- / ghp_ / xox / AKIA", () => {
  const raw = [
    "Authorization: Bearer abcdef1234567890",
    "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l",
    "sk-abcd1234efgh5678",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
    "xoxb-1234567890-abcdef",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA1234",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(raw);
  const secrets = [
    "abcdef1234567890",
    "YWxhZGRpbjpvcGVuc2VzYW1l",
    "abcd1234efgh5678",
    "ABCDEFGHIJKLMNOPQRSTUVWX",
    "1234567890-abcdef",
    "IOSFODNN7EXAMPLE",
    "MIIEowIBAAKCAQEA1234",
  ];
  for (const secret of secrets) assert.ok(!out.includes(secret), `${secret} 应被打码`);
  assert.match(out, /Bearer \*\*\*/);
  assert.match(out, /sk-\*\*\*/);
  assert.match(out, /ghp_\*\*\*/);
  assert.match(out, /AKIA\*\*\*/);
});

test("计数类键不误伤：max_tokens / total_tokens / prompt_tokens 保持原值", () => {
  const body = '{"max_tokens": 100000, "total_tokens": 654321, "prompt_tokens": 12345, "usage": {"completion_tokens": 777}}';
  const out = redactSecrets(body);
  for (const value of ["100000", "654321", "12345", "777"]) {
    assert.ok(out.includes(value), `${value} 不该被打码：${out}`);
  }
});

test("键值形态：token/secret/password/api_key 打码且保留键名", () => {
  const out = redactSecrets("token=supersecretvalue password:anothersecret api_key=abcd1234efgh client_secret=zzzz1111yyyy");
  assert.match(out, /token=\*\*\*/);
  assert.match(out, /password=\*\*\*/);
  assert.match(out, /api_key=\*\*\*/);
  assert.match(out, /client_secret=\*\*\*/);
  assert.doesNotMatch(out, /supersecretvalue|anothersecret|abcd1234efgh|zzzz1111yyyy/);
});

test("endpoint 与 memory 用在同一份规则上（ghp_ 不再从记忆里漏过去）", () => {
  assert.equal(endpointRedact, redactSecrets, "endpoint 只是转出同一实现");
  const store = new MemoryStore(tmp());
  store.learnProject("p1", "CI 用 ghp_ABCDEFGHIJKLMNOPQRSTUVWX 拉代码，max_tokens=8192");
  const text = store.loadProject("p1");
  assert.ok(!text.includes("ABCDEFGHIJKLMNOPQRSTUVWX"), "项目记忆不能留明文");
  assert.match(text, /ghp_\*\*\*/);
  assert.match(text, /max_tokens=8192/, "计数键原样保留");
});
