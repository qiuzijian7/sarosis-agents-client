/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 通用模态对话框工具（对齐 Visual Studio 的模态对话框 UI：标题 + 内容 + 按钮行 + Esc 关闭）。
 * 在 `.monaco-workbench` 顶层追加 fixed 定位的覆盖层（遮罩 + 内容居中）。
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';

export interface ICodebaseGraphModalOptions {
	/** 对话框标题（出现在标题栏中部）。 */
	title: string;
	/** 标题栏右侧的提示文本（用于 "Find Symbol [2 of 2397710]" 的计数）。可空。 */
	hint?: string;
	/** 宽度（默认 720）。 */
	width?: number;
	/** 高度（默认 480）。 */
	height?: number;
	/** 主内容区构造器（往 dialog.body 中追加自定义 UI）。 */
	renderBody: (body: HTMLElement) => void;
	/** OK 回调（用户点 OK 或在内容区按 Enter 选中时触发）。 */
	onOk?: () => void;
	/** Cancel 回调。 */
	onCancel?: () => void;
	/** OK 按钮文本（默认 "OK"）。 */
	okText?: string;
	/** Cancel 按钮文本（默认 "Cancel"）。 */
	cancelText?: string;
	/** 关闭时调用（点 X / Esc / Cancel / 遮罩点击）。 */
	onDispose?: () => void;
}

export class CodebaseGraphModal implements IDisposable {

	private _overlay!: HTMLElement;
	private _dialog!: HTMLElement;
	private _body!: HTMLElement;
	private _hintEl!: HTMLElement;
	/** 内容区顶部的通知条（无图自动建图 / 进度 / 失败原因），见 `setNotice`。 */
	private _noticeEl?: HTMLElement;
	private _disposables = new DisposableStore();
	private _okBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;
	private _closed = false;

	constructor(
		private readonly options: ICodebaseGraphModalOptions,
	) {
		this._build();
	}

	private _build(): void {
		const host = (document.querySelector('.monaco-workbench') as HTMLElement | null) ?? document.body;

		// 遮罩
		this._overlay = dom.$('div.codebase-graph-modal-overlay');
		this._overlay.style.cssText = [
			'position: fixed',
			'left: 0',
			'top: 0',
			'width: 100vw',
			'height: 100vh',
			'background: rgba(0, 0, 0, 0.35)',
			'z-index: 9999',
			'display: flex',
			'align-items: center',
			'justify-content: center',
		].join(';');

		// 对话框
		this._dialog = dom.$('div.codebase-graph-modal');
		const w = this.options.width ?? 720;
		const h = this.options.height ?? 480;
		this._dialog.style.cssText = [
			'background: var(--vscode-editorWidget-background)',
			'color: var(--vscode-editorWidget-foreground)',
			'border: 1px solid var(--vscode-editorWidget-border)',
			'box-shadow: 0 8px 32px rgba(0,0,0,0.5)',
			'width: ' + w + 'px',
			'max-width: 90vw',
			'height: ' + h + 'px',
			'max-height: 90vh',
			'min-width: 400px',
			'min-height: 240px',
			'display: flex',
			'flex-direction: column',
			'border-radius: 4px',
			'overflow: auto',
			'resize: both',
			'font-family: var(--vscode-font-family)',
			'font-size: 13px',
		].join(';');

		// 标题栏
		const titleBar = dom.$('div');
		titleBar.style.cssText = 'display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-editorWidget-border);';

		const titleGroup = dom.$('div');
		titleGroup.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;overflow:hidden;';

		const titleText = dom.$('span');
		titleText.textContent = this.options.title;
		titleText.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
		titleGroup.appendChild(titleText);

		if (this.options.hint !== undefined) {
			this._hintEl = dom.$('span');
			this._hintEl.textContent = this.options.hint;
			this._hintEl.style.cssText = 'color:var(--vscode-descriptionForeground);font-weight:normal;';
			titleGroup.appendChild(this._hintEl);
		}

		titleBar.appendChild(titleGroup);

		// 关闭按钮（X）
		const closeBtn = dom.$('button');
		closeBtn.textContent = '×';
		closeBtn.title = localize('codebaseGraph.modal.close', 'Close');
		closeBtn.style.cssText = 'background:transparent;border:none;color:var(--vscode-icon-foreground);font-size:18px;cursor:pointer;width:24px;height:24px;line-height:18px;';
		closeBtn.addEventListener('click', () => this._close('cancel'));
		titleBar.appendChild(closeBtn);

		this._dialog.appendChild(titleBar);

		// 内容区
		this._body = dom.$('div');
		this._body.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';
		this._dialog.appendChild(this._body);

		this.options.renderBody(this._body);

		// 按钮行
		const btnRow = dom.$('div');
		btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-editorWidget-border);background:var(--vscode-editorWidget-background);';

