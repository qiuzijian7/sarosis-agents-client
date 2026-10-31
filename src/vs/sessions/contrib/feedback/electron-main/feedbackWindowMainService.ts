/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFeedbackWindowResult, IFeedbackWindowService } from '../common/feedbackWindow.js';

// eslint-disable-next-line local/code-import-patterns
import { BrowserWindow } from 'electron';
// eslint-disable-next-line local/code-import-patterns
import type { Debugger } from 'electron';

/** 等问卷渲染出上传控件的上限（问卷是 SPA，`did-finish-load` 之后才开始画题）。 */
const WAIT_INPUT_MS = 15000;
const POLL_MS = 400;

/**
 * 在页面里定位「日志文件」题那个 `<input type=file>` 的下标。
 *
 * ⚠ 问卷里两个上传题（「日志文件」/「问题截图」）的 input **id 都叫 `attachment-upload`**
 *   （飞书自己的重复 id）⇒ 只能按题名找：往上最多 6 层祖先，文本含「日志」即命中。
 *   找不到就退回 0（问卷里日志题排在截图题之前）。
 */
const FIND_LOG_INPUT_EXPRESSION = `(() => {
	const els = Array.from(document.querySelectorAll('input[type=file]'));
	const hit = els.findIndex(el => {
		let p = el.parentElement;
		for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
			if ((p.innerText || '').indexOf('日志') >= 0) { return true; }
		}
		return false;
	});
	return hit >= 0 ? hit : 0;
})()`;

/**
 * 反馈窗口的**主进程**实现（2026-10-31）。
 *
 * 一个独立 BrowserWindow：加载问卷 → CDP 把诊断文件填进「日志文件」题 → 显示并聚焦。
 * 单例：重复点反馈复用同一个窗口（不会开出一串）。
 */
export class FeedbackWindowMainService extends Disposable implements IFeedbackWindowService {
	declare readonly _serviceBrand: undefined;

	private _window: BrowserWindow | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async openFeedbackWindow(url: string, files: readonly string[]): Promise<IFeedbackWindowResult> {
		let win: BrowserWindow;
		try {
			win = this._ensureWindow();
			await win.loadURL(url);
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this._logService.warn(`[feedbackWindow] 打开反馈窗口失败：${error}`);
			return { ok: false, error };
		}

		// ★ 填附件失败**也要把窗口显示出来**：用户至少还能手动传、纯文字反馈。
		//   （曾经写成"填完才 show" ⇒ 附件一失败窗口就永远不出来，等于"点了没反应"）
		let filesFilled = false;
		let fillError: string | undefined;
		if (files.length) {
			try {
				await this._fillFiles(win, files);
				filesFilled = true;
			} catch (e) {
				fillError = e instanceof Error ? e.message : String(e);
				this._logService.warn(`[feedbackWindow] 自动挂诊断文件失败：${fillError}`);
			}
		}

		// ★ 先填后显：顺利的话，用户看到的第一个画面就是"日志已挂上"
		win.show();
		win.focus();
		return { ok: true, filesFilled, error: fillError };
	}

	override dispose(): void {
		this._window = undefined;
		super.dispose();
	}

	private _ensureWindow(): BrowserWindow {
		const existing = this._window;
		if (existing && !existing.isDestroyed()) {
			return existing;
		}
		const win = new BrowserWindow({
			width: 960,
			height: 880,
			title: '意见反馈',
			show: false,
			autoHideMenuBar: true,
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				spellcheck: false,
			},
		});
		this._window = win;
		win.once('closed', () => {
			if (this._window === win) { this._window = undefined; }
		});
		this._register(toDisposable(() => {
			if (this._window === win) { this._window = undefined; }
			if (!win.isDestroyed()) { win.destroy(); }
		}));
		return win;
	}

	/** 用 CDP 填文件 —— 等价于用户点「添加本地文件」选中它们。 */
	private async _fillFiles(win: BrowserWindow, files: readonly string[]): Promise<void> {
		const dbg = win.webContents.debugger;
		const attachedHere = !dbg.isAttached();
		if (attachedHere) { dbg.attach('1.3'); }
		try {
			const nodeId = await this._waitForLogInput(dbg);
			await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [...files] });
			this._logService.info(`[feedbackWindow] 已填入 ${files.length} 个诊断文件`);
		} finally {
			if (attachedHere && dbg.isAttached()) { dbg.detach(); }
		}
	}

	/** 轮询等问卷画出上传控件，返回「日志文件」题那一个的 nodeId。 */
	private async _waitForLogInput(dbg: Debugger): Promise<number> {
		const deadline = Date.now() + WAIT_INPUT_MS;
		for (; ;) {
			const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root?: { nodeId: number } };
			const rootId = doc.root?.nodeId;
			if (typeof rootId === 'number') {
				const found = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: rootId, selector: 'input[type=file]' }) as { nodeIds?: number[] };
				if (found.nodeIds?.length) {
					const idx = await this._logInputIndex(dbg);
					return found.nodeIds[Math.min(Math.max(idx, 0), found.nodeIds.length - 1)];
				}
			}
			if (Date.now() > deadline) {
				throw new Error('问卷里始终没有出现上传控件');
			}
			await timeout(POLL_MS);
		}
	}

	private async _logInputIndex(dbg: Debugger): Promise<number> {
		const evaluated = await dbg.sendCommand('Runtime.evaluate', {
			expression: FIND_LOG_INPUT_EXPRESSION,
			returnByValue: true,
		}) as { result?: { value?: unknown } };
		return typeof evaluated.result?.value === 'number' ? evaluated.result.value : 0;
	}
}
