import { EditorView } from "@codemirror/view";
import { App, Editor, editorLivePreviewField, MarkdownView, Notice, Plugin, PluginSettingTab, setIcon, Setting } from "obsidian";
import {
	globalComment,
	globalInsertOffset,
	parseAnnotations,
	removalChange,
	sanitizeComment,
	validateSelection,
} from "./critic";
import { blockButton } from "./block";
import { display, READING_STYLES, ReadingStyle, refreshMargin } from "./display";
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
}

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
		display.setCollapsed = (collapsed) => void this.setCollapsed(collapsed);

		this.addSettingTab(new AnnotatorSettingTab(this.app, this));
		this.registerEditorExtension([editingField, annotationDecorations, marginCards, blockButton, selectionButton]);
		this.registerMarkdownPostProcessor(readingProcessor);

		this.addCommand({
			id: "add-annotation",
			name: "为选中文字添加批注",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
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
	constructor(app: App, private plugin: AnnotatorPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		const preview = () => `写入文件的样子：{==原文==}{>>${display.prefix}补一组近三年的数据<<}`;
		let previewEl: HTMLElement | null = null;
		let customSetting: Setting | null = null;
		const isPreset = display.prefix in PREFIX_PRESETS;

		const update = async (prefix: string) => {
			display.prefix = sanitizeComment(prefix);
			await this.plugin.saveSettings();
			this.plugin.refreshAll(true);
			previewEl?.setText(preview());
		};

		new Setting(containerEl)
			.setName("意见前缀")
			.setDesc("写入文件时加在每条意见前面，帮助 AI 识别这是批注。只影响新写入或修改过的批注，界面上不显示前缀。")
			.addDropdown((dd) => {
				for (const [value, label] of Object.entries(PREFIX_PRESETS)) dd.addOption(value, label);
				dd.addOption("__custom__", "自定义…");
				dd.setValue(isPreset ? display.prefix : "__custom__");
				dd.onChange(async (value) => {
					const custom = value === "__custom__";
					customSetting?.settingEl.toggle(custom);
					if (!custom) await update(value);
				});
			});

		customSetting = new Setting(containerEl)
			.setName("自定义前缀")
			.addText((text) =>
				text
					.setPlaceholder("例如：AI 请修改：")
					.setValue(isPreset ? "" : display.prefix)
					.onChange((value) => update(value)),
			);
		customSetting.settingEl.toggle(!isPreset);

		previewEl = containerEl.createDiv({ cls: "md-annot-setting-preview", text: preview() });

		new Setting(containerEl)
			.setName("阅读模式样式")
			.setDesc("阅读模式下批注的显示方式。选择“右侧卡片栏”时，展开 / 收起与编辑模式共用标题栏上的按钮。")
			.addDropdown((dd) => {
				for (const [value, label] of Object.entries(READING_STYLES)) dd.addOption(value, label);
				dd.setValue(display.readingStyle);
				dd.onChange(async (value) => {
					display.readingStyle = value as ReadingStyle;
					await this.plugin.saveSettings();
					this.plugin.refreshAll(true);
				});
			});
	}
}
