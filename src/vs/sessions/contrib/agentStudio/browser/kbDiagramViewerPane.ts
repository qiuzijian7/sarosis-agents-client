/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbDiagramViewerPane.ts — 图表文件（.drawio / .mermaid / .mmd）的编辑器面板。
 *
 *  背景（2026-09-24 用户反馈）：库里点击 .mermaid / .drawio 文件没有对应的编辑器面板
 *  （它们不在 TEXT_EXTS、也没有注册 editor ⇒ 落到 openExternal，系统里多半没有关联程序，
 *  表现为「点了没反应」）。本面板提供：
 *
 *    · 「预览」：用宿主既有的隐藏渲染引擎（IMermaidInlineRenderer / IDrawioInlineRenderer，
 *      与聊天图表卡片同一引擎）渲染成 SVG 展示；
 *    · 「源码」：textarea 直接编辑源文本，Ctrl+S / 保存按钮落盘，保存后自动重渲染；
 *      编辑过程中防抖预览（不保存也能先看效果）。
 *
 *  SVG 注入走 DOMParser + adoptNode（不碰 innerHTML，规避主窗口 TrustedTypes）；
 *  插入前剥掉 on* 事件属性（渲染引擎产出本就不含脚本，这是纵深防御）。
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IMermaidInlineRenderer } from './mermaidInlineRenderer.js';
import { IDrawioInlineRenderer } from './drawioInlineRenderer.js';
import { KbDiagramViewerInput, diagramKindOfPath } from './kbDiagramViewerInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

const $ = DOM.$;

/** SVG 字符串的轻量消毒：去掉脚本块与事件属性（渲染引擎产出本就不含，纵深防御）。 */
function sanitizeSvgString(svg: string): string {
	return svg
		.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '')
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** 摘掉插入后仍残留的 on* 事件属性（innerHTML 插入不会执行脚本，但事件处理器会生效）。 */
function stripEventHandlers(root: Element): void {
	for (const attr of [...root.attributes]) {
		if (attr.name.toLowerCase().startsWith('on')) { root.removeAttribute(attr.name); }
	}
	for (const child of [...root.children]) { stripEventHandlers(child); }
}

/**
 * TrustedTypes 策略（主窗口强制要求）—— 与聊天 drawio/mermaid 卡片同款做法：
 * 产物来自自家渲染引擎，策略本身做恒等转换，只负责把它标为可信以通过 TT 校验。
 */
// ⚠ 策略名必须登记在 CSP 的 `trusted-types` 白名单（sessions.html / sessions-dev.html），
//   否则 createPolicy 会被 CSP 直接拒（2026-09-24 实测踩坑）。
const _svgTtPolicy = createTrustedTypesPolicy('kbDiagramViewerSvg', { createHTML: (s: string) => s });

