/**
 * 飞书身份探测（2026-11-18 P17-1）。
 *
 * ## 解决什么问题
 *
 * 用户配好机器人后，**不知道自己的 open_id**。日志里只有一句
 * `ignored a message from a sender outside the legacy allowlist`——
 * 没有 id，没法照做。
 *
 * 而 open_id 有个容易踩的坑：**它是按应用隔离的**。
 * 同一个人在 A 应用下的 open_id 与 B 应用下的**不同**。
 * 所以"从别处抄一个 open_id"必然失败。
 *
 * ## 怎么查（只用官方 API）
 *
 * ```
 * GET /open-apis/im/v1/chats                          → 机器人所在的会话列表
 * GET /open-apis/im/v1/chats/{chat_id}/members        → 每个会话的成员
 * ```
 *
 * 私聊会话的成员必然是「机器人 + 某个人」，那个非机器人的成员就是用户。
 * 群聊则列出所有人——用户从里面认自己。
 *
 * 需要的权限：`im:chat:readonly`（读会话信息）。缺了会返回权限错误，
 * 我们把错误码原样报出来，用户知道去后台开哪个权限。
 *
 * ## 为什么不改 vendor 去日志里打 sender id
 *
 * 那条日志在 vendored `bridge.mjs` 里，改它违反"vendor 一行不改"的约定。
 * 而且就算能改，也只能在**被拒之后**才知道 id——用户还是得先被拒一次。
 * 用 API 主动查是"配之前就能查到"，体验更好。
 */

const FEISHU_API = "https://open.feishu.cn/open-apis";

/** 一个候选身份 */
export interface IdentityCandidate {
  openId: string;
  /** 从哪里发现的（私聊 / 某群名） */
  source: string;
  /** 是否可能就是机器人自己（要排除） */
  maybeBot?: boolean;
}

interface ChatsResponse {
  code?: number;
  msg?: string;
  data?: {
    items?: {
      chat_id?: string;
      name?: string;
      chat_mode?: string;
      chat_type?: string;
      owner_id?: string;
      member_count?: number;
    }[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface MembersResponse {
  code?: number;
  msg?: string;
  data?: {
    items?: { member_id?: string; name?: string; member_id_type?: string }[];
  };
}

/** 发一个 GET（带 token） */
async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${FEISHU_API}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { code: -1, msg: text.slice(0, 120) } as T;
  }
}

/**
 * 列出候选 open_id。
 *
 * 返回的 `notes` 是给人看的诊断（权限没开、机器人没进任何会话等），
 * 直接展示在设置页的自检结果里。
 */
export async function probeFeishuIdentities(
  token: string,
  opts: { botOpenId?: string } = {},
): Promise<{ candidates: IdentityCandidate[]; notes: string[] }> {
  const notes: string[] = [];
  const candidates: IdentityCandidate[] = [];

  // 1) 会话列表
  const chats = await apiGet<ChatsResponse>("/im/v1/chats?page_size=20", token);
  if (chats.code !== 0) {
    if (chats.code === 99991672 || chats.code === 99991679) {
      notes.push(
        "读不到会话列表：缺少「获取群信息」权限。去 open.feishu.cn → 权限管理 → 开通 im:chat:readonly，然后重新发布版本。",
      );
    } else {
      notes.push(`读不到会话列表（code=${chats.code} ${chats.msg ?? ""}）`);
    }
    return { candidates, notes };
  }

  const items = chats.data?.items ?? [];
  if (!items.length) {
    /**
     * **重要**：`GET /im/v1/chats` **只返回群聊，不返回私聊**。
     *
     * 第一版写的是"机器人还没加入任何会话，先给它发一条消息"——
     * 用户发了消息、再点自检，看到的还是同一句，非常误导。
     *
     * 实际上"只跟机器人私聊过"这个最常见的情形，这个接口**永远**查不到。
     * 所以必须如实说明限制，并指向真正管用的路。
     */
    notes.push(
      "这个接口只列群聊，私聊不在其中——所以查不到是正常的，不代表你没发消息。",
      "用「见过的发送者」看：应用收到过消息的人都会列在那里，包括被白名单拒掉的。",
      "或者跑 npm run feishu:watch -- 120 --apply，手机发一条消息就自动填进白名单。",
    );
    return { candidates, notes };
  }

  // 2) 每个会话的成员
  for (const chat of items) {
    if (!chat.chat_id) continue;
    const label = chat.chat_mode === "p2p" ? "私聊" : `群「${chat.name || chat.chat_id}」`;
    const members = await apiGet<MembersResponse>(
      `/im/v1/chats/${encodeURIComponent(chat.chat_id)}/members?member_id_type=open_id&page_size=50`,
      token,
    );
    if (members.code !== 0) {
      notes.push(`${label}：读不到成员（code=${members.code} ${members.msg ?? ""}）`);
      continue;
    }
    for (const m of members.data?.items ?? []) {
      const id = String(m.member_id ?? "");
      if (!id.startsWith("ou_")) continue;
      const isBot = opts.botOpenId ? id === opts.botOpenId : false;
      /**
       * 私聊里排除机器人自己后，**剩下的那个就是用户**——这是最可靠的来源。
       * 群聊里不排除任何人，只标注"可能是机器人"，由用户在界面上判断。
       */
      candidates.push({
        openId: id,
        source: label,
        ...(isBot ? { maybeBot: true } : {}),
      });
    }
  }

  // 3) 去重（同一个人可能在多个会话里）
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.openId)) return false;
    seen.add(c.openId);
    // 标记为机器人的，若同一个 id 在私聊里出现过，以非机器人记录优先
    return true;
  });

  /**
   * 只有 1 个候选且来自私聊 → 直接告诉用户「这就是你」。
   * 这是最常见的情形（用户只跟机器人私聊过）。
   */
  /**
   * 私聊里**排除机器人**后再看剩下几个。
   *
   * 第一版忘了排除，于是私聊里"机器人 + 你"算 2 个候选，结论永远不出来。
   * 测试抓到的正是这个。
   */
  const p2pOnly = unique.filter((c) => c.source === "私聊" && !c.maybeBot);
  if (p2pOnly.length === 1) {
    notes.push(`私聊里唯一的非机器人成员就是你的账号，直接用这个：${p2pOnly[0].openId}`);
  } else if (unique.length > 1) {
    notes.push(`找到 ${unique.length} 个候选。私聊里的是你；群聊里的需要你自己辨认。`);
  }

  return { candidates: unique, notes };
}