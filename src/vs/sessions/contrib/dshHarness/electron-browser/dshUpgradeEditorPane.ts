/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「系统与更新」面板（2026-10-30，IDE 侧）。
 *
 * 用户要求（原话）：
 *   · "IDE中，点开面板，手动点击检查升级" ⇒ 打开面板**不联网**，用户点「检查更新」才问更新源；
 *   · "手动点击升级后，在后台能够进行下载更新重启" ⇒ 点「一键升级」后由 `IDshHarnessService.upgradeApp()`
 *     在后台走「检查 → 比版本 → 下载 → 校验 → 安装并重启」，本面板只把 busy 文案显示出来。
 *
 * 数据**只有一份**：`getUpgradeState()` → 与 desktop 左下角那行共用 `_buildUpgradeState()`。
 * ⚠ 不要在这里自己比版本 / 自己读插件清单：那样"面板说有 3 项、行上写 2 项"必然出现 ✗。
 */

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDshHarnessService } from './dshHarnessService.js';
import { IDshUpgradeState } from '../common/dshPageBridgeProtocol.js';
import { DshUpgradeEditorInput } from './dshUpgradeEditorInput.js';

const KIND_LABEL: Record<string, string> = { skill: '技能', mcp: 'MCP', agent: '智能体', workflow: '工作流', workbench: '工作台' };
const KIND_ORDER = ['skill', 'mcp', 'agent', 'workflow', 'workbench'];
/** 与页面侧 `totalPending` 同口径：**可升级**的随包插件 + 可升级资产（不含"未安装"、不含应用）。 */
const upgradableBundled = (s: IDshUpgradeState | undefined) => (s?.bundled ?? []).filter(r => r.state === 'upgradable');
const pendingBundled = (s: IDshUpgradeState | undefined) => (s?.bundled ?? []).filter(r => r.state === 'upgradable' || r.state === 'missing');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (style) { Object.assign(node.style, style); }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

function actionButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
	const b = el('button', {
		padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', font: 'inherit', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
		color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
	}, label);
	b.onclick = onClick;
	return b;
}

