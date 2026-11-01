// 阅读模式的右侧批注栏（readingStyle 为 margin 时启用），只读。
// 阅读模式由 Obsidian 按需渲染段落，这里只给已渲染出来的批注画卡片；
// 段落渲染、窗口尺寸变化时重新排版。展开 / 收起与编辑模式共用同一个开关。
// 点击正文高亮或卡片会把它设为当前批注：卡片完整展开并对齐原文，其余卡片上下让开。

import { MarkdownView } from "obsidian";
import { display } from "./display";
import { stackCards, textRight } from "./layout";
import { renderComment } from "./markdown";
import { BADGE_WIDTH, CARD_SPACING, CARD_WIDTH, copyComment, iconButton, MARGIN_GAP, MIN_PREVIEW_WIDTH } from "./margin";

interface Item {
	el: HTMLElement;
	top: number;
	quote: string;
	comment: string;
	global: boolean;
}

/** 收起模式下，高度相差不超过这个值的批注算同一行 */
const SAME_LINE = 6;

export class ReadingMargin {
	private layer: HTMLElement | null = null;
	private mutations: MutationObserver;
	private resize: ResizeObserver;
	private frame = 0;
	private hoverGroup: number | null = null;
	private hideTimer = 0;
	private groups: Item[][] = [];
	private left = 0;
	private right = 0;
	private previewCards: HTMLElement[] = [];
	/** 当前批注对应的正文元素 */
	private active: HTMLElement | null = null;
	/** 正文元素 → 卡片，用于悬停联动 */
	private cards = new Map<HTMLElement, HTMLElement>();
	private hovered: HTMLElement | null = null;

	constructor(private view: MarkdownView) {
		this.mutations = new MutationObserver((records) => {
			// 忽略卡片栏自身的变化，避免死循环
			if (records.every((r) => this.layer?.contains(r.target))) return;
			this.refresh();
		});
		this.mutations.observe(this.scroller, { childList: true, subtree: true });
		this.resize = new ResizeObserver(() => this.refresh());
		this.resize.observe(this.scroller);
		this.scroller.addEventListener("click", this.onClick);
		this.scroller.addEventListener("mouseover", this.onHover);
		this.refresh();
	}

	private annotatedTarget(e: Event): HTMLElement | null {
		const target = e.target as HTMLElement;
		if (this.layer?.contains(target)) return null;
		return target.closest?.<HTMLElement>("[data-annot-comment]") ?? null;
	}

	/** 点击正文高亮设为当前批注，点击其他正文取消 */
	private onClick = (e: MouseEvent) => {
		if (this.layer?.contains(e.target as Node)) return;
		const el = this.annotatedTarget(e);
		if (el === this.active) return;
		this.active = el;
		this.refresh();
	};

	/** 悬停正文高亮时加深对应卡片 */
	private onHover = (e: MouseEvent) => {
		if (this.layer?.contains(e.target as Node)) return;
		const el = this.annotatedTarget(e);
		if (el === this.hovered) return;
		if (this.hovered) this.cards.get(this.hovered)?.removeClass("is-hover");
		this.hovered = el;
		if (el) this.cards.get(el)?.addClass("is-hover");
	};

	private get scroller(): HTMLElement {
		const root = this.view.previewMode.containerEl;
		return root.querySelector<HTMLElement>(".markdown-preview-view") ?? root;
	}

	destroy() {
		window.cancelAnimationFrame(this.frame);
		window.clearTimeout(this.hideTimer);
		this.mutations.disconnect();
		this.resize.disconnect();
		this.scroller.removeEventListener("click", this.onClick);
		this.scroller.removeEventListener("mouseover", this.onHover);
		this.layer?.remove();
		this.scroller.removeClass("md-annot-has-margin", "md-annot-collapsed");
	}

	refresh() {
		window.cancelAnimationFrame(this.frame);
		this.frame = window.requestAnimationFrame(() => this.layout());
	}