export class KbDiagramViewerPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbDiagramViewer';

	private _container: HTMLElement | undefined;
	private _previewEl: HTMLElement | undefined;
	private _sourceEl: HTMLTextAreaElement | undefined;
	private _saveBtn: HTMLButtonElement | undefined;
	private _statusEl: HTMLElement | undefined;

	private _diagramInput: KbDiagramViewerInput | undefined;
	private _mode: 'preview' | 'source' = 'preview';
	private _dirty = false;
	private _renderSeq = 0;
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IMermaidInlineRenderer private readonly _mermaidRenderer: IMermaidInlineRenderer,
		@IDrawioInlineRenderer private readonly _drawioRenderer: IDrawioInlineRenderer,
	) {
		super(KbDiagramViewerPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = DOM.append(parent, $('.kb-diagram-viewer'));
		this._container.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;';

		// ── 工具栏：预览 / 源码 切换 + 保存 ──
		const toolbar = DOM.append(this._container, $('div'));
		toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border,#333);flex:0 0 auto;';
		const mkBtn = (label: string, title: string): HTMLButtonElement => {
			const b = DOM.append(toolbar, $('button')) as HTMLButtonElement;
			b.textContent = label;
			b.title = title;
			b.style.cssText = 'padding:3px 12px;border:1px solid var(--vscode-panel-border,#444);border-radius:4px;background:transparent;color:var(--vscode-foreground);cursor:pointer;font-size:12px;';
			return b;
		};
		const previewBtn = mkBtn('预览', '渲染为图');
		const sourceBtn = mkBtn('源码', '编辑源文本（Ctrl+S 保存）');
		this._saveBtn = mkBtn('保存', '保存到文件（Ctrl+S）');
		this._saveBtn.disabled = true;
		this._statusEl = DOM.append(toolbar, $('span'));
		this._statusEl.style.cssText = 'margin-left:auto;font-size:11px;opacity:.7;';

		previewBtn.onclick = () => this._setMode('preview');
		sourceBtn.onclick = () => this._setMode('source');
		this._saveBtn.onclick = () => void this._save();

		// ── 预览区 / 源码区 ──
		this._previewEl = DOM.append(this._container, $('div'));
		this._previewEl.style.cssText = 'flex:1 1 0;min-height:0;overflow:auto;padding:16px;display:flex;justify-content:center;align-items:flex-start;';
		this._sourceEl = DOM.append(this._container, $('textarea')) as HTMLTextAreaElement;
		this._sourceEl.style.cssText = 'flex:1 1 0;min-height:0;display:none;resize:none;border:0;outline:none;padding:12px;font-family:var(--monaco-monospace-font,monospace);font-size:12px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);';
		this._sourceEl.spellcheck = false;
		this._sourceEl.addEventListener('input', () => {
			this._dirty = true;
			if (this._saveBtn) { this._saveBtn.disabled = false; }
			this._setStatus('未保存');
			// 防抖预览（不保存也先看效果）
			if (this._renderTimer) { clearTimeout(this._renderTimer); }
			this._renderTimer = setTimeout(() => void this._renderPreview(), 600);
		});
		this._sourceEl.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				void this._save();
			}
		});
	}

	override async setInput(input: KbDiagramViewerInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._inputDisposables.clear();
		this._diagramInput = input;
		this._dirty = false;
		if (this._saveBtn) { this._saveBtn.disabled = true; }
		let text = '';
		try {
			text = (await this._fileService.readFile(input.resource)).value.toString();
		} catch (err) {
			this._setStatus(`读取失败：${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (this._sourceEl) { this._sourceEl.value = text; }
		this._setMode('preview');
		await this._renderPreview();
	}

	private _setMode(mode: 'preview' | 'source'): void {
		this._mode = mode;
		if (this._previewEl) { this._previewEl.style.display = mode === 'preview' ? 'flex' : 'none'; }
		if (this._sourceEl) { this._sourceEl.style.display = mode === 'source' ? 'block' : 'none'; }
	}

	private _setStatus(text: string): void {
		if (this._statusEl) { this._statusEl.textContent = text; }
	}

	/** 预览渲染：源文本 → 宿主渲染引擎 → SVG → 安全注入。 */
	private async _renderPreview(): Promise<void> {
		const input = this._diagramInput;
		const source = this._sourceEl?.value ?? '';
		if (!input || !this._previewEl) { return; }
		const seq = ++this._renderSeq;
		const kind = diagramKindOfPath(input.resource.path) ?? 'drawio';
		if (!source.trim()) {
			this._previewEl.textContent = '（空文件）';
			return;
		}
		this._setStatus('渲染中…');
		try {
			const dark = isDark(this.themeService.getColorTheme().type);
			const svg = kind === 'mermaid'
				? await this._mermaidRenderer.renderToSvg(source, dark ? 'dark' : 'default')
				: await this._drawioRenderer.renderToSvg(source, dark ? 'dark' : 'default');
			if (seq !== this._renderSeq) { return; } // 期间又改了源码 ⇒ 丢弃过期结果
			this._injectSvg(svg);
			this._setStatus(this._dirty ? '未保存（预览为编辑中内容）' : '');
		} catch (err) {
			if (seq !== this._renderSeq) { return; }
			this._previewEl.textContent = `渲染失败：${err instanceof Error ? err.message : String(err)}（切换到「源码」检查语法）`;
			this._setStatus('渲染失败');
		}
	}

	/**
	 * SVG 注入（★ 2026-09-24 实测修正）：
	 *
	 * 主窗口启用了 TrustedTypes ⇒ **`DOMParser.parseFromString` 会被拦**（实测报错
	 * "This document requires 'TrustedHTML' assignment"），所以改用产品既有方式：
	 *   ① 先做字符串级消毒（移除 `<script>` / `on*` 事件属性；引擎产出本就不含，属纵深防御）；
	 *   ② 经 **TrustedTypes 策略**包装后赋给 innerHTML（与聊天 drawio/mermaid 卡片同款做法）；
	 *   ③ 插入后再走一遍 DOM，摘掉可能残留的事件属性（innerHTML 插入的脚本不会执行，但事件会挂上）。
	 */
	private _injectSvg(svgText: string): void {
		const el = this._previewEl;
		if (!el) { return; }
		const html = _svgTtPolicy ? _svgTtPolicy.createHTML(sanitizeSvgString(svgText)) as unknown as string : sanitizeSvgString(svgText);
		el.textContent = '';
		el.innerHTML = html;
		const svg = el.querySelector('svg');
		if (!svg) {
			el.textContent = '渲染结果不是有效 SVG';
			return;
		}
		stripEventHandlers(svg);
		svg.setAttribute('style', 'max-width:100%;height:auto;');
	}

	private async _save(): Promise<void> {
		const input = this._diagramInput;
		if (!input || !this._sourceEl) { return; }
		try {
			await this._fileService.writeFile(input.resource, VSBuffer.fromString(this._sourceEl.value));
			this._dirty = false;
			if (this._saveBtn) { this._saveBtn.disabled = true; }
			this._setStatus('已保存');
			this._logService.info(`[KbDiagramViewer] saved ${input.resource.toString()}`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this._setStatus(`保存失败：${reason}`);
			this._notificationService.error(`图表保存失败：${reason}`);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void { // overrides base Pane.focus
		(this._mode === 'source' ? this._sourceEl : this._previewEl)?.focus();
	}
}
