/*---------------------------------------------------------------------------------------------
 *  WorkflowVersionPanel — 工作流编辑器右侧版本历史侧边面板。
 *
 *  提供：
 *    - commit 列表（SHA / 时间 / 消息）
 *    - 点击行展开 unified diff 预览
 *    - 每行「回滚到此版本」按钮
 *    - 关闭按钮
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { IWorkflowVersionService, type WorkflowCommitMeta } from '../common/workflowVersionTypes.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export class WorkflowVersionPanel extends Disposable {
	readonly element: HTMLElement;
	private _visible = false;
	private _loading = false;
	private _commits: WorkflowCommitMeta[] = [];

	private readonly _listContainer!: HTMLElement;

	constructor(
		private readonly _workflowId: string,
		@IWorkflowVersionService private readonly _versionService: IWorkflowVersionService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		this.element = $('div.workflow-version-panel');
		this.element.style.width = '0';
		this.element.style.overflow = 'hidden';
		this.element.style.transition = 'width 0.2s ease';
		this.element.style.borderLeft = '1px solid var(--vscode-panel-border)';
		this.element.style.background = 'var(--vscode-sideBar-background, #252526)';
		this.element.style.display = 'flex';
		this.element.style.flexDirection = 'column';
		this.element.style.fontSize = '12px';

		// ── 标题栏 ──
		const header = $('div');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.padding = '8px 12px';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';
		header.style.flexShrink = '0';

		const title = $('span');
		title.textContent = '版本历史';
		title.style.fontWeight = '700';
		title.style.flex = '1';
		header.appendChild(title);

		// 刷新按钮
		const refreshBtn = $('button') as HTMLButtonElement;
		refreshBtn.textContent = '🔄';
		refreshBtn.title = '刷新';
		refreshBtn.style.background = 'transparent';
		refreshBtn.style.border = 'none';
		refreshBtn.style.color = 'var(--vscode-foreground)';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.style.fontSize = '14px';
		refreshBtn.style.padding = '0 6px';
		this._register(DOM.addDisposableListener(refreshBtn, 'click', () => void this._loadHistory()));
		header.appendChild(refreshBtn);

		// 关闭按钮
		const closeBtn = $('button') as HTMLButtonElement;
		closeBtn.textContent = '✕';
		closeBtn.title = '关闭';
		closeBtn.style.background = 'transparent';
		closeBtn.style.border = 'none';
		closeBtn.style.color = 'var(--vscode-foreground)';
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.fontSize = '14px';
		closeBtn.style.padding = '0 4px';
		this._register(DOM.addDisposableListener(closeBtn, 'click', () => this.hide()));
		header.appendChild(closeBtn);

		this.element.appendChild(header);

		// ── 列表区 ──
		this._listContainer = $('div.workflow-version-list');
		this._listContainer.style.flex = '1';
		this._listContainer.style.overflowY = 'auto';
		this._listContainer.style.padding = '8px';
		this.element.appendChild(this._listContainer);
	}

	// ── 可见性 ──

	get visible(): boolean { return this._visible; }

	show(): void {
		this.element.style.width = '420px';
		this._visible = true;
		if (this._commits.length === 0) {
			void this._loadHistory();
		}
	}

	hide(): void {
		this.element.style.width = '0';
		this._visible = false;
	}

	toggle(): void {
		if (this._visible) { this.hide(); } else { this.show(); }
	}

	// ── 数据加载 ──

	private async _loadHistory(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;

		// 清空列表显示加载中
		this._listContainer.textContent = '';
		const loadingEl = $('div');
		loadingEl.textContent = '加载版本历史...';
		loadingEl.style.padding = '16px';
		loadingEl.style.textAlign = 'center';
		loadingEl.style.color = 'var(--vscode-descriptionForeground)';
		this._listContainer.appendChild(loadingEl);

		try {
			this._commits = await this._versionService.history(this._workflowId, 50);
			this._renderCommitList();
		} catch (err) {
			this._listContainer.textContent = '';
			const errEl = $('div');
			errEl.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
			errEl.style.padding = '16px';
			errEl.style.color = 'var(--vscode-errorForeground)';
			errEl.style.textAlign = 'center';
			this._listContainer.appendChild(errEl);
		} finally {
			this._loading = false;
		}
	}

	private _renderCommitList(): void {
		this._listContainer.textContent = '';

		if (this._commits.length === 0) {
			const empty = $('div');
			empty.textContent = '暂无版本历史';
			empty.style.padding = '16px';
			empty.style.textAlign = 'center';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			this._listContainer.appendChild(empty);
			return;
		}

		const countEl = $('div');
		countEl.textContent = `共 ${this._commits.length} 条记录`;
		countEl.style.color = 'var(--vscode-descriptionForeground)';
		countEl.style.fontSize = '11px';
		countEl.style.marginBottom = '8px';
		this._listContainer.appendChild(countEl);

		for (const c of this._commits) {
			this._listContainer.appendChild(this._renderCommitRow(c));
		}
	}

	private _renderCommitRow(c: WorkflowCommitMeta): HTMLElement {
		const row = $('div.commit-row');
		row.style.padding = '8px';
		row.style.marginBottom = '4px';
		row.style.border = '1px solid var(--vscode-panel-border)';
		row.style.borderRadius = '4px';
		row.style.cursor = 'pointer';
		row.style.transition = 'background 0.15s';

		// ── 头部：SHA + 时间 ──
		const head = $('div');
		head.style.display = 'flex';
		head.style.justifyContent = 'space-between';
		head.style.alignItems = 'center';
		head.style.marginBottom = '4px';

		const sha = $('code');
		sha.textContent = c.shortSha;
		sha.style.fontSize = '11px';
		sha.style.fontFamily = 'monospace';
		sha.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		sha.style.color = 'var(--vscode-badge-foreground, #fff)';
		sha.style.padding = '1px 5px';
		sha.style.borderRadius = '3px';
		head.appendChild(sha);

		const time = $('span');
		time.textContent = this._formatTime(c.time);
		time.style.fontSize = '10px';
		time.style.color = 'var(--vscode-descriptionForeground)';
		head.appendChild(time);
		row.appendChild(head);

		// ── 消息 ──
		const msg = $('div');
		msg.textContent = c.message;
		msg.style.fontSize = '11px';
		msg.style.color = 'var(--vscode-foreground)';
		msg.style.marginBottom = '6px';
		row.appendChild(msg);

		// ── 折叠区：diff + 操作 ──
		const detail = $('div.commit-detail');
		detail.style.display = 'none';
		detail.style.marginTop = '6px';
		row.appendChild(detail);

		// Diff 文本
		const diffPre = $('pre');
		diffPre.style.fontSize = '10px';
		diffPre.style.fontFamily = 'monospace';
		diffPre.style.padding = '6px';
		diffPre.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		diffPre.style.borderRadius = '3px';
		diffPre.style.maxHeight = '250px';
		diffPre.style.overflowY = 'auto';
		diffPre.style.whiteSpace = 'pre-wrap';
		diffPre.style.wordBreak = 'break-all';
		diffPre.style.margin = '0';
		detail.appendChild(diffPre);

		// 操作按钮
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '6px';
		actions.style.marginTop = '6px';
		detail.appendChild(actions);

		const rollbackBtn = $('button') as HTMLButtonElement;
		rollbackBtn.textContent = '回滚到此版本';
		rollbackBtn.style.background = 'var(--vscode-inputValidation-warningBackground, #352a05)';
		rollbackBtn.style.border = '1px solid var(--vscode-inputValidation-warningBorder, #b89500)';
		rollbackBtn.style.color = 'var(--vscode-inputValidation-warningForeground, #ccc)';
		rollbackBtn.style.padding = '3px 8px';
		rollbackBtn.style.borderRadius = '3px';
		rollbackBtn.style.cursor = 'pointer';
		rollbackBtn.style.fontSize = '11px';
		this._register(DOM.addDisposableListener(rollbackBtn, 'click', (e) => {
			e.stopPropagation();
			void this._handleRollback(c.sha);
		}));
		actions.appendChild(rollbackBtn);

		// ── 点击展开/收起 diff ──
		let loaded = false;
		const self = this;
		this._register(DOM.addDisposableListener(row, 'click', async () => {
			if (detail.style.display === 'block') {
				detail.style.display = 'none';
				return;
			}
			if (loaded) {
				detail.style.display = 'block';
				return;
			}
			detail.style.display = 'block';
			diffPre.textContent = '加载 diff...';
			try {
				const result = await self._versionService.diff(self._workflowId, c.sha);
				diffPre.textContent = result?.unified || '无差异数据';
				// 简易颜色化：+绿 -红
				self._colorizeDiff(diffPre);
			} catch (err) {
				diffPre.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
			}
			loaded = true;
		}));

		// hover 效果
		this._register(DOM.addDisposableListener(row, 'mouseenter', () => {
			row.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)';
		}));
		this._register(DOM.addDisposableListener(row, 'mouseleave', () => {
			row.style.background = '';
		}));

		return row;
	}

	// ── 回滚 ──

	private async _handleRollback(sha: string): Promise<void> {
		try {
			await this._versionService.rollback(this._workflowId, sha);
			this._notificationService.info(`工作流已回滚到版本 ${sha.slice(0, 7)}（请手动保存以生效）`);
			this._loadHistory(); // 刷新列表
		} catch (err) {
			this._notificationService.error(`回滚失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 辅助 ──

	private _formatTime(iso: string): string {
		try {
			const d = new Date(iso);
			return d.toLocaleString('zh-CN', {
				month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit',
			});
		} catch { return iso.slice(0, 16); }
	}

	private _colorizeDiff(pre: HTMLElement): void {
		const text = pre.textContent || '';
		const lines = text.split('\n');
		pre.textContent = '';
		for (const line of lines) {
			const span = $('span');
			if (line.startsWith('+') && !line.startsWith('+++')) {
				span.style.color = 'var(--vscode-testing-iconPassed, #73c991)';
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				span.style.color = 'var(--vscode-testing-iconFailed, #f14c4c)';
			} else if (line.startsWith('@@')) {
				span.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			}
			span.textContent = line + '\n';
			pre.appendChild(span);
		}
	}
}

// ─── DOM helper ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/naming-convention
const DOM = {
	addDisposableListener: (el: HTMLElement, event: string, handler: (e: any) => void) => {
		el.addEventListener(event, handler);
		return { dispose: () => el.removeEventListener(event, handler) };
	},
};
