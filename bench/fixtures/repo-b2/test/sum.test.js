import test from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

test("空数组返回 0", () => {
  assert.equal(sum([]), 0);
});

test("普通数组求和", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