		this._cancelBtn = dom.$('button') as HTMLButtonElement;
		this._cancelBtn.textContent = this.options.cancelText ?? 'Cancel';
		this._cancelBtn.style.cssText = 'padding:4px 16px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border, transparent);cursor:pointer;border-radius:2px;';
		this._cancelBtn.addEventListener('click', () => this._close('cancel'));
		btnRow.appendChild(this._cancelBtn);

		this._okBtn = dom.$('button') as HTMLButtonElement;
		this._okBtn.textContent = this.options.okText ?? 'OK';
		this._okBtn.style.cssText = 'padding:4px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border, transparent);cursor:pointer;border-radius:2px;min-width:60px;';
		this._okBtn.addEventListener('click', () => this._close('ok'));
		btnRow.appendChild(this._okBtn);

		this._dialog.appendChild(btnRow);

		this._overlay.appendChild(this._dialog);
		host.appendChild(this._overlay);

		// 点遮罩关闭
		this._overlay.addEventListener('mousedown', (e) => {
			if (e.target === this._overlay) { this._close('cancel'); }
		});

		// Esc 关闭
		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { e.stopPropagation(); this._close('cancel'); }
		};
		document.addEventListener('keydown', keyHandler, true);
		this._disposables.add({ dispose: () => document.removeEventListener('keydown', keyHandler, true) });

		// 自动聚焦
		setTimeout(() => this._body.querySelector<HTMLInputElement>('input[data-modal-initial-focus]')?.focus(), 30);
	}

	/**
	 * 在内容区**顶部**显示/更新一条通知条（2026-09-15 新增）。
	 *
	 * 用途：Find Symbol / Open File 现在**无图也会打开**（不再静默 return），需要在 UI 内说明
	 * 状态 —— 「正在自动构建代码图谱」+ `onDidIndexProgress` 的进度行、构建结果、失败原因等。
	 * 传空串即隐藏（保持布局不跳动：元素保留、只切 display）。
	 */
	setNotice(text: string, kind: 'info' | 'progress' | 'success' | 'warn' | 'error' = 'info'): void {
		if (!this._noticeEl) {
			this._noticeEl = dom.$('div.codebase-graph-modal-notice');
			this._noticeEl.style.cssText = 'flex:0 0 auto;display:none;margin:10px 12px 0;padding:6px 10px;'
				+ 'border-radius:2px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;';
			// 插到内容区最前（搜索框之前），保证提示先于列表被看到
			this._body.insertBefore(this._noticeEl, this._body.firstChild);
		}
		this._noticeEl.style.display = text ? 'block' : 'none';
		this._noticeEl.textContent = text;
		const border = {
			info: 'var(--vscode-focusBorder)',
			progress: 'var(--vscode-focusBorder)',
			success: 'var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-focusBorder)))',
			warn: 'var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground))',
			error: 'var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground))',
		}[kind];
		const background = {
			info: 'var(--vscode-editorWidget-background)',
			progress: 'var(--vscode-editorWidget-background)',
			success: 'var(--vscode-editorWidget-background)',
			warn: 'var(--vscode-inputValidation-warningBackground)',
			error: 'var(--vscode-inputValidation-errorBackground)',
		}[kind];
		this._noticeEl.style.borderLeft = '3px solid ' + border;
		this._noticeEl.style.background = background;
		this._noticeEl.style.color = 'var(--vscode-editorWidget-foreground)';
	}

	private _close(reason: 'ok' | 'cancel'): void {
		if (this._closed) { return; }
		this._closed = true;
		if (reason === 'ok') { this.options.onOk?.(); }
		else { this.options.onCancel?.(); }
		this.dispose();
	}

	dispose(): void {
		if (this._overlay && this._overlay.parentElement) {
			this._overlay.parentElement.removeChild(this._overlay);
		}
		this._disposables.dispose();
		this.options.onDispose?.();
	}
}
