# MD Annotator

**像审稿一样给 AI 写的稿子做批注，再让 AI 按批注改稿。**

MD Annotator 是一个 Obsidian 插件：在 Markdown 文档里选中文字、写下修改意见，意见会以标准的 [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) 格式直接写进文件。AI 读这个文件时，能准确知道每一条意见针对的是哪一段原文。

English summary is at the [end of this page](#english).

---

## 为什么做这个插件

现在写长文，我越来越多的做法是先让 AI 出一版初稿，再自己来改。但改 AI 的稿子有两种常见方式，都不太顺手：

- **自己直接改**：费时费力，而且改着改着就变成了自己重写，AI 的价值没有发挥出来。
- **在对话框里告诉 AI 怎么改**：“第三段第二句太口语化”“开头那个例子换一下”“前面三段的结构要调”……描述位置本身就很累，AI 还经常定位错，改了不该改的地方。

我真正想要的，是像审阅同事的文档那样：**在原文上直接圈出来、写批注，然后把整篇文档交回给 AI，让它逐条落实。**

所以有了这个插件。它想解决的不是“怎么写批注”，而是 **怎么让人的修改意见以最低的成本、最准确地传达给 AI**。

## 它如何提升人和 AI 的协作效率

传统的人机协作，是“人描述 → AI 理解 → AI 修改”，中间最容易出问题的就是“描述”和“理解”。MD Annotator 把这一步换成了 **“人在原文上批注 → AI 读文件”**：

| | 在对话框里描述修改 | 用 MD Annotator 批注 |
|---|---|---|
| 定位原文 | 靠文字描述“第几段第几句”，容易说不清、指错 | 意见直接挂在原文上，位置零歧义 |
| 反馈方式 | 一条一条地说，来回好几轮 | 通读一遍、批注完，一次交给 AI |
| 上下文 | 意见散落在聊天记录里 | 意见和原文在同一个文件里，文件本身就是完整上下文 |
| 跨段意见 | “前面三段”这种范围很难说准 | 直接框选多段，范围一目了然 |
| 检查是否改到位 | 要对照聊天记录逐条核对 | AI 改完后标记消失；剩下的批注就是还没处理的 |

几个让协作更顺的设计：

- **用的是标准格式**：`{==原文==}{>>意见<<}` 是现成的 CriticMarkup 语法，大模型普遍认识，不需要额外教。
- **不绑定任何 AI 工具**：批注就是文件里的纯文本。Claude Code、Cursor 这类能直接读写本地文件的工具可以直接处理；用网页版的 ChatGPT、Claude、豆包等，把全文粘贴过去也一样。
- **人负责判断，AI 负责执行**：你只需要专注于“哪里不好、要改成什么样”，把重写的体力活交给 AI。改完再看，有不满意的地方继续批注，形成一个高效的迭代循环。

## 典型工作流

```
AI 生成初稿  →  你在 Obsidian 里通读、批注  →  AI 按批注修改  →  你再审一遍 / 继续批注
```

把文档交给 AI 时，可以这样说（只需要说一次）：

> 文中 `{==原文==}{>>意见<<}` 是我的批注，`{>>意见<<}` 单独出现时是针对全文的意见。请逐条按意见修改对应的原文，改完删掉所有批注标记，输出干净的正文，并在最后列一份清单说明每条批注是怎么处理的。如果有看不懂或有歧义的批注，先列出来问我，不要自己猜。

---

## 主要功能

### 添加批注

- **悬停一段，一键批注整段**：鼠标移到某一段上，正文右侧会出现批注按钮，点击即批注这一整段。
- **选中文字，就地批注**：选中文字后松开鼠标，选区旁边出现橙色的批注按钮。也可以用快捷键 `Cmd/Ctrl + Shift + M`，或者右键菜单「添加批注」。
- **跨段落批注**：可以一次框选多个段落，适合“这几段的结构要调整”这类整体性意见。也可以在悬停按钮上 `Shift + 点击`，逐段把段落加进选区。
- **全文批注**：针对整篇文章的意见（比如“语气再正式一些”），通过右键菜单或命令面板「添加全文批注」，会插在文档开头。

### 查看批注

- **右侧卡片栏**：意见以卡片形式显示在正文右侧，和原文对齐，体验接近主流的在线文档。
- **密集批注也不乱**：卡片默认只显示前两行。点击原文高亮或卡片，这条批注会完整展开，并对齐到原文旁边，其他卡片自动让开。
- **双向联动**：悬停原文高亮时对应卡片会加深显示，悬停卡片时对应原文也会加深。
- **小屏幕友好**：可以把卡片栏收起成每行一个数量气泡。悬停气泡在旁边预览批注，点击气泡展开全部。
- **阅读模式也能看批注**：有四种样式可选，包括右侧卡片栏、行内图标、只高亮原文，以及隐藏批注只看正文。

### 编写意见

- **支持简单 Markdown**：意见里可以用 **加粗**、*斜体*、`代码`、无序列表、有序列表，卡片上会渲染出来。
- **输入框随内容自动变高**：在列表行按回车会自动续上序号；支持 `Cmd/Ctrl + B` 加粗、`Cmd/Ctrl + I` 斜体、`Cmd/Ctrl + Enter` 保存、`Esc` 取消。
- **卡片上的操作**：鼠标悬停在卡片上，可以修改、复制或删除意见。删除只去掉批注标记，原文保留。
- **一键清除**：命令「清除本文所有批注」会去掉全部标记、保留原文，可以用 `Cmd/Ctrl + Z` 撤销。

### 设置

- **意见前缀**：可以选择在写入文件时，给每条意见加上「批注：」「修改意见：」或自定义的前缀，帮助 AI 更明确地识别批注。界面上不显示这个前缀。
- **阅读模式样式**：选择阅读模式下批注的显示方式。

## 批注在文件里的样子

批注直接保存在 Markdown 原文里，不依赖插件数据，跟着文件走：同步、复制、换设备都不会丢。

```markdown
{>>整体：语气再正式一些，结尾补一段总结<<}

近年来，{==越来越多的企业开始重视数字化转型==}{>>补一组近三年的数据<<}，但真正取得成效的并不多。

{==第一段……

第二段……==}{>>这两段整体重写：先举场景，再写如何实现<<}
```

- `{==原文==}{>>意见<<}`：针对某段文字的批注，原文可以跨多个段落。
- `{>>意见<<}`：全文批注。
- 意见里的换行在文件中保存为 `<br>`，这样每条意见都保持在一行内。编辑时会自动还原成换行。

## 安装

**从插件市场安装**：设置 → 第三方插件 → 浏览，搜索 “MD Annotator”。

**手动安装**：从 [Releases](https://github.com/wangxingai/obsidian-md-annotator/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放到 `<你的 vault>/.obsidian/plugins/md-annotator/`，然后在设置 → 第三方插件里启用。

## 说明与限制

- 添加和编辑批注需要在 **实时预览** 模式下进行。阅读模式下只能查看和复制。
- 选区里包含代码块、表格、公式块或嵌入内容时，不能跨这些内容添加批注，以免破坏 Markdown 结构。
- 目前主要针对桌面端设计，手机端还没有专门适配。

## 开发

```bash
npm install
npm run dev     # 监听构建
npm run build   # 生产构建
```

`test-vault/` 是开发用的测试 vault，插件文件以软链接方式指向工程根目录的构建产物。

## License

[MIT](LICENSE)

---



## English

**Annotate AI-written drafts like a reviewer, then let the AI revise them according to your notes.**

MD Annotator lets you select text in a Markdown note and attach a comment. Comments are written straight into the file using the standard [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) syntax (`{==text==}{>>comment<<}`), so any AI tool that reads the file knows exactly which passage each comment refers to.

**Why:** when you revise an AI draft, describing *where* to change things in a chat box ("the second sentence of paragraph three...") is slow and error-prone. Annotating the text in place removes that ambiguity. You review once, leave all your feedback, and hand the whole file back to the AI. You focus on judgement; the AI does the rewriting.

**Features**

- One-click annotation of a paragraph on hover, or of any selection (including multiple paragraphs), plus whole-document comments.
- A Google-Docs-style comment margin: cards aligned with the text, compact two-line previews, the active card expands and aligns with its passage, and highlights and cards highlight each other on hover.
- A collapsible margin with count badges for small screens, and four display styles for Reading view.
- Lightweight Markdown in comments (bold, italic, code, lists), an auto-growing input box, and keyboard shortcuts.
- An optional comment prefix (e.g. `Note:`) to make annotations even more explicit for AI.
- Annotations are plain text inside your notes and work with any AI tool: Claude Code, Cursor, or pasting into a chat.

The plugin UI is currently in Chinese.
