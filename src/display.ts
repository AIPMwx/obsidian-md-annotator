// 批注的显示设置，所有视图共用，由插件持久化保存。

import { StateEffect } from "@codemirror/state";

export type ReadingStyle = "margin" | "inline" | "highlight" | "hidden";

export const READING_STYLES: Record<ReadingStyle, string> = {
	margin: "右侧卡片栏（与编辑模式一致）",
	inline: "行内图标，悬停查看意见",
	highlight: "只高亮原文，悬停查看意见",
	hidden: "隐藏批注，只看正文",
};

export const display = {
	/** 阅读模式下批注的显示样式 */
	readingStyle: "margin" as ReadingStyle,
	collapsed: false,
	/** 写入文件时加在意见前的前缀，空字符串表示不加 */
	prefix: "",
	/** 由插件提供：切换显示方式并保存、通知所有编辑器 */
	setCollapsed: (_collapsed: boolean): void => {},
};

/** 显示方式变化后通知编辑器重绘批注栏 */
export const refreshMargin = StateEffect.define<null>();
