import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("小写", () => assert.equal(slugify("Hello"), "hello"));
test("空格转连字符", () => assert.equal(slugify("Hello World"), "hello-world"));
test("去掉非字母数字", () => assert.equal(slugify("Hello, World!"), "hello-world"));
