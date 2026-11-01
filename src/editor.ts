// 实时预览模式下的正文渲染：隐藏标记符号，只留下高亮的原文；意见显示在右侧卡片栏（margin.ts）。

import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField, Notice, setIcon } from "obsidian";
import { Annotation, parseAnnotations, prepareRange, validateSelection, wrapText } from "./critic";

/** 正在卡片里编辑的批注（以批注起点标识），随文档改动自动映射位置 */
export const setEditing = StateEffect.define<number | null>();

export const editingField = StateField.define<number | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setEditing)) return e.value;
		return value !== null && tr.docChanged ? tr.changes.mapPos(value, 1) : value;
	},
});

/** 光标所在的批注即“当前批注”，正文和卡片都会加强显示 */
export function activeAnnotation(state: EditorState, list: Annotation[]): Annotation | null {
	const editing = state.field(editingField);
	if (editing !== null) return list.find((a) => a.from === editing) ?? null;
	// 用含标记的整个范围判断：标记被隐藏后，光标常会落在开头标记之前或结尾标记之后
	const head = state.selection.main.head;
	return list.find((a) => !a.global && head >= a.from && head <= a.to) ?? null;
}

/** 插入一条意见为空的批注，并直接打开它的编辑卡片 */
export function insertAnnotation(view: EditorView, from: number, to: number) {
	const text = view.state.sliceDoc(from, to);
	view.dispatch({
		changes: { from, to, insert: wrapText(text, "") },
		effects: setEditing.of(from),
	});
}

/** 整理并校验选区后插入批注；不能批注时给出提示 */
export function annotateRange(view: EditorView, from: number, to: number): boolean {
	const doc = view.state.doc.toString();
	const range = prepareRange(doc, from, to);
	const error = validateSelection(doc, range.from, range.to);
	if (error) {
		new Notice(error);
		return false;
	}
	insertAnnotation(view, range.from, range.to);
	return true;
}

class GlobalChip extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		const el = document.createElement("span");
		el.className = "md-annot-global";
		setIcon(el.createSpan({ cls: "md-annot-icon" }), "message-square");
		el.createSpan({ cls: "md-annot-global-label", text: "全文批注" });
		return el;
	}
}

const hidden = Decoration.replace({});
const chip = Decoration.replace({ widget: new GlobalChip() });
/** data-annot-from 用于把正文高亮和右侧卡片对应起来（悬停联动） */
const markFor = (a: Annotation, active: boolean) =>
	Decoration.mark({
		class: active ? "md-annot-hl is-active" : "md-annot-hl",
		attributes: { "data-annot-from": String(a.from) },
	});
/** 跨段批注：每一行左侧再加一条竖线，标出批注范围 */
const blockLine = Decoration.line({ class: "md-annot-block-line" });
const activeBlockLine = Decoration.line({ class: "md-annot-block-line is-active" });

export const annotationDecorations = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(u: ViewUpdate) {
			const modeChanged = u.startState.field(editorLivePreviewField) !== u.state.field(editorLivePreviewField);
			const editingChanged = u.startState.field(editingField) !== u.state.field(editingField);
			if (u.docChanged || u.selectionSet || modeChanged || editingChanged) {
				this.decorations = this.build(u.view);
			}
		}

		build(view: EditorView): DecorationSet {
			if (!view.state.field(editorLivePreviewField)) return Decoration.none;
			const list = parseAnnotations(view.state.doc.toString());
			const active = activeAnnotation(view.state, list);
			const decos: Range<Decoration>[] = [];
			for (const a of list) {
				if (a.global) {
					decos.push(chip.range(a.from, a.to));
					continue;
				}
				decos.push(hidden.range(a.from, a.textFrom));
				if (a.textTo > a.textFrom) decos.push(markFor(a, a === active).range(a.textFrom, a.textTo));
				decos.push(hidden.range(a.textTo, a.to));
				if (a.text.includes("\n")) {
					const doc = view.state.doc;
					const last = doc.lineAt(a.textTo).number;
					for (let n = doc.lineAt(a.textFrom).number; n <= last; n++) {
						const line = doc.line(n);
						if (line.length) decos.push((a === active ? activeBlockLine : blockLine).range(line.from));
					}
				}
			}
			return Decoration.set(decos, true);
		}
	},
	{ decorations: (v) => v.decorations },
);
