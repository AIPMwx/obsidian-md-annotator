import { App, Scope } from "obsidian";

// 意见里的简单 Markdown。
// 批注格式要求意见在一行内，所以写入文件时把换行存成 <br>，编辑时再还原成换行。
// 卡片上用一个同步的小渲染器显示：无序 / 有序列表、加粗、斜体、行内代码。
// 同步渲染是为了排版卡片时能立刻量到高度。

const BR = /<br\s*\/?>/gi;

/** 输入框里的多行文字 → 存进文件的单行意见 */
export function encodeComment(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.replace(/\n/g, "<br>");
}

/** 文件里的单行意见 → 输入框里的多行文字 */
export function decodeComment(comment: string): string {
	return comment.replace(BR, "\n");
}

/** 去掉格式符号的纯文字，用于悬停提示 */
export function plainComment(comment: string): string {
	return decodeComment(comment)
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1");
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\*(?!\s)([^*]+?)\*/g;

function renderInline(parent: HTMLElement, text: string) {
	// 加粗里会递归调用自己，所以每次用新的正则对象，不能共用 lastIndex
	const re = new RegExp(INLINE.source, "g");
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		parent.appendText(text.slice(last, m.index));
		if (m[1] !== undefined) renderInline(parent.createEl("strong"), m[1]);
		else if (m[2] !== undefined) parent.createEl("code", { text: m[2] });
		else parent.createEl("em", { text: m[3] });
		last = m.index + m[0].length;
	}
	parent.appendText(text.slice(last));
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

/** 把意见渲染进卡片：连续的列表行合成一个列表，其余每行一段 */
export function renderComment(el: HTMLElement, comment: string) {
	el.empty();
	let list: HTMLElement | null = null;
	let listType = "";
	for (const line of decodeComment(comment).split("\n")) {
		const bullet = BULLET.exec(line);
		const numbered = NUMBERED.exec(line);
		if (bullet || numbered) {
			const type: "ul" | "ol" = bullet ? "ul" : "ol";
			if (!list || listType !== type) {
				list = el.createEl(type);
				listType = type;
				if (numbered && numbered[1] !== "1") list.setAttr("start", numbered[1]);
			}
			renderInline(list.createEl("li"), bullet ? bullet[1] : numbered![2]);
			continue;
		}
		list = null;
		if (line.trim()) renderInline(el.createEl("p"), line);
		else el.createDiv({ cls: "md-annot-gap" });
	}
}

export interface CommentInputOptions {
	/** 用来注册快捷键作用域；Obsidian 会在全局拦截 Cmd 组合键，普通的 keydown 监听收不到 */
	app?: App;
	onResize: () => void;
	onSave: () => void;
	onCancel: () => void;
}

/**
 * 增强意见输入框：
 *   高度随内容自适应（上限由 CSS max-height 控制，超出后滚动）；
 *   在列表行按回车自动续上列表符号，空列表项再按回车结束列表；
 *   Cmd/Ctrl+B 加粗、Cmd/Ctrl+I 斜体、Cmd/Ctrl+Enter 保存、Esc 取消。
 * 返回清理函数：输入框移除前调用，撤销快捷键作用域。
 */
export function enhanceCommentInput(input: HTMLTextAreaElement, opts: CommentInputOptions): () => void {
	const autosize = () => {
		const before = input.offsetHeight;
		input.setCssStyles({ height: "auto" });
		input.setCssStyles({ height: `${input.scrollHeight + 2}px` });
		if (input.offsetHeight !== before) opts.onResize();
	};

	const wrap = (marker: string) => {
		const { selectionStart: s, selectionEnd: e, value } = input;
		const selected = value.slice(s, e);
		input.setRangeText(`${marker}${selected}${marker}`, s, e, "end");
		if (!selected) input.setSelectionRange(s + marker.length, s + marker.length);
		autosize();
	};

	const continueList = (): boolean => {
		const { selectionStart: s, selectionEnd: e, value } = input;
		if (s !== e) return false;
		const lineStart = value.lastIndexOf("\n", s - 1) + 1;
		const line = value.slice(lineStart, s);
		const m = /^(\s*)([-*+]|(\d+)([.)]))\s+(.*)$/.exec(line);
		if (!m) return false;
		if (!m[5].trim()) {
			// 空列表项：去掉符号，结束列表
			input.setRangeText("", lineStart, s, "end");
		} else {
			const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
			input.setRangeText(`\n${m[1]}${marker} `, s, s, "end");
		}
		autosize();
		return true;
	};

	input.addEventListener("input", autosize);
	input.addEventListener("keydown", (e) => {
		// 不让按键冒泡到编辑器
		e.stopPropagation();
		if (e.isComposing) return;
		const mod = e.metaKey || e.ctrlKey;
		if (e.key === "Enter" && mod) {
			e.preventDefault();
			opts.onSave();
		} else if (e.key === "Enter" && !e.shiftKey && continueList()) {
			e.preventDefault();
		} else if (e.key === "Escape") {
			e.preventDefault();
			opts.onCancel();
		} else if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
			e.preventDefault();
			wrap("**");
		} else if (mod && !e.shiftKey && e.key.toLowerCase() === "i") {
			e.preventDefault();
			wrap("*");
		}
	});

	// 输入框有焦点时压入一个快捷键作用域，抢在 Obsidian 的全局快捷键之前处理
	let scope: Scope | null = null;
	const pop = () => {
		if (scope && opts.app) opts.app.keymap.popScope(scope);
		scope = null;
	};
	if (opts.app) {
		const app = opts.app;
		input.addEventListener("focus", () => {
			pop();
			scope = new Scope(app.scope);
			scope.register(["Mod"], "b", () => (wrap("**"), false));
			scope.register(["Mod"], "i", () => (wrap("*"), false));
			scope.register(["Mod"], "Enter", () => (opts.onSave(), false));
			app.keymap.pushScope(scope);
		});
		input.addEventListener("blur", pop);
	}

	window.setTimeout(autosize);
	return pop;
}
