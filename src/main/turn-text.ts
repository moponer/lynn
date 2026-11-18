/**
 * 回合文本合成（2026-11-17 缓存修复 B1）。
 *
 * 事故：`submitTurn` 把**原话**写进 history，而实际发送的是「技能正文 + 原话 + 群定向」。
 * 下一轮从 history 重建请求时，那条 user 消息凭空变短 → 从它开始的前缀缓存全部失效。
 * 技能命中率实测 35%，等于每三次对话就人为断一次，成员命中率被压到 81.5%。
 *
 * 修法：**发送什么就存什么**——在写 history 之前一次算好，之后不再二次装饰。
 * 顺序与原来一致（技能在前、定向在后），只是提前到落盘之前。
 */

export interface ComposeTurnInput {
  /** 用户原话（已含附件说明） */
  fullText: string;
  /** 群内定向说明（@ 某人时才有） */
  directive?: string;
  /** 本轮命中的技能正文（可空） */
  skillText?: string;
}

export function composeTurnText(input: ComposeTurnInput): string {
  const body = input.directive ? `${input.fullText}\n\n${input.directive}` : input.fullText;
  const skill = (input.skillText ?? "").trim();
  return skill ? `${skill}\n\n${body}` : body;
}
