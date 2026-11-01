// 右侧批注栏，两种显示方式：
//   展开：每条批注一张卡片，与原文所在行对齐，重叠时依次往下排；
//   收起：每行只显示一个批注数量气泡（适合小屏幕），悬停气泡在其右侧预览该行卡片，点击气泡展开全部。
// 新建或修改批注时，直接在卡片里输入。

import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, Notice, setIcon } from "obsidian";
import { Annotation, parseAnnotations, removalChange, sanitizeComment, stripPrefix, withPrefix } from "./critic";
import { display, refreshMargin } from "./display";
import { activeAnnotation, editingField, setEditing } from "./editor";
import { stackCards, textRight } from "./layout";
import { decodeComment, encodeComment, enhanceCommentInput, renderComment } from "./markdown";

/** 卡片栏相对正文右边缘的偏移，左侧留给区块悬停按钮 */
export const MARGIN_GAP = 40;
export const CARD_SPACING = 8;
export const CARD_WIDTH = 260;
export const BADGE_WIDTH = 28;
export const MIN_PREVIEW_WIDTH = 180;

interface Item {
	a: Annotation;
	top: number;
	line: number;
}

interface Measured {
	live: boolean;
	left: number;
	/** 滚动区域可见部分的右边缘 */
	right: number;
	items: Item[];
}

function findAt(view: EditorView, from: number): Annotation | null {
	return parseAnnotations(view.state.doc.toString()).find((a) => a.from === from) ?? null;
}

/** 复制意见文字到剪贴板（换行还原，保留 Markdown 符号） */
export function copyComment(comment: string) {
	navigator.clipboard.writeText(decodeComment(comment)).then(
		() => new Notice("已复制批注内容"),
		() => new Notice("复制失败"),
	);
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
	const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
	setIcon(btn, icon);
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick();
	});
}

