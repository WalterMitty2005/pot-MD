# pot-MD

> 支持Markdown输出的pot

基于 [pot-app/pot-desktop](https://github.com/pot-app/pot-desktop) (v3.0.7) 的二次开发版本，在原版基础上增加了翻译结果 Markdown 渲染、LaTeX 公式显示、服务级自动翻译开关等功能。

## 鸣谢

本项目基于 [pot](https://github.com/pot-app/pot-desktop)（派了个萌的翻译器）二次开发，感谢原作者 [pot-app](https://github.com/pot-app) 及所有贡献者的出色工作。

原项目采用 GPL-3.0 许可证，本项目继承同一许可证。

## 修改内容

较原版 pot 3.0.7 的修改如下：

| 序号 | 修改内容 |
|:---:|---|
| 1 | 翻译结果 Markdown 渲染（核心功能）。翻译结果以 Markdown 格式渲染，支持标题、列表、代码块、表格等；数学公式通过 KaTeX 渲染，行内公式 `$...$`，块级公式 `$$...$$`。提供全局开关、启发式自动检测、单卡片手动切换三层控制。 |
| 2 | 为适配 Markdown 渲染功能，将默认提示词替换，要求对于专业术语后用括号标注原文、输出结果用 Markdown 格式。涉及 OpenAI、Ollama、Gemini、ChatGLM 共 6 处默认 system prompt。 |
| 3 | 新增服务级「自动翻译」开关。在服务设置列表中，每个翻译服务实例旁新增一个开关（琥珀色电源图标），控制该服务是否在翻译窗口弹出时自动调用翻译。关闭后服务卡片仍显示，需手动点击「点击翻译」按钮触发。原有的显示开关保持不变。 |
| 4 | 修改应用名为 pot-MD 和版本号（3.0.7-MD.5），使与原版区分。 |
| 5 | **划词弹窗（Selection Popup）**：选中文本后弹出小巧翻译卡片。首次启动自动写入默认快捷键（划词翻译 Alt+A / 输入翻译 Alt+D / 文字识别 Alt+Q / 截图 Alt+S）；弹窗采用 CSS 大圆角 + 磨砂模糊 + 白色描边卡片形态（无黑边）；鼠标离弹窗越近越清晰、越远离越透明，超出阈值自动隐藏；弹窗「翻译」按钮模拟用户绑定快捷键，与手动按快捷键完全等价。 |

## 更新日志
| 版本号 | 更新内容 |
|---|---|
| 3.0.7-MD.5 | 新增划词弹窗（Selection Popup）：选中文本后弹出小巧翻译卡片，支持翻译/复制；首次启动自动写入默认快捷键（划词翻译 Alt+A / 输入翻译 Alt+D / 文字识别 Alt+Q / 截图 Alt+S）；鼠标离弹窗越近越清晰、越远离越透明，超出阈值自动隐藏；弹窗采用 CSS 大圆角 + 磨砂模糊 + 白色描边卡片形态（无黑边，背景更实）；弹窗「翻译」按钮模拟用户绑定快捷键，与手动按快捷键完全等价；更新 README 下载区与 CHANGELOG |


## 下载安装

### 最新版本（3.0.7-MD.5）

> 划词弹窗优化：默认快捷键、CSS 圆角磨砂卡片、鼠标渐远渐透明。

- Windows 安装包: [`pot-MD_3.0.7-MD.5_x64-setup.exe`](https://github.com/WalterMitty2005/pot-MD/releases/download/v3.0.7-MD.5/pot-MD_3.0.7-MD.5_x64-setup.exe)（NSIS 安装包）
- 绿色版: [`pot-MD_3.0.7-MD.5_x64.exe`](https://github.com/WalterMitty2005/pot-MD/releases/download/v3.0.7-MD.5/pot-MD_3.0.7-MD.5_x64.exe)（免安装，直接运行）

### 历史版本（3.0.7-MD.4）

- 前往 [GitHub Releases](https://github.com/WalterMitty2005/pot-MD/releases) 页面下载 MD.4 版本（保持原有包不变）。

> 完整变更记录见 [CHANGELOG](./CHANGELOG)。

## 技术细节

### Markdown 渲染

- 新增 `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `rehype-highlight` 依赖
- 新增 `Markdown.jsx` 组件与 `Markdown.css` 样式（支持暗色主题）
- `looksLikeMarkdown()` 启发式函数自动检测翻译结果是否包含 Markdown 语法
- 复制 / TTS / 回译 / 历史记录均保留原始 Markdown 源文本

### 自动翻译开关

- 存储键: `service_auto_translate@<实例key>`，默认开启
- 开关位于 `ServiceItem` 行组件（每行独立挂载，避免 React Hook 闭包陷阱）
- 关闭后翻译窗口的 `TargetArea` 跳过自动 `translate()` 调用，显示「点击翻译」按钮

### 默认提示词

```
Perform translation on the input text. Generate natural, fluent sentences and avoid stiff robotic writing.
Follow all mandatory rules strictly:
Present the full translated content in Markdown format, retain original layout including paragraphs and lists.
Keep all mathematical symbols and special notations unchanged. Format all mathematical expressions with Markdown LaTeX: use $...$ for inline formulas and $$...$$ for display formulas. Never convert formulas into plain text.
Accurately translate professional terms. Attach the original source term in parentheses right after each translated professional term. Do not omit this requirement.
Do not add extra explanations, do not distort original meaning, and do not omit any content.
Self-check your output thoroughly. If any rule is violated, regenerate the result until all requirements are satisfied.
```

## 许可证

[GPL-3.0](./LICENSE)

## 原项目说明

原版 pot 的完整文档请参阅 [README.md](./README.md)。