export class DshUpgradeEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.dshUpgrade';

	private _root!: HTMLElement;
	private _body!: HTMLElement;
	private _footer!: HTMLElement;
	private _state: IDshUpgradeState | undefined;
	private _error: string | undefined;
	private _busy: string | undefined;
	private _refreshing = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super(DshUpgradeEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	override getControl(): DshUpgradeEditorPane {
		return this;
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = el('div', {
			width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
			overflow: 'hidden', color: 'var(--vscode-foreground)', fontSize: '13px',
			background: 'var(--vscode-editor-background)',
		});

		// ── 头部（标题 + 检查更新）──────────────────────────────────────────
		const header = el('div', {
			display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px',
			borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,.25))', flex: 'none',
		});
		header.appendChild(el('span', { fontWeight: '600', fontSize: '13px' }, '系统与更新'));
		header.appendChild(el('span', { flex: '1' }));
		const refreshBtn = actionButton('检查更新', false, () => void this._refresh(true));
		refreshBtn.dataset['action'] = 'check';
		header.appendChild(refreshBtn);
		this._root.appendChild(header);

		this._body = el('div', { flex: '1', overflow: 'auto', padding: '12px 16px' });
		this._root.appendChild(this._body);

		this._footer = el('div', {
			flex: 'none', padding: '6px 16px', fontSize: '11.5px',
			color: 'var(--vscode-descriptionForeground)',
			borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,.25))',
		});
		this._root.appendChild(this._footer);

		parent.appendChild(this._root);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof DshUpgradeEditorInput)) { return; }
		// ★ 打开面板**不联网**：先用缓存出首屏，"检查更新"是用户手动点的（用户原话）。
		await this._refresh(false);
	}

	override layout(dimension: Dimension): void {
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
	}

	// ── 数据 ────────────────────────────────────────────────────────────────

	private async _refresh(check: boolean): Promise<void> {
		if (this._refreshing) { return; }
		this._refreshing = true;
		this._error = undefined;
		this._footer.textContent = check ? '正在检查更新源…' : '正在读取…';
		try {
			this._state = await this._dsh.getUpgradeState(check);
		} catch (e) {
			this._error = String((e as Error)?.message ?? e);
		} finally {
			this._refreshing = false;
			this._render();
		}
	}

	/** 跑一条升级动作：期间禁用按钮，结束后重取状态（ui 立刻反映"已装 ✓"或失败原因）。 */
	private async _run(key: string, action: () => Promise<unknown>): Promise<void> {
		if (this._busy) { return; }
		this._busy = key;
		this._error = undefined;
		this._render();
		try {
			await action();
		} catch (e) {
			this._error = String((e as Error)?.message ?? e);
			this._notifications.notify({ severity: Severity.Error, message: `升级失败：${this._error}` });
		} finally {
			this._busy = undefined;
			await this._refresh(false);
		}
	}

	/**
	 * 「全部升级」：**顺序**跑可升级的随包插件 + `via === 'ide'` 的资产。
	 *
	 * ⚠ 必须串行：`dsh plugin add` 与商城安装都会动同一个 profile（并发 = pnpm 锁竞争 + 半装）。
	 * ⚠ 只跑"可升级"：未安装的不属于升级（各自点「安装」），应用有独立的一键升级按钮。
	 */
	private async _runAll(): Promise<void> {
		if (this._busy) { return; }
		const s = this._state;
		const bundled = upgradableBundled(s).map(r => ({ kind: 'bundled' as const, key: r.name, run: () => this._dsh.upgradeBundled(r.name) }));
		const assets = (s?.assets ?? []).filter(a => a.via === 'ide')
			.map(a => ({ kind: 'asset' as const, key: `${a.kind}/${a.name}`, run: () => this._dsh.upgradeAsset(a.kind, a.name) }));
		const jobs = [...bundled, ...assets];
		if (!jobs.length) { return; }
		this._busy = 'all';
		this._error = undefined;
		this._render();
		const failed: string[] = [];
		try {
			for (const job of jobs) {
				try {
					const r = await job.run() as { ok?: boolean; error?: string } | undefined;
					if (r && r.ok === false) { failed.push(`${job.key}：${r.error ?? '未知原因'}`); }
				} catch (e) {
					failed.push(`${job.key}：${String((e as Error)?.message ?? e)}`);
				}
			}
		} finally {
			this._busy = undefined;
			if (failed.length) {
				this._notifications.notify({ severity: Severity.Warning, message: `有 ${failed.length} 项没升成：${failed.slice(0, 3).join('；')}` });
			}
			await this._refresh(false);
		}
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	private _render(): void {
		if (!this._body) { return; }
		const s = this._state;
		const disabled = !!this._busy || !!s?.app?.busy;
		this._body.textContent = '';

		this._body.appendChild(this._renderApp(s, disabled));
		this._body.appendChild(this._renderBundled(s, disabled));
		this._body.appendChild(this._renderAssets(s, disabled));
		this._body.appendChild(this._renderRuntime(s));
		if (this._error) {
			this._body.appendChild(el('div', { marginTop: '10px', color: 'var(--vscode-errorForeground)', fontSize: '12px' }, this._error));
		}
		if (s?.error) {
			this._body.appendChild(el('div', { marginTop: '6px', color: 'var(--vscode-descriptionForeground)', fontSize: '11.5px' }, s.error));
		}

		const at = s?.at ? new Date(s.at).toLocaleTimeString() : '—';
		this._footer.textContent = this._busy
			? '升级进行中（后台执行，应用升级会自动重启）…'
			: `检查于 ${at}${s?.assetsNote ? ` · ${s.assetsNote}` : ''}${s?.app?.error ? ` · ${s.app.error}` : ''}`;
	}

	private _sectionTitle(text: string, right?: string | HTMLElement): HTMLElement {
		const row = el('div', {
			display: 'flex', alignItems: 'center', gap: '8px', margin: '16px 0 6px',
			fontSize: '11px', letterSpacing: '.03em', textTransform: 'uppercase',
			color: 'var(--vscode-descriptionForeground)',
		});
		row.appendChild(el('span', undefined, text));
		row.appendChild(el('span', { flex: '1' }));
		if (right) {
			row.appendChild(typeof right === 'string'
				? el('span', { textTransform: 'none', letterSpacing: '0' }, right)
				: right);
		}
		return row;
	}

	/** 一行：主文 + 次文 + 右侧控件。 */
	private _line(left: HTMLElement[], right: HTMLElement[]): HTMLElement {
		const row = el('div', {
			display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0',
			borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,.14))',
		});
		for (const n of left) { row.appendChild(n); }
		row.appendChild(el('span', { flex: '1' }));
		for (const n of right) { row.appendChild(n); }
		return row;
	}

	private _mono(text: string, dim = false): HTMLElement {
		return el('span', {
			fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '12px',
			color: dim ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-foreground)',
		}, text);
	}

	private _tag(text: string, warn = false): HTMLElement {
		return el('span', {
			fontSize: '10px', padding: '0 5px', borderRadius: '8px',
			border: `1px solid ${warn ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-panel-border, rgba(128,128,128,.35))'}`,
			color: warn ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-descriptionForeground)',
		}, text);
	}

	private _empty(text: string): HTMLElement {
		return el('div', { padding: '8px 0', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }, text);
	}

	private _renderApp(s: IDshUpgradeState | undefined, disabled: boolean): HTMLElement {
		const box = el('div');
		const app = s?.app;
		const busy = app?.busy;
		const text = busy === 'checking' ? '正在检查更新源…'
			: busy === 'downloading' ? '下载中…（后台）'
				: busy === 'installing' ? '正在安装，马上重启…'
					: app?.action === 'upgrade' && app.remote ? `可升级到 ${app.remote}`
						: app?.action === 'downgrade' ? `已是最新（更新源 ${app.remote ?? '?'} 更旧，不降级）`
							: app?.action === 'uptodate' ? '已是最新'
								: (app?.error ? '检查失败' : '还没检查');

		box.appendChild(this._sectionTitle('应用（IDE）', this._busy === 'app' ? '升级进行中…' : undefined));
		const appBtn = actionButton(
			busy === 'downloading' ? '下载中…' : busy === 'installing' ? '安装中…' : '一键升级',
			true,
			() => void this._run('app', () => this._dsh.upgradeApp()),
		);
		appBtn.disabled = !(app?.action === 'upgrade') || disabled;
		appBtn.dataset['action'] = 'upgrade-app';
		box.appendChild(this._line(
			[this._mono(app?.current ?? '0.0.0'), el('span', { fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }, text)],
			[appBtn],
		));
		box.appendChild(el('div', {
			fontSize: '11px', color: 'var(--vscode-descriptionForeground)', padding: '4px 0 0',
		}, '点一次即可：检查 → 比版本 → 下载 → 安装并重启（会话会中断）。更新源比本地旧时不会降级。'));
		if (app?.error) {
			box.appendChild(el('div', { marginTop: '4px', fontSize: '11.5px', color: 'var(--vscode-errorForeground)' }, app.error));
		}
		return box;
	}

	private _renderBundled(s: IDshUpgradeState | undefined, disabled: boolean): HTMLElement {
		const box = el('div');
		const rows = pendingBundled(s);
		const up = upgradableBundled(s).length;
		const hasAssetJob = (s?.assets ?? []).some(a => a.via === 'ide');

		let right: string | HTMLElement = rows.length
			? `${rows.length} 项待处理${rows.length !== up ? `（可升级 ${up}）` : ''}`
			: '已最新';
		if (up > 0 || hasAssetJob) {
			const allBtn = actionButton(this._busy === 'all' ? '升级中…' : '全部升级', true, () => void this._runAll());
			allBtn.disabled = disabled;
			allBtn.dataset['action'] = 'upgrade-all';
			right = allBtn;
		}
		box.appendChild(this._sectionTitle('随包插件', right));

		if (!rows.length) {
			box.appendChild(this._empty('随包插件都是最新的'));
			return box;
		}
		for (const r of rows) {
			const missing = r.state === 'missing';
			const b = actionButton(this._busy === `bundled:${r.name}` ? '处理中…' : missing ? '安装' : '升级', missing,
				() => void this._run(`bundled:${r.name}`, () => this._dsh.upgradeBundled(r.name)));
			b.disabled = disabled || this._busy === `bundled:${r.name}`;
			b.dataset['action'] = `upgrade-bundled:${r.name}`;
			box.appendChild(this._line(
				[
					this._mono(r.name),
					this._mono(r.installedVersion ? `${r.installedVersion} → ${r.version}` : r.version, true),
					this._tag(missing ? '未安装' : '可升级', missing),
				],
				[b],
			));
		}
		return box;
	}

	private _renderAssets(s: IDshUpgradeState | undefined, disabled: boolean): HTMLElement {
		const box = el('div');
		const rows = s?.assets ?? [];
		const counts: Record<string, number> = {};
		for (const k of KIND_ORDER) { counts[k] = 0; }
		for (const r of rows) { if (counts[r.kind] !== undefined) { counts[r.kind]++; } }

		box.appendChild(this._sectionTitle('资产（技能 / MCP / 智能体 / 工作流 / 工作台）', rows.length ? `${rows.length} 项可升级` : '已最新'));
		const summary = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px', padding: '0 0 6px' });
		for (const k of KIND_ORDER) {
			summary.appendChild(el('span', {
				color: counts[k] ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-descriptionForeground)',
				fontWeight: counts[k] ? '600' : '400',
			}, `${KIND_LABEL[k]} ${counts[k]}`));
		}
		box.appendChild(summary);

		if (s?.assetsNote) {
			box.appendChild(el('div', { fontSize: '11.5px', color: 'var(--vscode-descriptionForeground)' }, s.assetsNote));
		}
		if (!rows.length) {
			box.appendChild(this._empty('没有可升级的资产'));
			return box;
		}
		for (const r of rows) {
			const b = actionButton(this._busy === `asset:${r.kind}/${r.name}` ? '处理中…' : '升级', false,
				() => void this._run(`asset:${r.kind}/${r.name}`, () => this._dsh.upgradeAsset(r.kind, r.name)));
			b.disabled = disabled || this._busy === `asset:${r.kind}/${r.name}`;
			b.dataset['action'] = `upgrade-asset:${r.kind}:${r.name}`;
			box.appendChild(this._line(
				[this._tag(KIND_LABEL[r.kind] ?? r.kind), this._mono(r.name), this._mono(r.current ? `${r.current} → ${r.latest}` : r.latest, true)],
				// 技能 / 工作流由 dsh 侧自持 ⇒ 不画按钮（IDE 侧调用会被下线闸拒，见 upgradeAsset 的注释）
				r.via === 'dsh' ? [this._tag('dsh 侧升级')] : [b],
			));
		}
		return box;
	}

	private _renderRuntime(s: IDshUpgradeState | undefined): HTMLElement {
		const box = el('div');
		box.appendChild(this._sectionTitle('dsh 运行时'));
		box.appendChild(this._line(
			[this._mono(s?.runtime?.current ?? '—'), this._tag(s?.runtime?.channel ?? 'stable')],
			[el('span', { fontSize: '11.5px', color: 'var(--vscode-descriptionForeground)' }, '跟随应用升级（本版不支持单独切版本）')],
		));
		return box;
	}
}