	private layout() {
		const scroller = this.scroller;
		const sizer = scroller.querySelector<HTMLElement>(".markdown-preview-sizer");
		const marks = sizer ? Array.from(sizer.querySelectorAll<HTMLElement>("[data-annot-comment]")) : [];
		const enabled = display.readingStyle === "margin" && marks.length > 0;

		if (
			scroller.hasClass("md-annot-has-margin") !== enabled ||
			scroller.hasClass("md-annot-collapsed") !== display.collapsed
		) {
			scroller.toggleClass("md-annot-has-margin", enabled);
			scroller.toggleClass("md-annot-collapsed", display.collapsed);
			// 留白变化会让正文移动，下一帧再排版
			this.refresh();
			return;
		}
		if (!enabled || !sizer || !scroller.isShown()) {
			this.layer?.empty();
			return;
		}

		if (!this.layer || this.layer.parentElement !== scroller) {
			this.layer?.remove();
			this.layer = scroller.createDiv({ cls: "md-annot-margin" });
		}
		this.layer.empty();
		this.previewCards = [];
		this.cards.clear();
		this.hovered = null;
		if (this.active && !marks.includes(this.active)) this.active = null;
		for (const el of marks) el.toggleClass("is-active", el === this.active);

		const sr = scroller.getBoundingClientRect();
		const zr = sizer.getBoundingClientRect();
		const contentRight = textRight(
			sizer.querySelectorAll(":scope > div"),
			zr.right - parseFloat(getComputedStyle(sizer).paddingRight || "0"),
		);
		this.left = contentRight - sr.left + scroller.scrollLeft + MARGIN_GAP;
		this.right = scroller.clientWidth + scroller.scrollLeft;

		const items: Item[] = marks
			.map((el) => ({
				el,
				top: el.getBoundingClientRect().top - sr.top + scroller.scrollTop,
				quote: el.dataset.annotQuote ?? "",
				comment: el.dataset.annotComment ?? "",
				global: el.dataset.annotGlobal === "true",
			}))
			.sort((a, b) => a.top - b.top);

		if (!display.collapsed) {
			this.hoverGroup = null;
			this.placeCards(items, this.left, CARD_WIDTH);
			return;
		}

		// 收起模式：同一行的批注合成一个数量气泡
		this.groups = [];
		for (const item of items) {
			const group = this.groups[this.groups.length - 1];
			if (group && Math.abs(group[0].top - item.top) <= SAME_LINE) group.push(item);
			else this.groups.push([item]);
		}
		this.groups.forEach((group, index) => {
			const badge = this.layer!.createDiv({ cls: "md-annot-badge", text: String(group.length) });
			badge.style.left = `${this.left}px`;
			badge.style.top = `${group[0].top}px`;
			badge.addEventListener("click", () => display.setCollapsed(false));
			badge.addEventListener("mouseenter", () => this.showPreview(index));
			badge.addEventListener("mouseleave", this.hidePreviewSoon);
		});
		if (this.hoverGroup !== null && this.hoverGroup >= this.groups.length) this.hoverGroup = null;
		this.renderPreview();
	}

	private showPreview(index: number) {
		window.clearTimeout(this.hideTimer);
		if (this.hoverGroup === index) return;
		this.hoverGroup = index;
		this.renderPreview();
	}

	private hidePreviewSoon = () => {
		window.clearTimeout(this.hideTimer);
		this.hideTimer = window.setTimeout(() => {
			this.hoverGroup = null;
			this.renderPreview();
		}, 200);
	};

	/** 收起模式下在气泡右侧预览该行的批注，不遮挡正文 */
	private renderPreview() {
		for (const el of this.previewCards) el.remove();
		this.previewCards = [];
		if (this.hoverGroup === null || !display.collapsed) return;
		const left = this.left + BADGE_WIDTH + CARD_SPACING;
		const width = Math.max(MIN_PREVIEW_WIDTH, Math.min(CARD_WIDTH, this.right - left - 12));
		this.previewCards = this.placeCards(this.groups[this.hoverGroup] ?? [], left, width);
		for (const el of this.previewCards) {
			el.addClass("is-preview");
			el.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
			el.addEventListener("mouseleave", this.hidePreviewSoon);
		}
	}

	private placeCards(items: Item[], left: number, width: number): HTMLElement[] {
		const cards: HTMLElement[] = [];
		for (const item of items) {
			const card = this.layer!.createDiv({ cls: "md-annot-card is-readonly" });
			card.createDiv({
				cls: item.global ? "md-annot-card-quote is-global" : "md-annot-card-quote",
				text: item.global ? "全文批注" : item.quote,
			});
			const body = card.createDiv({ cls: "md-annot-card-comment" });
			if (item.comment) renderComment(body, item.comment);
			else body.setText("（空批注）");
			// 阅读模式只读，悬停只提供复制
			iconButton(card.createDiv({ cls: "md-annot-card-ops" }), "copy", "复制意见", () => copyComment(item.comment));
			// 悬停卡片时加深对应原文的高亮，点击设为当前批注
			card.addEventListener("mouseenter", () => item.el.addClass("is-hover"));
			card.addEventListener("mouseleave", () => item.el.removeClass("is-hover"));
			card.addEventListener("click", () => {
				this.active = item.el;
				this.refresh();
			});

			card.toggleClass("is-active", item.el === this.active);
			card.style.left = `${left}px`;
			card.style.width = `${width}px`;
			this.cards.set(item.el, card);
			cards.push(card);
		}
		// 意见超过两行的卡片在底部加渐隐，提示还有内容
		for (const card of cards) {
			const body = card.querySelector<HTMLElement>(".md-annot-card-comment");
			if (body) card.toggleClass("is-clamped", body.scrollHeight > body.clientHeight + 1);
		}
		const ys = stackCards(
			items.map((i) => i.top),
			cards.map((c) => c.offsetHeight),
			items.findIndex((i) => i.el === this.active),
			CARD_SPACING,
		);
		cards.forEach((card, i) => (card.style.top = `${ys[i]}px`));
		return cards;
	}
}
