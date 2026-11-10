import type { ComponentType } from "react";
import { ConsoleDesk } from "./ConsoleDesk";
import type { ConsoleViewProps } from "./types";

/**
 * 内置控制台视图注册表（`stage.console` 卡槽的唯一出口）。
 *
 * 为什么不收插件代码：整屏主视图要读快照、订阅事件、画 Canvas，这些都在宿主进程里，
 * iframe 沙箱（U 档）拿不到。所以插件只在 manifest 里写「占这个卡槽 + 用哪个视图」，
 * 组件永远来自这张表——插件换成注册表里不存在的 view id 就渲染空，不回落也不报错。
 *
 * 新增视图 = 在下面加一行（注册表是唯一改点，卡槽与插件格式都不用动）。
 */
export const CONSOLE_VIEWS: Record<string, ComponentType<ConsoleViewProps>> = {
  console: ConsoleDesk,
};

/** 取视图组件；未知 id 返回 null（调用方渲染空，等价于没装插件） */
export function consoleViewOf(id: string | undefined): ComponentType<ConsoleViewProps> | null {
  if (!id) return null;
  return CONSOLE_VIEWS[id] ?? null;
}

/** 注册表里有哪些视图（设置面板给用户看可选值） */
export function consoleViewIds(): string[] {
  return Object.keys(CONSOLE_VIEWS);
}
