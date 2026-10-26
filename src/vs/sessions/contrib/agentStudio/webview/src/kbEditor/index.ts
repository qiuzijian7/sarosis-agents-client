/*
 * Markdown 编辑器（CodeMirror 6）—— **独立 bundle**，只在进入编辑态时按需加载。
 *
 * 为什么独立：侧栏是常驻视图，不能为了"偶尔编辑一下"把 180KB 编辑器塞进主 bundle。
 *   宿主（dsh 面板 / 插件页）通过 `<script src="/x/kb/web/kbEditor.js">` 按需拉取；
 *   拿不到（IDE webview 没有这条 HTTP 路由）⇒ 视图自动退回 textarea，功能不丢。
 *
 * 依赖来源：`vendor-codemirror/`（2026-10-26 从本地 code-server 依赖树复制，离线可用）。
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

/** 主题：全部走 VS Code / dsh 的 CSS 变量 ⇒ 三端自动跟随配色 */
const kbTheme = EditorView.theme(
	{
		'&': { color: 'var(--vscode-editor-foreground, #ddd)', backgroundColor: 'var(--vscode-editor-background, #1e1e1e)', height: '100%' },
		'.cm-content': { fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '12.5px', lineHeight: '1.7', caretColor: 'var(--vscode-editorCursor-foreground, #ddd)' },
		'.cm-scroller': { overflow: 'auto' },
		'&.cm-focused': { outline: 'none' },
		'.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--vscode-descriptionForeground, #888)' },
		'.cm-activeLine': { backgroundColor: 'rgba(127,127,127,.08)' },
	},
	{ dark: true },
);

export interface MountOptions {
	/** 正文变化（用于 dirty 标记与保存） */
	onChange?: (value: string) => void;
	/** Ctrl/Cmd+S */
	onSave?: () => void;
	/** Esc（返回 true 表示已处理，不再向上冒泡） */
	onEscape?: () => void;
}

export interface EditorHandle {
	getValue(): string;
	setValue(value: string): void;
	focus(): void;
	destroy(): void;
}

const HOTKEYS = [
	{ key: 'Mod-s', run: () => { currentSave?.(); return true; } },
	{ key: 'Escape', run: () => { currentEscape?.(); return true; } },
];

// 热键回调是"当前挂载实例"的 —— 页面里同一时刻只有一个编辑框
let currentSave: (() => void) | null = null;
let currentEscape: (() => void) | null = null;

/**
 * 把编辑器挂到容器里。
 * @returns 句柄（`destroy()` 必须调用，否则 CodeMirror 的事件监听会残留）
 */
export function mountMarkdownEditor(container: HTMLElement, initial: string, options: MountOptions = {}): EditorHandle {
	currentSave = () => options.onSave?.();
	currentEscape = () => options.onEscape?.();

	const view = new EditorView({
		parent: container,
		state: EditorState.create({
			doc: initial,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				history(),
				markdown({ base: markdownLanguage, codeLanguages: [] }),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				keymap.of([
					...HOTKEYS,
					// Enter 续写列表（官方命令，语义与 Obsidian 一致；空条目回车会跳出列表）
					{ key: 'Enter', run: insertNewlineContinueMarkup },
					...defaultKeymap,
					...historyKeymap,
					indentWithTab,
				]),
				kbTheme,
				EditorView.updateListener.of(u => {
					if (u.docChanged) { options.onChange?.(u.state.doc.toString()); }
				}),
			],
		}),
	});

	return {
		getValue: () => view.state.doc.toString(),
		setValue: (value: string) => {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		},
		focus: () => view.focus(),
		destroy: () => {
			currentSave = null;
			currentEscape = null;
			view.destroy();
		},
	};
}

// 供宿主按需加载后调用（`<script>` 无模块系统，只能走全局）
declare global {
	interface Window {
		__KB_EDITOR_MOUNT__?: typeof mountMarkdownEditor;
		__KB_EDITOR_READY__?: boolean;
	}
}
if (typeof window !== 'undefined') {
	window.__KB_EDITOR_MOUNT__ = mountMarkdownEditor;
	window.__KB_EDITOR_READY__ = true;
}
