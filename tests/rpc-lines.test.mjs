import { test } from "node:test";
import assert from "node:assert/strict";
import { drainUtf8Lines } from "../dist/main/rpc-lines.js";

test("drainUtf8Lines：一次多行 + 残留不完整行", () => {
  const r = drainUtf8Lines(Buffer.alloc(0), Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.rest.toString("utf8"), '{"c":');
});

test("drainUtf8Lines：跨 chunk 的 UTF-8 多字节字符不被截断", () => {
  const whole = Buffer.from('{"text":"中文测试"}\n', "utf8");
  // 在「中」的字节中间切开
  const cut = whole.indexOf(Buffer.from("中", "utf8")) + 1;
  const first = drainUtf8Lines(Buffer.alloc(0), whole.subarray(0, cut));
  assert.deepEqual(first.lines, []);
  const second = drainUtf8Lines(first.rest, whole.subarray(cut));
  assert.deepEqual(second.lines, ['{"text":"中文测试"}']);
  assert.equal(second.rest.length, 0);
});

test("drainUtf8Lines：CRLF 与空行", () => {
  const r = drainUtf8Lines(Buffer.alloc(0), Buffer.from('{"a":1}\r\n\r\n{"b":2}\r\n'));
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
});
