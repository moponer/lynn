// 回复守门（2026-11-11）：不管模型有没有听话，这两类话都不能让它问出口。
//
// 实机事故：用户说「出个漏洞管理 Word」，主代理回「你要什么格式？放哪？叫什么名字？
// 或者把内容发你自己存」——它确实没有执行工具，但成员有，正确动作是派单。
// 提示词已经写了规则，这里再做一层代码闸：ask_user / report_to_user 命中就拒发并纠正。

const ASK_OUTPUT_DETAILS =
  /(?:放哪|放在哪|哪个盘|叫什么名字|什么格式|发我|发给你|你自己保存|你自己存|复制粘贴(?:给你|发我)|你指定.{0,8}路径)/;

/** 是否在向用户索要**产出侧**细节（路径 / 文件名 / 格式 / 让用户自己保存）。 */
export function isAskingUserForOutputDetails(text: string): boolean {
  return ASK_OUTPUT_DETAILS.test(String(text ?? ""));
}

const DONE_CLAIM = /(?:已(?:处理)?完毕|已完成|已交付|全部完成|搞定了)/;

/** 是否在对用户宣称「已经完成」——要和「这张单有没有交付物」交叉校验。 */
export function claimsDone(text: string): boolean {
  return DONE_CLAIM.test(String(text ?? ""));
}

/**
 * 没有交付物时的纠正指引（2026-11-11 实机）：
 * 成员两次跑完未交付，主代理直接 stop_task 关单，然后对用户说「已处理完毕」。
 * 这是把失败包装成完成，比失败本身更糟。
 */
export const NO_DELIVERABLE_HINT =
  "这张单没有任何交付物，不能说「已完成 / 已处理完毕 / 已交付」。请如实告诉用户：这件事没做出来、" +
  "卡在哪（例如成员两次跑完但没有交付物）、你下一步打算怎么办（换人重做 / 换方式 / 需要用户决定）。" +
  "不要用「如果你还需要就再告诉我」收尾——那等于把活推回用户。要么现在就重做，要么说清为什么做不了。";

/** 拒绝时回给模型的纠正指引：不要停在这里，继续派单。 */
export const REPLY_GUARD_HINT =
  "不要问用户产出文件放哪、叫什么名字、什么格式，也不要让用户自己保存：文件名、格式、工作区路径自己定" +
  "（Word 就叫「主题.docx」放工作区），直接 assign_task 派成员，tools 里带 office_write_docx。" +
  "你确实没有执行工具，但成员有（write_file / run_command / office_write_docx）。现在按这个规则继续，不要停下来等用户。";
