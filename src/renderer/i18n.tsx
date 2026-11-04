// M3-08 渲染层 i18n：字典由 App 从主进程拉取（内置 ⊕ 语言包插件），经 context 下发。
//  渲染层**内置中文源语言**做兜底：主进程字典可能比界面旧（只重建了 renderer、或应用没重启），
//  缺 key 时绝不能把 `menu.open` 这种内部键名露给用户；英文缺词条也按设计回退中文。
import { createContext, useContext, type ReactNode } from "react";
import { mergeStrings, translate } from "../shared/i18n";
import { ZH_STRINGS } from "../shared/i18n-strings";

const I18nContext = createContext<Record<string, string>>({});

export function I18nProvider({ strings, children }: { strings: Record<string, string>; children: ReactNode }) {
  // 顺序：内置中文 → 主进程字典（en 时是英文覆盖；zh 时同源）。绝不把 undefined 传下去
  const dict = mergeStrings(ZH_STRINGS, strings ?? {});
  return <I18nContext.Provider value={dict}>{children}</I18nContext.Provider>;
}

export type TFn = (key: string, params?: Record<string, string | number>) => string;

export function useT(): TFn {
  const strings = useContext(I18nContext);
  return (key, params) => translate(strings ?? {}, key, params) ?? key;
}
