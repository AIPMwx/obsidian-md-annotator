// 阅读模式下的渲染，按设置项 display.readingStyle 输出不同样式：
//   margin    原文高亮，意见交给右侧卡片栏（reading-margin.ts）显示
//   inline    原文高亮 + 行内图标，悬停显示意见
//   highlight 只高亮原文，悬停显示意见
//   hidden    去掉批注，只显示正文
// 意见里可能有加粗、换行（<br>）等格式，渲染后会被拆成多个节点，所以按源码处理：
// 先用 getSectionInfo 拿到这个段落对应的源码和其中的批注，再在渲染结果的纯文字里
// 依次找到每条批注的标记位置，跨节点删除标记、包裹原文。意见内容取自源码。
// 跨段批注的开始、结束标记分别落在不同的渲染段落里，整段加批注样式即可。

import { MarkdownPostProcessor, MarkdownPostProcessorContext, setIcon, setTooltip } from "obsidian";
import { Annotation, parseAnnotations, stripPrefix } from "./critic";
import { display } from "./display";
import { plainComment } from "./markdown";

const shown = (comment: string) => stripPrefix(comment, display.prefix);
const tooltip = (comment: string) => plainComment(shown(comment));

function commentIcon(comment: string): HTMLElement {
	const el = createSpan({ cls: "md-annot-icon md-annot-inline-icon" });
	setIcon(el, "message-square");
	setTooltip(el, tooltip(comment));
	return el;
}

/** 给包裹原文的 <mark> 加上批注样式；hidden 样式下还原成普通文字 */
function decorateMark(mark: HTMLElement, comment: string) {
	const style = display.readingStyle;
	if (style === "hidden") {
		mark.replaceWith(...Array.from(mark.childNodes));
		return;
	}
	mark.addClass("md-annot-hl");
	mark.dataset.annotComment = shown(comment);
	mark.dataset.annotQuote = mark.textContent ?? "";
	if (style === "inline") {
		mark.after(commentIcon(comment));
	} else if (style === "highlight") {
		setTooltip(mark, tooltip(comment));
	}
}

function globalBadge(comment: string): HTMLElement | null {
	const style = display.readingStyle;
	if (style === "hidden") return null;
	const el = createSpan({ cls: "md-annot-global" });
	setIcon(el.createSpan({ cls: "md-annot-icon" }), "message-square");
	el.createSpan({ cls: "md-annot-global-label", text: "全文批注" });
	if (style === "margin") {
		el.dataset.annotComment = shown(comment);
		el.dataset.annotGlobal = "true";
	} else {
		el.createSpan({ cls: "md-annot-global-text", text: tooltip(comment) });
	}
	return el;
}

// ---------- 渲染结果的纯文字索引 ----------

interface TextIndex {
	nodes: Text[];
	starts: number[];
	text: string;
}

function indexText(root: HTMLElement): TextIndex {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const starts: number[] = [];
	let text = "";
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (node.parentElement?.closest("code, pre")) continue;
		nodes.push(node);
		starts.push(text.length);
		text += node.data;
	}
	return { nodes, starts, text };
}

function locate(idx: TextIndex, offset: number, preferEnd: boolean): [Text, number] {
	for (let i = 0; i < idx.nodes.length; i++) {
		const start = idx.starts[i];
		const end = start + idx.nodes[i].data.length;
		if (offset < end || (preferEnd && offset === end)) return [idx.nodes[i], offset - start];
	}
	const last = idx.nodes[idx.nodes.length - 1];
	return [last, last.data.length];
}

function rangeOf(idx: TextIndex, from: number, to: number): Range {
	const range = document.createRange();
	range.setStart(...locate(idx, from, false));
	range.setEnd(...locate(idx, to, true));
	return range;
}

/** 删除纯文字 [from, to) 对应的节点内容（可跨节点），返回删除位置的 Range */
function deleteText(root: HTMLElement, from: number, to: number): Range | null {
	const idx = indexText(root);
	if (!idx.nodes.length || from >= to) return null;
	const range = rangeOf(idx, from, to);
	range.deleteContents();
	return range;
}

/** 把纯文字 [from, to) 对应的内容包进一个新元素 */
function wrapText(root: HTMLElement, from: number, to: number, wrapper: HTMLElement) {
	const idx = indexText(root);
	if (!idx.nodes.length || from >= to) return;
	const range = rangeOf(idx, from, to);
	wrapper.append(range.extractContents());
	range.insertNode(wrapper);
}

// ---------- 按源码处理批注 ----------

const lineOf = (doc: string, offset: number) => doc.slice(0, offset).split("\n").length - 1;

