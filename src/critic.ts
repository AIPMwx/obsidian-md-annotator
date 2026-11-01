// CriticMarkup 批注的解析与生成。
// 只支持两种形式：
//   {==原文==}{>>意见<<}   针对某段文字的批注，原文可以跨多个段落
//   {>>意见<<}             全文批注
// 意见始终是单行的。

export interface Annotation {
	/** 整个批注（含标记）的起止偏移 */
	from: number;
	to: number;
	/** 被批注原文的起止偏移；全文批注时 textFrom === textTo */
	textFrom: number;
	textTo: number;
	/** 意见文字的起止偏移 */
	commentFrom: number;
	commentTo: number;
	text: string;
	comment: string;
	global: boolean;
}

// 原文部分不允许再出现 {==，避免一个没闭合的开始标记吞掉后面的内容
const PATTERN = /\{==((?:(?!\{==)[\s\S])*?)==\}\{>>([^\n]*?)<<\}|\{>>([^\n]*?)<<\}/g;

export function parseAnnotations(doc: string): Annotation[] {
	const result: Annotation[] = [];
	PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PATTERN.exec(doc)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (m[1] !== undefined) {
			const textFrom = from + 3;
			const textTo = textFrom + m[1].length;
			const commentFrom = textTo + 6;
			result.push({
				from, to, textFrom, textTo, commentFrom,
				commentTo: commentFrom + m[2].length,
				text: m[1], comment: m[2], global: false,
			});
		} else {
			const commentFrom = from + 3;
			result.push({
				from, to, textFrom: from, textTo: from, commentFrom,
				commentTo: commentFrom + m[3].length,
				text: "", comment: m[3], global: true,
			});
		}
	}
	return result;
}

const MARKERS = ["{==", "==}", "{>>", "<<}"];

/** 选区跨行时，这些行不能被包进批注：表格、公式块、嵌入、HTML */
const UNSAFE_LINE = /^\s*(\||\$\$|!\[\[|<)/;

/** 检查选中的文字能否被批注，不能则返回原因 */
export function validateSelection(doc: string, from: number, to: number): string | null {
	const text = doc.slice(from, to);
	if (!text.trim()) return "请先选中要批注的文字";
	if (MARKERS.some((m) => text.includes(m))) return "选中的内容包含批注标记";
	const overlap = parseAnnotations(doc).some((a) => from < a.to && to > a.from);
	if (overlap) return "选中的内容与已有批注重叠";
	if (text.includes("\n")) {
		const first = lineIndex(doc, from);
		const last = lineIndex(doc, to);
		const lines = doc.split("\n");
		const skip = nonProseLines(doc);
		for (let i = first; i <= last; i++) {
			if (skip[i]) return "选区包含代码块或属性区，不能跨这些内容批注";
			if (UNSAFE_LINE.test(lines[i])) return "选区包含表格、公式块或嵌入内容，不能跨这些内容批注";
		}
	}
	return null;
}

function lineIndex(doc: string, offset: number): number {
	let n = 0;
	for (let i = doc.indexOf("\n"); i !== -1 && i < offset; i = doc.indexOf("\n", i + 1)) n++;
	return n;
}

/**
 * 整理选区：去掉两端空白；起点落在列表符号、标题井号等前缀里时挪到正文开头，
 * 终点落在下一行前缀里时退回上一行末尾，保证标记不会把 Markdown 结构拆坏。
 */
export function prepareRange(doc: string, from: number, to: number): { from: number; to: number } {
	const trim = () => {
		while (from < to && /\s/.test(doc[from])) from++;
		while (to > from && /\s/.test(doc[to - 1])) to--;
	};
	trim();
	const startLine = doc.lastIndexOf("\n", from - 1) + 1;
	const startRange = blockContentRange(doc.slice(startLine, lineEnd(doc, startLine)));
	if (startRange && from < startLine + startRange.start) from = startLine + startRange.start;

	const endLine = doc.lastIndexOf("\n", to - 1) + 1;
	const endRange = blockContentRange(doc.slice(endLine, lineEnd(doc, endLine)));
	if (endLine > startLine && endRange && to <= endLine + endRange.start) to = endLine - 1;
	trim();
	return { from, to };
}

function lineEnd(doc: string, lineStart: number): number {
	const i = doc.indexOf("\n", lineStart);
	return i === -1 ? doc.length : i;
}

/** 意见只能是单行，且不能包含结束标记 */
export function sanitizeComment(comment: string): string {
	return comment.replace(/\s*\n\s*/g, " ").replace(/<<\}/g, "<< }").trim();
}

/** 写入文件时在意见前加上前缀（如“批注：”），已带前缀则不重复添加 */
export function withPrefix(comment: string, prefix: string): string {
	return !prefix || comment.startsWith(prefix) ? comment : prefix + comment;
}

/** 显示时去掉前缀，界面上只看到意见本身 */
export function stripPrefix(comment: string, prefix: string): string {
	return prefix && comment.startsWith(prefix) ? comment.slice(prefix.length) : comment;
}

export function wrapText(text: string, comment: string): string {
	return `{==${text}==}{>>${comment}<<}`;
}

export function globalComment(comment: string): string {
	return `{>>${comment}<<}`;
}

/** 全文批注插入位置：文档开头，若有 frontmatter 则放在其后 */
export function globalInsertOffset(doc: string): number {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(doc);
	return m ? m[0].length : 0;
}

/** 去掉批注标记、保留原文；全文批注独占一行时连同后面的空行一起删掉 */
export function removalChange(doc: string, a: Annotation): { from: number; to: number; insert: string } {
	let to = a.to;
	if (a.global && (a.from === 0 || doc[a.from - 1] === "\n")) {
		for (let i = 0; i < 2 && doc[to] === "\n"; i++) to++;
	}
	return { from: a.from, to, insert: a.text };
}

/**
 * 区块（一行）中可被批注的正文范围：去掉列表、标题、引用等前缀。
 * 不适合批注的行（空行、代码围栏、表格、分隔线、嵌入等）返回 null。
 */
export function blockContentRange(line: string): { start: number; end: number } | null {
	if (!line.trim()) return null;
	if (/^\s*(```|~~~|\$\$|\||<|!\[\[|>\s*\[!)/.test(line)) return null;
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return null;
	const prefix = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?|\s*(?:>\s*)+|#{1,6}\s+)/.exec(line);
	let start = prefix ? prefix[0].length : 0;
	let end = line.length;
	while (start < end && /\s/.test(line[start])) start++;
	while (end > start && /\s/.test(line[end - 1])) end--;
	return end > start ? { start, end } : null;
}

/** 每一行是否处于代码块（围栏）或 frontmatter 中 */
export function nonProseLines(doc: string): boolean[] {
	const lines = doc.split("\n");
	const flags: boolean[] = new Array(lines.length).fill(false);
	let i = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
		if (end > 0) for (; i <= end; i++) flags[i] = true;
	}
	let fence: string | null = null;
	for (; i < lines.length; i++) {
		const m = /^\s*(```|~~~)/.exec(lines[i]);
		if (fence) {
			flags[i] = true;
			if (m && m[1] === fence) fence = null;
		} else if (m) {
			flags[i] = true;
			fence = m[1];
		}
	}
	return flags;
}