export const marginCards = ViewPlugin.fromClass(
	class {
		root: HTMLElement;
		/** 编辑中的卡片单独保留，避免重绘时输入框丢失焦点和内容 */
		editCard: HTMLElement | null = null;
		/** 撤销编辑卡片输入框的快捷键作用域 */
		editCleanup: (() => void) | null = null;
		editingFor: number | null = null;
		/** 收起模式下鼠标悬停的气泡所在行，以及该行的预览卡片 */
		hoverLine: number | null = null;
		previewCards: HTMLElement[] = [];
		hideTimer = 0;
		last: Measured | null = null;
		/** 批注起点 → 卡片，用于正文高亮与卡片的悬停联动 */
		cards = new Map<number, HTMLElement>();
		hoverFrom: number | null = null;
		/** 上一次排版时各卡片的位置；重建卡片时从旧位置出发，借助 CSS 过渡平移到新位置 */
		prevTops = new Map<number, number>();
		/** 窗格宽度变化时正文会左右移动（居中），但编辑器不一定报告几何变化，需要自己监听 */
		resize: ResizeObserver;

		constructor(private view: EditorView) {
			this.root = view.scrollDOM.createDiv({ cls: "md-annot-margin" });
			// 不让编辑器把卡片上的点击当成正文点击
			this.root.addEventListener("mousedown", (e) => e.stopPropagation());
			this.resize = new ResizeObserver(() => this.schedule());
			this.resize.observe(view.scrollDOM);
			view.contentDOM.addEventListener("mouseover", this.onTextHover);
			view.contentDOM.addEventListener("mouseleave", this.onTextLeave);
			this.schedule();
		}

		update(u: ViewUpdate) {
			if (
				u.docChanged ||
				u.geometryChanged ||
				u.viewportChanged ||
				u.selectionSet ||
				u.startState.field(editingField) !== u.state.field(editingField) ||
				u.startState.field(editorLivePreviewField) !== u.state.field(editorLivePreviewField) ||
				u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMargin)))
			) {
				this.schedule();
			}
		}

		destroy() {
			window.clearTimeout(this.hideTimer);
			this.resize.disconnect();
			this.editCleanup?.();
			this.view.contentDOM.removeEventListener("mouseover", this.onTextHover);
			this.view.contentDOM.removeEventListener("mouseleave", this.onTextLeave);
			this.root.remove();
			this.view.scrollDOM.removeClass("md-annot-has-margin", "md-annot-collapsed");
		}

		/** 悬停正文高亮时加深对应卡片 */
		onTextHover = (e: MouseEvent) => {
			const mark = (e.target as HTMLElement).closest?.<HTMLElement>("[data-annot-from]");
			this.setHover(mark ? Number(mark.dataset.annotFrom) : null);
		};

		onTextLeave = () => this.setHover(null);

		setHover(from: number | null) {
			if (from === this.hoverFrom) return;
			if (this.hoverFrom !== null) this.cards.get(this.hoverFrom)?.removeClass("is-hover");
			this.hoverFrom = from;
			if (from !== null) this.cards.get(from)?.addClass("is-hover");
		}

		/** 悬停卡片时加深对应原文的高亮 */
		highlightText(from: number, on: boolean) {
			this.view.contentDOM
				.querySelectorAll(`[data-annot-from="${from}"]`)
				.forEach((el) => el.toggleClass("is-hover", on));
		}

		schedule() {
			this.view.requestMeasure<Measured>({
				key: this,
				read: (view) => this.measure(view),
				write: (m, view) => this.render(m, view),
			});
		}

		measure(view: EditorView): Measured {
			const live = view.state.field(editorLivePreviewField);
			const list = live ? parseAnnotations(view.state.doc.toString()) : [];
			const scroller = view.scrollDOM;
			const sr = scroller.getBoundingClientRect();
			const cr = view.contentDOM.getBoundingClientRect();
			const docTop = view.documentTop - sr.top + scroller.scrollTop;
			const items = list.map((a) => {
				const pos = a.isGlobal ? a.from : a.textFrom;
				const coords = view.coordsAtPos(pos);
				const top = coords ? coords.top - sr.top + scroller.scrollTop : view.lineBlockAt(pos).top + docTop;
				return { a, top, line: view.state.doc.lineAt(pos).number };
			});
			return {
				live,
				items,
				left: textRight(view.contentDOM.querySelectorAll(":scope > .cm-line"), cr.right) - sr.left + scroller.scrollLeft + MARGIN_GAP,
				right: scroller.clientWidth + scroller.scrollLeft,
			};
		}

		render(m: Measured, view: EditorView) {
			// 类名加在 scrollDOM 上：CodeMirror 会重写 view.dom 的 class
			const scroller = view.scrollDOM;
			const hasMargin = m.live && m.items.length > 0;
			if (
				scroller.hasClass("md-annot-has-margin") !== hasMargin ||
				scroller.hasClass("md-annot-collapsed") !== display.collapsed
			) {
				scroller.toggleClass("md-annot-has-margin", hasMargin);
				scroller.toggleClass("md-annot-collapsed", display.collapsed);
				// 留白变化会让正文左右移动，但编辑器不一定报告几何变化，需要重新测量
				this.schedule();
				return;
			}
			this.last = m;

			const editing = view.state.field(editingField);
			const editingItem = editing === null ? undefined : m.items.find((i) => i.a.from === editing);
			if (editing !== null && !editingItem) {
				// 编辑中的批注已不存在（例如被整段删除）
				window.setTimeout(() => view.dispatch({ effects: setEditing.of(null) }));
			}
			if (!editingItem || this.editingFor !== editing) {
				this.editCleanup?.();
				this.editCleanup = null;
				this.editCard?.remove();
				this.editCard = null;
				this.editingFor = null;
			}

			for (const child of Array.from(this.root.children)) {
				if (child !== this.editCard) child.remove();
			}
			this.previewCards = [];
			this.cards.clear();
			this.hoverFrom = null;

			if (!display.collapsed) {
				// 整体展开/收起优先：展开时不保留任何悬停预览
				this.hoverLine = null;
				const active = activeAnnotation(view.state, m.items.map((i) => i.a));
				this.placeCards(view, m.items, m.left, CARD_WIDTH, active, editingItem);
				return;
			}

			// 收起模式：按行分组，每组一个数量气泡
			const groups = this.groups(m);
			const active = activeAnnotation(view.state, m.items.map((i) => i.a));
			for (const [line, group] of groups) {
				const badge = this.root.createDiv({ cls: "md-annot-badge", text: String(group.length) });
				badge.setCssStyles({ left: `${m.left}px`, top: `${group[0].top}px` });
				badge.toggleClass("is-active", group.some((i) => i.a === active));
				badge.addEventListener("click", () => display.setCollapsed(false));
				badge.addEventListener("mouseenter", () => this.showPreview(line));
				badge.addEventListener("mouseleave", this.hidePreviewSoon);
			}
			if (this.hoverLine !== null && !groups.has(this.hoverLine)) this.hoverLine = null;
			this.renderPreview();
		}

		groups(m: Measured): Map<number, Item[]> {
			const groups = new Map<number, Item[]>();
			for (const item of m.items) {
				const group = groups.get(item.line);
				if (group) group.push(item);
				else groups.set(item.line, [item]);
			}
			return groups;
		}

		showPreview(line: number) {
			window.clearTimeout(this.hideTimer);
			if (this.hoverLine === line) return;
			this.hoverLine = line;
			this.renderPreview();
		}

		hidePreviewSoon = () => {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = window.setTimeout(() => {
				this.hoverLine = null;
				this.renderPreview();
			}, 200);
		};

		/** 收起模式下，在气泡右侧显示悬停行（或正在编辑的批注所在行）的卡片，不遮挡正文 */
		renderPreview() {
			const m = this.last;
			const view = this.view;
			for (const el of this.previewCards) el.remove();
			this.previewCards = [];
			if (!m || !display.collapsed) return;

			const editing = view.state.field(editingField);
			const editingItem = editing === null ? undefined : m.items.find((i) => i.a.from === editing);
			const line = editingItem ? editingItem.line : this.hoverLine;
			if (line === null) return;

			const left = m.left + BADGE_WIDTH + CARD_SPACING;
			const width = Math.max(MIN_PREVIEW_WIDTH, Math.min(CARD_WIDTH, m.right - left - 12));
			const active = activeAnnotation(view.state, m.items.map((i) => i.a));
			const items = this.groups(m).get(line) ?? [];
			this.previewCards = this.placeCards(view, items, left, width, active, editingItem);
			for (const el of this.previewCards) {
				el.addClass("is-preview");
				el.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
				el.addEventListener("mouseleave", this.hidePreviewSoon);
			}
		}

		/** 渲染卡片并排版：当前批注的卡片对齐原文，其余卡片上下让开；返回新建的卡片元素 */
		placeCards(
			view: EditorView,
			items: Item[],
			left: number,
			width: number,
			active: Annotation | null,
			editingItem: Item | undefined,
		): HTMLElement[] {
			const created: HTMLElement[] = [];
			const els: HTMLElement[] = [];
			for (const { a } of items) {
				let el: HTMLElement;
				if (editingItem && a === editingItem.a) {
					if (!this.editCard) {
						this.editCard = this.buildEditCard(view, a);
						this.editingFor = editingItem.a.from;
					}
					el = this.editCard;
				} else {
					el = this.buildCard(view, a);
					this.root.appendChild(el);
					created.push(el);
				}
				el.toggleClass("is-active", a === active);
				el.setCssStyles({ left: `${left}px`, width: `${width}px` });
				const prev = this.prevTops.get(a.from);
				if (prev !== undefined && el !== this.editCard) el.setCssStyles({ top: `${prev}px` });
				this.cards.set(a.from, el);
				els.push(el);
			}
			// 意见超过两行的卡片在底部加渐隐，提示还有内容
			for (const el of els) {
				const body = el.querySelector<HTMLElement>(".md-annot-card-comment");
				if (body) el.toggleClass("is-clamped", body.scrollHeight > body.clientHeight + 1);
			}
			// 先设好 is-active（当前卡片完整展开）再量高度
			const ys = stackCards(
				items.map((i) => i.top),
				els.map((el) => el.offsetHeight),
				items.findIndex((i) => i.a === active),
				CARD_SPACING,
			);
			els.forEach((el, i) => {
				el.setCssStyles({ top: `${ys[i]}px` });
				this.prevTops.set(items[i].a.from, ys[i]);
			});
			return created;
		}

		buildCard(view: EditorView, a: Annotation): HTMLElement {
			const card = createDiv({ cls: "md-annot-card" });
			this.quote(card, a);
			const body = card.createDiv({ cls: "md-annot-card-comment" });
			const comment = stripPrefix(a.comment, display.prefix);
			if (comment) renderComment(body, comment);
			else body.setText("（空批注）");

			const ops = card.createDiv({ cls: "md-annot-card-ops" });
			iconButton(ops, "pencil", "修改意见", () => view.dispatch({ effects: setEditing.of(a.from) }));
			iconButton(ops, "copy", "复制意见", () => copyComment(stripPrefix(a.comment, display.prefix)));
			iconButton(ops, "trash-2", "删除批注（保留原文）", () => {
				const current = findAt(view, a.from);
				if (current) view.dispatch({ changes: removalChange(view.state.doc.toString(), current) });
			});

			card.addEventListener("click", () => {
				view.dispatch({ selection: { anchor: a.isGlobal ? a.from : a.textFrom } });
				view.focus();
			});
			card.addEventListener("mouseenter", () => this.highlightText(a.from, true));
			card.addEventListener("mouseleave", () => this.highlightText(a.from, false));
			return card;
		}

		buildEditCard(view: EditorView, a: Annotation): HTMLElement {
			const card = this.root.createDiv({ cls: "md-annot-card is-editing" });
			this.quote(card, a);
			const input = card.createEl("textarea", {
				cls: "md-annot-card-input",
				attr: { placeholder: "写下修改意见…", rows: "3" },
			});
			input.value = decodeComment(stripPrefix(a.comment, display.prefix));

			const close = () => view.dispatch({ effects: setEditing.of(null) });
			const cancel = () => {
				const current = this.editingFor === null ? null : findAt(view, this.editingFor);
				// 新建后直接取消：连同空批注一起撤掉
				if (current && !current.comment) {
					view.dispatch({ changes: removalChange(view.state.doc.toString(), current), effects: setEditing.of(null) });
				} else {
					close();
				}
				view.focus();
			};
			const save = () => {
				const comment = sanitizeComment(encodeComment(input.value));
				if (!comment) {
					new Notice("意见不能为空");
					return;
				}
				const current = this.editingFor === null ? null : findAt(view, this.editingFor);
				if (!current) {
					close();
					return;
				}
				view.dispatch({
					changes: { from: current.commentFrom, to: current.commentTo, insert: withPrefix(comment, display.prefix) },
					effects: setEditing.of(null),
				});
				view.focus();
			};

			this.editCleanup = enhanceCommentInput(input, {
				app: view.state.field(editorInfoField, false)?.app,
				// 输入框变高后重新排版，让下面的卡片让开
				onResize: () => this.schedule(),
				onSave: save,
				onCancel: cancel,
			});

			const actions = card.createDiv({ cls: "md-annot-card-actions" });
			actions.createEl("button", { text: "取消" }).addEventListener("click", cancel);
			actions.createEl("button", { cls: "mod-cta", text: "保存" }).addEventListener("click", save);

			window.setTimeout(() => {
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			});
			return card;
		}

		quote(card: HTMLElement, a: Annotation) {
			card.createDiv({
				cls: a.isGlobal ? "md-annot-card-quote is-global" : "md-annot-card-quote",
				text: a.isGlobal ? "全文批注" : a.text,
			});
		}
	},
);
