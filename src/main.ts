import { EditorView } from "@codemirror/view";
import {
	App,
	Editor,
	editorLivePreviewField,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	SettingDefinitionItem,
} from "obsidian";
import {
	globalComment,
	globalInsertOffset,
	parseAnnotations,
	removalChange,
	sanitizeComment,
} from "./critic";
import { blockButton } from "./block";
import { display, MARK_STYLES, MarkStyle, READING_STYLES, ReadingStyle, refreshMargin } from "./display";
import { annotateRange, annotationDecorations, editingField, setEditing } from "./editor";
import { marginCards } from "./margin";
import { selectionButton } from "./selection";
import { readingProcessor } from "./reading";
import { ReadingMargin } from "./reading-margin";

/** Obsidian 的 Editor 背后就是 CodeMirror 6 的 EditorView */
function cmView(editor: Editor): EditorView {
	return (editor as unknown as { cm: EditorView }).cm;
}

function livePreviewView(editor: Editor): EditorView | null {
	const view = cmView(editor);
	if (view.state.field(editorLivePreviewField)) return view;
	new Notice("请在实时预览模式下添加批注");
	return null;
}

interface Settings {
	collapsed: boolean;
	prefix: string;
	readingStyle: ReadingStyle;
	markStyle: MarkStyle;
}

/** 标记样式通过 body 上的类名生效，不需要重新渲染正文 */
const NO_BG = "md-annot-no-bg";
const NO_UNDERLINE = "md-annot-no-underline";

export default class AnnotatorPlugin extends Plugin {
	/** 每个 Markdown 视图标题栏上的“收起/展开批注”按钮 */
	private toggleButtons = new Map<MarkdownView, HTMLElement>();
	/** 每个 Markdown 视图的阅读模式批注栏 */
	private readingMargins = new Map<MarkdownView, ReadingMargin>();

	async onload() {
		const saved = (await this.loadData()) as Partial<Settings> | null;
		display.collapsed = saved?.collapsed ?? false;
		display.prefix = saved?.prefix ?? "";
		display.readingStyle = saved?.readingStyle && saved.readingStyle in READING_STYLES ? saved.readingStyle : "margin";
		display.markStyle = saved?.markStyle && saved.markStyle in MARK_STYLES ? saved.markStyle : "both";
		display.setCollapsed = (collapsed) => void this.setCollapsed(collapsed);
		this.applyMarkStyle();
		// 新开的独立窗口也要带上标记样式
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.applyMarkStyle(win.doc)));

		this.addSettingTab(new AnnotatorSettingTab(this.app, this));
		this.registerEditorExtension([editingField, annotationDecorations, marginCards, blockButton, selectionButton]);
		this.registerMarkdownPostProcessor(readingProcessor);

		this.addCommand({
			id: "add-annotation",
			name: "为选中文字添加批注",
			editorCallback: (editor) => this.addAnnotation(editor),
		});
		this.addCommand({
			id: "add-global-annotation",
			name: "添加全文批注",
			editorCallback: (editor) => this.addGlobalAnnotation(editor),
		});
		this.addCommand({
			id: "clear-all",
			name: "清除本文所有批注（保留原文）",
			editorCallback: (editor) => this.clearAll(editor),
		});

		this.addCommand({
			id: "toggle-margin",
			name: "收起 / 展开批注栏",
			callback: () => this.setCollapsed(!display.collapsed),
		});

		this.app.workspace.onLayoutReady(() => this.attachViews());
		// 启动时视图可能是延迟加载的，打开文件、切换标签时再补上按钮和阅读模式批注栏
		this.registerEvent(this.app.workspace.on("layout-change", () => this.attachViews()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.attachViews()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.attachViews()));

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				if (!(info instanceof MarkdownView)) return;
				if (editor.somethingSelected()) {
					menu.addItem((item) =>
						item.setTitle("添加批注").setIcon("message-square-plus").onClick(() => this.addAnnotation(editor)),
					);
				}
				menu.addItem((item) =>
					item.setTitle("添加全文批注").setIcon("message-square").onClick(() => this.addGlobalAnnotation(editor)),
				);
			}),
		);
	}

	onunload() {
		for (const btn of this.toggleButtons.values()) btn.remove();
		for (const margin of this.readingMargins.values()) margin.destroy();
		for (const doc of this.documents()) doc.body.removeClasses([NO_BG, NO_UNDERLINE]);
	}

	/** 主窗口和所有独立窗口的 document */
	private documents(): Set<Document> {
		const docs = new Set<Document>([document]);
		this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.doc));
		return docs;
	}

	applyMarkStyle(doc?: Document) {
		const style = display.markStyle;
		for (const d of doc ? [doc] : this.documents()) {
			d.body.toggleClass(NO_BG, style === "underline" || style === "none");
			d.body.toggleClass(NO_UNDERLINE, style === "background" || style === "none");
		}
	}

	async setCollapsed(collapsed: boolean) {
		display.collapsed = collapsed;
		await this.saveSettings();
		this.refreshAll();
		this.toggleButtons.forEach((btn) => this.updateToggleButton(btn));
	}

	async saveSettings() {
		await this.saveData({
			collapsed: display.collapsed,
			prefix: display.prefix,
			readingStyle: display.readingStyle,
			markStyle: display.markStyle,
		} satisfies Settings);
	}

	/** 重绘编辑模式和阅读模式的批注栏；rerender 为 true 时重新渲染阅读模式正文（样式或前缀变化后需要） */
	refreshAll(rerender = false) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			// 以阅读模式打开的文档，编辑器可能还没初始化
			(cmView(leaf.view.editor) as EditorView | undefined)?.dispatch({ effects: refreshMargin.of(null) });
			if (rerender) leaf.view.previewMode.rerender(true);
		});
		for (const margin of this.readingMargins.values()) margin.refresh();
	}

	private attachViews() {
		for (const [view, btn] of this.toggleButtons) {
			if (!view.containerEl.isConnected) {
				btn.remove();
				this.toggleButtons.delete(view);
				this.readingMargins.get(view)?.destroy();
				this.readingMargins.delete(view);
			}
		}
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || this.toggleButtons.has(view)) return;
			const btn = view.addAction("message-square", "", () => this.setCollapsed(!display.collapsed));
			this.updateToggleButton(btn);
			this.toggleButtons.set(view, btn);
			this.readingMargins.set(view, new ReadingMargin(view));
		});
	}

	private updateToggleButton(btn: HTMLElement) {
		setIcon(btn, display.collapsed ? "message-square-off" : "message-square");
		btn.setAttr("aria-label", display.collapsed ? "展开批注栏" : "收起批注栏");
	}

	addAnnotation(editor: Editor) {
		const view = livePreviewView(editor);
		if (!view) return;
		const { from, to } = view.state.selection.main;
		annotateRange(view, from, to);
	}

	addGlobalAnnotation(editor: Editor) {
		const view = livePreviewView(editor);
		if (!view) return;
		const at = globalInsertOffset(view.state.doc.toString());
		view.dispatch({
			changes: { from: at, insert: `${globalComment("")}\n\n` },
			effects: setEditing.of(at),
		});
	}

	clearAll(editor: Editor) {
		const view = cmView(editor);
		const doc = view.state.doc.toString();
		const list = parseAnnotations(doc);
		if (!list.length) {
			new Notice("本文没有批注");
			return;
		}
		view.dispatch({ changes: list.map((a) => removalChange(doc, a)), effects: setEditing.of(null) });
		new Notice(`已清除 ${list.length} 条批注，可用 Cmd/Ctrl+Z 撤销`);
	}
}