/** 单段内的批注：{==原文==}{>>意见<<}、全文批注 {>>意见<<} */
function processInline(el: HTMLElement, a: Annotation) {
	const text = indexText(el).text;
	const open = text.indexOf("{>>");
	if (open === -1) return;
	const close = text.indexOf("<<}", open);
	if (close === -1) return;
	const end = close + 3;

	if (a.isGlobal) {
		const range = deleteText(el, open, end);
		const badge = globalBadge(a.comment);
		if (range && badge) range.insertNode(badge);
		return;
	}

	// 原文要么是纯文字 {==原文==}，要么被 Obsidian 渲染成 {<mark>原文</mark>}
	let start: number;
	let markerLen: number;
	let quoteEnd: number;
	if (text.slice(open - 3, open) === "==}") {
		start = text.lastIndexOf("{==", open - 3);
		markerLen = 3;
		quoteEnd = open - 3;
	} else if (text[open - 1] === "}") {
		start = text.lastIndexOf("{", open - 2);
		markerLen = 1;
		quoteEnd = open - 1;
	} else {
		return;
	}
	if (start === -1) return;

	deleteText(el, quoteEnd, end);
	deleteText(el, start, start + markerLen);
	const quoteTo = quoteEnd - markerLen;

	// Obsidian 已经渲染出的 <mark> 恰好就是原文时，直接复用，避免嵌套
	const idx = indexText(el);
	const existing = locate(idx, start, false)[0].parentElement?.closest("mark");
	if (existing && el.contains(existing) && existing.textContent === idx.text.slice(start, quoteTo)) {
		decorateMark(existing, a.comment);
		return;
	}
	const mark = createEl("mark");
	wrapText(el, start, quoteTo, mark);
	decorateMark(mark, a.comment);
}

/** 跨段批注：给范围内的每个渲染段落加上批注样式，并去掉开始 / 结束标记 */
function processBlock(el: HTMLElement, a: Annotation, startsHere: boolean, endsHere: boolean) {
	if (startsHere) {
		const text = indexText(el).text;
		const i = text.indexOf("{==");
		if (i !== -1) deleteText(el, i, i + 3);
	}
	if (endsHere) {
		const text = indexText(el).text;
		const i = text.indexOf("==}{>>");
		const close = i === -1 ? -1 : text.indexOf("<<}", i);
		if (close !== -1) deleteText(el, i, close + 3);
	}

	const style = display.readingStyle;
	if (style === "hidden") return;
	el.addClass("md-annot-block-hl");
	if (style === "highlight") setTooltip(el, tooltip(a.comment));
	// 卡片对齐到范围内的第一个段落
	if (startsHere) {
		el.dataset.annotComment = shown(a.comment);
		el.dataset.annotQuote = a.text.split("\n")[0];
	}
	if (style === "inline" && endsHere) {
		const target = el.querySelector("p:last-of-type, li:last-of-type") ?? el;
		target.appendChild(commentIcon(a.comment));
	}
}

function processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): boolean {
	const info = ctx.getSectionInfo(el);
	if (!info) return false;
	for (const a of parseAnnotations(info.text)) {
		const startLine = lineOf(info.text, a.from);
		const endLine = lineOf(info.text, a.to);
		if (endLine < info.lineStart || startLine > info.lineEnd) continue;
		const startsHere = startLine >= info.lineStart;
		const endsHere = endLine <= info.lineEnd;
		if (startsHere && endsHere && !a.text.includes("\n")) processInline(el, a);
		else processBlock(el, a, startsHere, endsHere);
	}
	return true;
}

// ---------- 拿不到源码时的兜底（如悬停预览、嵌入）：只处理不带格式的批注 ----------

const TEXT_PATTERN = /\{==(.+?)==\}\{>>(.*?)<<\}|\{>>(.*?)<<\}/g;

function processFallback(root: HTMLElement) {
	root.querySelectorAll("mark").forEach((mark) => {
		const prev = mark.previousSibling;
		const next = mark.nextSibling;
		if (!(prev instanceof Text) || !(next instanceof Text)) return;
		if (!prev.data.endsWith("{")) return;
		const m = /^\}\{>>(.*?)<<\}/.exec(next.data);
		if (!m) return;
		prev.data = prev.data.slice(0, -1);
		next.data = next.data.slice(m[0].length);
		decorateMark(mark, m[1]);
	});

	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const targets: Text[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (node.parentElement?.closest("code, pre")) continue;
		if (node.data.includes("{>>")) targets.push(node);
	}
	for (const node of targets) {
		const frag = createFragment();
		let last = 0;
		TEXT_PATTERN.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = TEXT_PATTERN.exec(node.data)) !== null) {
			frag.append(node.data.slice(last, m.index));
			if (m[1] !== undefined) {
				const mark = createEl("mark", { text: m[1] });
				frag.append(mark);
				decorateMark(mark, m[2]);
			} else {
				const badge = globalBadge(m[3]);
				if (badge) frag.append(badge);
			}
			last = m.index + m[0].length;
		}
		if (last === 0) continue;
		frag.append(node.data.slice(last));
		node.replaceWith(frag);
	}
}

export const readingProcessor: MarkdownPostProcessor = (el, ctx) => {
	if (!processSection(el, ctx)) processFallback(el);
};
