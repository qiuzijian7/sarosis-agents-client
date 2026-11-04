/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFeedbackWindowResult, IFeedbackWindowService } from '../common/feedbackWindow.js';

// eslint-disable-next-line local/code-import-patterns
import { app, BrowserWindow } from 'electron';
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

/** 极简 HTML 转义（`text` 目前是内部常量，但不给注入留口子）。 */
function escapeHtml(s: string): string {
	const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
	return s.replace(/[&<>"]/g, c => map[c] ?? c);
}

/**
 * 本地 loading 页（纯 HTML + CSS，**不含脚本** ⇒ 不必放宽任何沙箱设置）。
 *
 * 用 `data:` URL 而不是先 loadURL 到远端：远端要等网络（WAF/首屏 1~3s），
 * 而用户点完按钮最需要的是"立刻有反应"。
 */
function toDataUrl(text: string): string {
	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
	html,body{height:100%;margin:0;background:#1f1f1f;color:#e6e6e6;
		font:14px/1.7 "Segoe UI",system-ui,-apple-system,sans-serif;
		display:flex;align-items:center;justify-content:center}
	.box{text-align:center;max-width:520px;padding:0 24px}
	.spin{width:30px;height:30px;margin:0 auto 18px;border:3px solid #3a3a3a;
		border-top-color:#4ea1ff;border-radius:50%;animation:s .9s linear infinite}
	@keyframes s{to{transform:rotate(360deg)}}
	.t{font-size:15px}
	.tip{margin-top:8px;color:#9a9a9a;font-size:12px}
</style></head><body><div class="box">
	<div class="spin"></div>
	<div class="t">${escapeHtml(text)}</div>
	<div class="tip">正在本机收集诊断日志，完成后会自动打开问卷（无需操作）</div>
</div></body></html>`;
	return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

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

	async showLoading(text: string): Promise<void> {
		try {
			const win = this._ensureWindow();
			await win.loadURL(toDataUrl(text));
			win.show();
			win.focus();
		} catch (e) {
			// 只是没有 loading 页 ⇒ 不影响之后的 openFeedbackWindow
			this._logService.warn('[feedbackWindow] 显示加载页失败', e);
		}
	}

	async openFeedbackWindow(url: string, files: readonly string[]): Promise<IFeedbackWindowResult> {
		// ★ 入口就打点：这是"主进程到底有没有被调用"的唯一判据（渲染层失败是静默的）
		this._logService.info(`[feedbackWindow] 收到打开请求：files=${files.length}，url 前 90 字符 = ${url.slice(0, 90)}`);

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

	/**
	 * 系统快照（主进程视角）。
	 *
	 * ⚠ 任何一段失败都只是少一行，**绝不抛** —— 诊断包不能因为拿不到磁盘信息就整体失败
	 *  （2026-11-02 已经因为一个 `Buffer` 未定义白跑了两轮真机）。
	 */
	async collectSystemInfo(): Promise<readonly string[]> {
		const lines: string[] = [];
		const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
		const mb = (n: number) => (n / 1024 ** 2).toFixed(0);

		try {
			// eslint-disable-next-line local/code-import-patterns
			const os = await import('node:os');
			const total = os.totalmem();
			const free = os.freemem();
			lines.push(`内存        : 空闲 ${gb(free)} / 总计 ${gb(total)} GB（已用 ${(100 * (1 - free / total)).toFixed(1)}%）`);
			lines.push(`CPU         : ${os.cpus().length} 核  loadavg=${os.loadavg().map(n => n.toFixed(2)).join(' ')}`);
			lines.push(`系统        : ${os.platform()} ${os.arch()}  uptime=${(os.uptime() / 3600).toFixed(1)}h`);
		} catch (e) {
			lines.push('（内存/CPU 采集失败：' + (e instanceof Error ? e.message : String(e)) + '）');
		}

		try {
			const mu = process.memoryUsage();
			lines.push(`主进程内存  : rss=${mb(mu.rss)}MB  heap=${mb(mu.heapUsed)}MB`);
		} catch { /* 忽略 */ }

		try {
			// eslint-disable-next-line local/code-import-patterns
			const fs = await import('node:fs');
			const stat = await fs.promises.statfs(app.getPath('userData'));
			const totalB = stat.blocks * stat.bsize;
			const freeB = stat.bavail * stat.bsize;
			lines.push(`磁盘(userData): 空闲 ${gb(freeB)} / 总计 ${gb(totalB)} GB`);
		} catch {
			lines.push('磁盘(userData): （statfs 不可用）');
		}

		return lines;
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
