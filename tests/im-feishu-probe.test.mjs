/**
 * 飞书身份探测（P17-1）。
 *
 * 这个模块解决的是**真实卡点**：用户配好机器人后不知道自己的 open_id，
 * 而 `open_id` 是**按应用隔离**的——同一个人在不同应用下不同。
 * vendored 渠道拒收时只打一句没有 id 的警告，用户无从下手。
 *
 * 测试用 stub fetch，不需要真网络也不需要真凭据。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { probeFeishuIdentities } = await import("../dist/main/im-feishu-probe.js");

const BOT = "ou_00000000000000000000000000000001";
const USER = "ou_7d8a6e6df7621556ce0d21922b676706";

/** 用假 fetch 顶掉全局 fetch，跑完恢复 */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    text: async () => JSON.stringify(handler(String(url))),
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("私聊里唯一的非机器人成员 → 直接指出「这就是你」", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/im/v1/chats?")) {
        return { code: 0, data: { items: [{ chat_id: "oc_1", chat_mode: "p2p" }] } };
      }
      if (url.includes("/members")) {
        return {
          code: 0,
          data: {
            items: [
              { member_id: BOT, name: "风铃" },
              { member_id: USER, name: "我" },
            ],
          },
        };
      }
      return { code: 0 };
    },
    async () => {
      const r = await probeFeishuIdentities("t", { botOpenId: BOT });
      assert.equal(r.candidates.length, 2, "两个成员都要列出来");
      const mine = r.candidates.filter((c) => !c.maybeBot);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].openId, USER);
      assert.equal(mine[0].source, "私聊");
      assert.ok(
        r.notes.some((n) => n.includes(USER) && n.includes("你的账号")),
        `应当直接给出结论：${r.notes.join(" | ")}`,
      );
    },
  );
});

test("缺 im:chat:readonly → 说明要开哪个权限并要重新发布", async () => {
  await withFetch(
    () => ({ code: 99991672, msg: "no permission" }),
    async () => {
      const r = await probeFeishuIdentities("t");
      assert.equal(r.candidates.length, 0);
      assert.ok(
        r.notes.some((n) => n.includes("im:chat:readonly")),
        `要说清开哪个权限：${r.notes.join(" | ")}`,
      );
      assert.ok(
        r.notes.some((n) => n.includes("重新发布")),
        "开关权限后必须重新发布版本才生效——这句不写用户会以为开了就行",
      );
    },
  );
});

test("机器人没进任何会话 → 告诉用户先发一条消息", async () => {
  await withFetch(
    () => ({ code: 0, data: { items: [] } }),
    async () => {
      const r = await probeFeishuIdentities("t");
      assert.equal(r.candidates.length, 0);
      assert.ok(
        r.notes.some((n) => n.includes("发一条消息")),
        `要给出下一步动作：${r.notes.join(" | ")}`,
      );
    },
  );
});

test("群聊成员被列出，且标注来源群名", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/im/v1/chats?")) {
        return { code: 0, data: { items: [{ chat_id: "oc_g", chat_mode: "group", name: "项目组" }] } };
      }
      return { code: 0, data: { items: [{ member_id: USER }] } };
    },
    async () => {
      const r = await probeFeishuIdentities("t", { botOpenId: BOT });
      assert.equal(r.candidates.length, 1);
      assert.equal(r.candidates[0].source, "群「项目组」");
    },
  );
});

test("同一个 id 出现在多个会话时去重", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/im/v1/chats?")) {
        return {
          code: 0,
          data: {
            items: [
              { chat_id: "oc_1", chat_mode: "p2p" },
              { chat_id: "oc_g", chat_mode: "group", name: "组" },
            ],
          },
        };
      }
      return { code: 0, data: { items: [{ member_id: USER }] } };
    },
    async () => {
      const r = await probeFeishuIdentities("t");
      assert.equal(r.candidates.length, 1, `重复 id 只该出现一次：${r.candidates.map((c) => c.openId).join(",")}`);
    },
  );
});

test("成员接口报错 → 记进 notes，不中断其它会话", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/im/v1/chats?")) {
        return { code: 0, data: { items: [{ chat_id: "oc_1", chat_mode: "p2p" }] } };
      }
      return { code: 40003, msg: "bad" };
    },
    async () => {
      const r = await probeFeishuIdentities("t");
      assert.equal(r.candidates.length, 0);
      assert.ok(r.notes.some((n) => n.includes("读不到成员")), `要报出具体失败：${r.notes.join(" | ")}`);
    },
  );
});