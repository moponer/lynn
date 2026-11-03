// M3-08 中英 i18n（§3.2 L283：语言包即 L0 插件，从第一天内置）。
//  设计：
//  - zh 是源语言：内置 ZH_STRINGS 覆盖全部接入 key，任何 key 缺失最终回退中文——
//    英文包可以渐进补全（缺的显示中文），不假装已翻译（如实混合）；
//  - 语言包插件 = L0 声明式产物（contributes.langs 指向 JSON 文件，无代码），
//    按 lang 匹配后覆盖内置字典——社区可以不改内核换全套文案；
//  - 占位符 {name} 纯字符串替换，无格式化依赖。
export type Lang = "zh" | "en";
export const LANGS: readonly Lang[] = ["zh", "en"];

export function isLang(v: unknown): v is Lang {
  return v === "zh" || v === "en";
}

/** 语言包文件（L0 插件携带）的结构 */
export interface LangPack {
  lang: Lang;
  strings: Record<string, string>;
}

export interface PackCheck {
  ok: boolean;
  issues: string[];
  pack?: LangPack;
}

/** 语言包 JSON 校验（结构问题全列出，不抛异常） */
export function checkLangPack(raw: unknown): PackCheck {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["语言包必须是 JSON 对象"] };
  }
  const r = raw as Record<string, unknown>;
  if (!isLang(r.lang)) issues.push('lang 必须是 "zh" 或 "en"');
  if (typeof r.strings !== "object" || r.strings === null || Array.isArray(r.strings)) {
    issues.push("strings 必须是 key→字符串 的对象");
  } else {
    for (const [k, v] of Object.entries(r.strings)) {
      if (typeof v !== "string") issues.push(`strings.${k} 必须是字符串`);
      else if (v.length > 500) issues.push(`strings.${k} 超过 500 字符上限`);
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, issues, pack: r as unknown as LangPack };
}

/** 单条翻译：{name} 占位替换；缺 key 返回 undefined（由调用方决定回退） */
export function translate(strings: Record<string, string>, key: string, params?: Record<string, string | number>): string | undefined {
  const tpl = strings[key];
  if (tpl === undefined) return undefined;
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** 合并字典：over 覆盖 base（插件语言包覆盖内置） */
export function mergeStrings(base: Record<string, string>, over: Record<string, string>): Record<string, string> {
  return { ...base, ...over };
}
