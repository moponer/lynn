// M3-08 渲染层 i18n：字典由 App 从主进程拉取（内置 ⊕ 语言包插件），经 context 下发。
//  t(key) 缺 key 回退 key 本身——但内置 zh 是源语言全覆盖，正常路径不会裸露 key。
import { createContext, useContext, type ReactNode } from "react";
import { translate } from "../shared/i18n";

const I18nContext = createContext<Record<string, string>>({});

export function I18nProvider({ strings, children }: { strings: Record<string, string>; children: ReactNode }) {
  return <I18nContext.Provider value={strings}>{children}</I18nContext.Provider>;
}

export type TFn = (key: string, params?: Record<string, string | number>) => string;

export function useT(): TFn {
  const strings = useContext(I18nContext);
  return (key, params) => translate(strings, key, params) ?? key;
}
