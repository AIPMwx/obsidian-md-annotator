// 选区批注按钮：选中文字（可跨段）松开鼠标后，在选区末行的正文右侧显示“批注”按钮，点击即批注整个选区。
// 和区块悬停按钮（block.ts）是两套独立的逻辑：有选区时悬停按钮让位，只在按住 Shift 时出现用于扩展选区。
// 按钮所在的列在卡片栏 / 数量气泡左侧，不会被已有批注挡住；选区不能批注时按钮置灰，悬停显示原因。

import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField, Notice, setIcon, setTooltip } from "obsidian";
import { prepareRange, validateSelection } from "./critic";
import { annotateRange, editingField } from "./editor";
import { textRight } from "./layout";

interface Placement {
	top: number;
	left: number;
	error: string | null;
}

export const selectionButton = ViewPlugin.fromClass(
	class {
		button: HTMLElement;
		/** 拖动选择过程中不显示，松开鼠标后再出现 */
		dragging = false;
		error: string | null = null;
		/** 窗格宽度变化时正文会左右移动，按钮要跟着重新定位 */
		resize: ResizeObserver;

		constructor(private view: EditorView) {
			this.button = view.scrollDOM.createDiv({ cls: "md-annot-sel-btn" });
			// 与悬停按钮同宽，保证不伸进右侧卡片栏；用实心底色区分
			setIcon(this.button, "message-square-plus");
			this.button.addEventListener("mousedown", (e) => {
				// 保留选区，不让编辑器处理这次点击
				e.preventDefault();
				e.stopPropagation();
				if (this.error) {
					new Notice(this.error);
					return;
				}
				const { from, to } = this.view.state.selection.main;
				this.hide();
				annotateRange(this.view, from, to);
			});

			this.resize = new ResizeObserver(() => this.schedule());
			this.resize.observe(view.scrollDOM);
			view.contentDOM.addEventListener("mousedown", this.onPointerDown);
			document.addEventListener("mouseup", this.onPointerUp);
			this.schedule();
		}

		update(u: ViewUpdate) {
			if (
				u.selectionSet ||
				u.docChanged ||
				u.geometryChanged ||
				u.startState.field(editingField) !== u.state.field(editingField) ||
				u.startState.field(editorLivePreviewField) !== u.state.field(editorLivePreviewField)
			) {
				this.schedule();
			}
		}

		destroy() {
			this.resize.disconnect();
			this.view.contentDOM.removeEventListener("mousedown", this.onPointerDown);
			document.removeEventListener("mouseup", this.onPointerUp);
			this.button.remove();
		}

		onPointerDown = () => {
			this.dragging = true;
			this.hide();
		};

		onPointerUp = () => {
			if (!this.dragging) return;
			this.dragging = false;
			this.schedule();
		};

		hide() {
			this.button.removeClass("is-visible");
		}

		schedule() {
			this.view.requestMeasure<Placement | null>({
				key: this,
				read: (view) => this.measure(view),
				write: (p) => this.render(p),
			});
		}

		measure(view: EditorView): Placement | null {
			if (this.dragging || !view.state.field(editorLivePreviewField)) return null;
			if (view.state.field(editingField) !== null) return null;
			const sel = view.state.selection.main;
			if (sel.empty) return null;

			const doc = view.state.doc.toString();
			const range = prepareRange(doc, sel.from, sel.to);
			if (range.to <= range.from) return null;
			const coords = view.coordsAtPos(range.to, -1);
			if (!coords) return null;

			const scroller = view.scrollDOM;
			const sr = scroller.getBoundingClientRect();
			const cr = view.contentDOM.getBoundingClientRect();
			const right = textRight(view.contentDOM.querySelectorAll(":scope > .cm-line"), cr.right);
			return {
				top: coords.top - sr.top + scroller.scrollTop - 2,
				left: right - sr.left + scroller.scrollLeft + 6,
				error: validateSelection(doc, range.from, range.to),
			};
		}

		render(p: Placement | null) {
			if (!p) {
				this.error = null;
				this.hide();
				return;
			}
			this.error = p.error;
			this.button.style.top = `${p.top}px`;
			this.button.style.left = `${p.left}px`;
			this.button.toggleClass("is-disabled", p.error !== null);
			setTooltip(this.button, p.error ?? "为选中的文字添加批注（Cmd/Ctrl+Shift+M）", { placement: "top" });
			this.button.addClass("is-visible");
		}
	},
);
