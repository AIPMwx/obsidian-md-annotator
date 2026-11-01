// 区块悬停按钮：鼠标移到某一段（行）上时，在正文右侧显示“添加批注”按钮。
//   点击：批注这一段。
//   Shift+点击：把这一段并入选区，可以连续点多段，再用选区按钮（selection.ts）批注全部。
// 有选区时不显示（交给选区按钮），只有按住 Shift 时才出现，用于扩展选区。

import { Text } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { editorLivePreviewField, setIcon, setTooltip } from "obsidian";
import { blockContentRange, nonProseLines, validateSelection } from "./critic";
import { annotateRange } from "./editor";
import { textRight } from "./layout";
import { MARGIN_GAP } from "./margin";

export const blockButton = ViewPlugin.fromClass(
	class {
		button: HTMLElement;
		target: { from: number; to: number } | null = null;
		/** 代码块 / frontmatter 行的缓存，文档变化后重新计算 */
		cachedDoc: Text | null = null;
		skipLines: boolean[] = [];

		constructor(private view: EditorView) {
			this.button = view.scrollDOM.createDiv({ cls: "md-annot-block-btn" });
			setIcon(this.button, "message-square-plus");
			setTooltip(this.button, "添加批注（Shift+点击可选中多段）", { placement: "top" });
			this.button.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const target = this.target;
				if (!target) return;
				const view = this.view;
				const sel = view.state.selection.main;
				if (e.shiftKey || !sel.empty) {
					const from = sel.empty ? target.from : Math.min(sel.from, target.from);
					const to = sel.empty ? target.to : Math.max(sel.to, target.to);
					view.dispatch({ selection: { anchor: from, head: to } });
					view.focus();
					return;
				}
				this.hide();
				annotateRange(view, target.from, target.to);
			});

			view.scrollDOM.addEventListener("mousemove", this.onMove);
			view.scrollDOM.addEventListener("mouseleave", this.hide);
		}

		destroy() {
			this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
			this.view.scrollDOM.removeEventListener("mouseleave", this.hide);
			this.button.remove();
		}

		hide = () => {
			this.target = null;
			this.button.removeClass("is-visible");
		};

		onMove = (e: MouseEvent) => {
			const view = this.view;
			if (!view.state.field(editorLivePreviewField)) return this.hide();
			if (e.buttons !== 0 || e.target === this.button || this.button.contains(e.target as Node)) return;
			// 有选区时让位给选区按钮，按住 Shift 才用于扩展选区
			if (!view.state.selection.main.empty && !e.shiftKey) return this.hide();

			const cr = view.contentDOM.getBoundingClientRect();
			const right = textRight(view.contentDOM.querySelectorAll(":scope > .cm-line"), cr.right);
			// 鼠标进入卡片栏后不再显示按钮
			if (e.clientX > right + MARGIN_GAP || e.clientY < cr.top || e.clientY > cr.bottom) return this.hide();

			const x = Math.min(Math.max(e.clientX, cr.left + 1), right - 1);
			const pos = view.posAtCoords({ x, y: e.clientY }, false);
			const line = view.state.doc.lineAt(pos);

			if (this.cachedDoc !== view.state.doc) {
				this.cachedDoc = view.state.doc;
				this.skipLines = nonProseLines(view.state.doc.toString());
			}
			if (this.skipLines[line.number - 1]) return this.hide();

			const range = blockContentRange(line.text);
			if (!range) return this.hide();
			const from = line.from + range.start;
			const to = line.from + range.end;
			if (validateSelection(view.state.doc.toString(), from, to)) return this.hide();

			const sr = view.scrollDOM.getBoundingClientRect();
			const coords = view.coordsAtPos(line.from, 1) ?? view.coordsAtPos(from, 1);
			if (!coords) return this.hide();
			this.target = { from, to };
			this.button.setCssStyles({ top: `${coords.top - sr.top + view.scrollDOM.scrollTop - 2}px`, left: `${right - sr.left + view.scrollDOM.scrollLeft + 6}px` });
			this.button.addClass("is-visible");
		};
	},
);