const PREFIX_PRESETS: Record<string, string> = {
	"": "不加前缀",
	"批注：": "批注：",
	"修改意见：": "修改意见：",
};

class AnnotatorSettingTab extends PluginSettingTab {
	/** 意见前缀下拉框是否选在“自定义…” */
	private custom = !(display.prefix in PREFIX_PRESETS);
	private previewEl: HTMLElement | null = null;

	constructor(app: App, private plugin: AnnotatorPlugin) {
		super(app, plugin);
	}

	private preview() {
		return `写入文件的样子：{==原文==}{>>${display.prefix}补一组近三年的数据<<}`;
	}

	private async setPrefix(prefix: string) {
		display.prefix = sanitizeComment(prefix);
		await this.plugin.saveSettings();
		this.plugin.refreshAll(true);
		this.previewEl?.setText(this.preview());
	}

	/** 设置页由 Obsidian 按这里的定义渲染，设置项也能被设置搜索找到 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "意见前缀",
				desc: "写入文件时加在每条意见前面，帮助 AI 识别这是批注。只影响新写入或修改过的批注，界面上不显示前缀。",
				aliases: ["prefix", "批注"],
				render: (setting) => {
					this.previewEl = setting.descEl.createDiv({ cls: "md-annot-setting-preview", text: this.preview() });
					setting.addDropdown((dd) => {
						for (const [value, label] of Object.entries(PREFIX_PRESETS)) dd.addOption(value, label);
						dd.addOption("__custom__", "自定义…");
						dd.setValue(this.custom ? "__custom__" : display.prefix);
						dd.onChange((value) => {
							this.custom = value === "__custom__";
							if (!this.custom) void this.setPrefix(value);
							// 自定义前缀一行的显示与否变了
							this.update();
						});
					});
				},
			},
			{
				name: "自定义前缀",
				visible: () => this.custom,
				render: (setting) => {
					setting.addText((text) => {
						text.setPlaceholder("例如：AI 请修改：");
						text.setValue(display.prefix in PREFIX_PRESETS ? "" : display.prefix);
						text.onChange((value) => void this.setPrefix(value));
					});
				},
			},
			{
				name: "批注原文样式",
				desc: "被批注的原文怎么标出来，编辑和阅读模式都生效。无论选哪种，悬停或选中某条批注时，对应的原文都会加深显示。",
				aliases: ["高亮", "下划线", "底色", "highlight", "underline"],
				render: (setting) => {
					setting.addDropdown((dd) => {
						for (const [value, label] of Object.entries(MARK_STYLES)) dd.addOption(value, label);
						dd.setValue(display.markStyle);
						dd.onChange((value) => {
							display.markStyle = value as MarkStyle;
							void this.plugin.saveSettings();
							this.plugin.applyMarkStyle();
						});
					});
				},
			},
			{
				name: "阅读模式样式",
				desc: "阅读模式下批注的显示方式。选择“右侧卡片栏”时，展开 / 收起与编辑模式共用标题栏上的按钮。",
				aliases: ["reading", "阅读视图"],
				render: (setting) => {
					setting.addDropdown((dd) => {
						for (const [value, label] of Object.entries(READING_STYLES)) dd.addOption(value, label);
						dd.setValue(display.readingStyle);
						dd.onChange((value) => {
							display.readingStyle = value as ReadingStyle;
							void this.plugin.saveSettings();
							this.plugin.refreshAll(true);
						});
					});
				},
			},
		];
	}
}
