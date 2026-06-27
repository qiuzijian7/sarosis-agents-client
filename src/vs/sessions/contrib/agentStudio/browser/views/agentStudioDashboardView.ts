/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentStudio Dashboard Sidebar View — 侧边栏中的 Dashboard 快捷视图
 *
 * 展示：4 mini KPI 卡片 + "打开完整 Dashboard" 按钮 + 活跃会话列表 + 告警通知
 * 点击 "打开完整 Dashboard" 在编辑器区域打开完整的 Dashboard EditorPane
 */

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { AgentStudioDashboardEditorInput } from '../agentStudioDashboardEditorInput.js';
import { IAgentStudioDashboardService, IDashboardData } from '../agentStudioDashboardService.js';

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (className) { e.className = className; }
	if (text !== undefined) { e.textContent = text; }
	return e;
}

const STATUS_COLORS: Record<string, string> = {
	running: '#4ec9b0',
	idle: '#dcdcaa',
	failed: '#f48771',
	completed: '#89d185',
	stopped: '#c586c0',
};

const STATUS_LABELS: Record<string, string> = {
	running: '运行中',
	idle: '空闲',
	failed: '失败',
	completed: '完成',
	stopped: '已停止',
};

export class AgentStudioDashboardViewPane extends ViewPane {

	private _body: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly _editorService: IEditorService,
		@IAgentStudioDashboardService private readonly _dashboardService: IAgentStudioDashboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._body = el('div');
		this._body.style.cssText = 'padding: 0 12px 16px;';

		const data = this._dashboardService.getData();
		this._renderContent(data);

		// Subscribe to updates
		this._register(this._dashboardService.onDidChangeData((data: IDashboardData) => {
			this._renderContent(data);
		}));

		// Trigger refresh
		this._dashboardService.refresh().catch(() => { });

		container.appendChild(this._body);
	}

	private _renderContent(data: IDashboardData): void {
		if (!this._body) { return; }

		// Clear
		while (this._body.firstChild) {
			this._body.removeChild(this._body.firstChild);
		}

		// Open Dashboard button
		this._body.appendChild(this._renderOpenButton());

		// Mini KPIs
		this._body.appendChild(this._renderMiniKpis(data));

		// Active Sessions section
		this._body.appendChild(this._renderSessionsSection(data));

		// Alerts section
		this._body.appendChild(this._renderAlertsSection(data));
	}

	private _renderOpenButton(): HTMLElement {
		const btn = el('button', undefined, '📊 打开完整 Dashboard');
		btn.style.cssText = `
			width: 100%; background: var(--vscode-button-background, #0078d4); color: #fff;
			border: none; padding: 7px 12px; border-radius: 4px; font-size: 12px;
			cursor: pointer; display: flex; align-items: center; justify-content: center;
			gap: 6px; margin-bottom: 14px;
		`;
		btn.addEventListener('click', () => {
			const input = AgentStudioDashboardEditorInput.getOrCreate();
			this._editorService.openEditor(input, { pinned: true });
		});
		return btn;
	}

	private _renderMiniKpis(data: IDashboardData): HTMLElement {
		const grid = el('div');
		grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px;';

		// Use real KPI data from the dashboard service
		for (const kpi of data.kpis.slice(0, 4)) {
			const card = el('div');
			card.style.cssText = 'background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px; border: 1px solid var(--vscode-panel-border, #3c3c3c);';

			const l = el('div', undefined, kpi.label);
			l.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; margin-bottom: 4px;';
			card.appendChild(l);

			const v = el('div');
			v.style.cssText = 'font-size: 20px; font-weight: 300;';
			v.appendChild(el('span', undefined, kpi.value));
			if (kpi.unit) {
				const unit = el('span', undefined, kpi.unit);
				unit.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground, #858585);';
				v.appendChild(unit);
			}
			card.appendChild(v);

			if (kpi.detail) {
				const s = el('div', undefined, kpi.detail);
				s.style.cssText = 'font-size: 10px; margin-top: 2px; color: var(--vscode-descriptionForeground, #858585);';
				card.appendChild(s);
			}

			grid.appendChild(card);
		}

		// If no KPIs, show placeholder
		if (data.kpis.length === 0) {
			const empty = el('div', undefined, '等待数据...');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 20px 0;';
			grid.appendChild(empty);
		}

		return grid;
	}

	private _renderSessionsSection(data: IDashboardData): HTMLElement {
		const section = el('div');
		section.style.marginBottom = '16px';

		// Section title
		const title = el('div');
		title.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; padding: 0 2px; display: flex; align-items: center; justify-content: space-between;';
		title.appendChild(el('span', undefined, '活跃会话'));
		const count = el('span', undefined, String(data.sessions.length));
		count.style.cssText = 'background: var(--vscode-badge-background, #4d4d4d); padding: 0 6px; border-radius: 8px; font-size: 10px; color: var(--vscode-foreground, #ccc);';
		title.appendChild(count);
		section.appendChild(title);

		// Session items
		for (const session of data.sessions.slice(0, 5)) {
			section.appendChild(this._renderSessionItem(session));
		}

		return section;
	}

	private _renderSessionItem(session: { id: string; name: string; status: string; model: string; tokens: number; duration: string }): HTMLElement {
		const color = STATUS_COLORS[session.status] ?? '#3c3c3c';
		const item = el('div');
		item.style.cssText = `background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; border-left: 3px solid ${color}; cursor: pointer;`;

		const name = el('div', undefined, session.name);
		name.style.cssText = 'font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px;';
		item.appendChild(name);

		const meta = el('div');
		meta.style.cssText = 'display: flex; justify-content: space-between; font-size: 9px; color: var(--vscode-descriptionForeground, #858585);';

		const status = el('span', undefined, STATUS_LABELS[session.status] ?? session.status);
		status.style.cssText = `font-size: 9px; padding: 0 5px; border-radius: 8px; background: ${color}26; color: ${color};`;
		meta.appendChild(status);

		const metaText = session.tokens > 0
			? `${(session.tokens / 1000).toFixed(0)}K · ${session.duration}`
			: session.duration;
		meta.appendChild(el('span', undefined, metaText));
		item.appendChild(meta);

		return item;
	}

	private _renderAlertsSection(data: IDashboardData): HTMLElement {
		const section = el('div');

		const title = el('div');
		title.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; padding: 0 2px; display: flex; align-items: center; justify-content: space-between;';
		title.appendChild(el('span', undefined, '告警通知'));
		const count = el('span', undefined, String(data.alerts.length));
		count.style.cssText = 'background: var(--vscode-badge-background, #4d4d4d); padding: 0 6px; border-radius: 8px; font-size: 10px; color: var(--vscode-foreground, #ccc);';
		title.appendChild(count);
		section.appendChild(title);

		for (const alert of data.alerts) {
			const borderColor = alert.type === 'warning' ? '#bb8200' : alert.type === 'info' ? 'var(--vscode-button-background, #0078d4)' : '#89d185';
			const titleColor = alert.type === 'warning' ? '#ffb000' : alert.type === 'info' ? 'var(--vscode-button-background, #0078d4)' : '#89d185';

			const item = el('div');
			item.style.cssText = `background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 7px 10px; margin-bottom: 6px; border-left: 3px solid ${borderColor};`;

			const t = el('div', undefined, alert.title);
			t.style.cssText = `font-size: 10px; font-weight: 600; color: ${titleColor}; margin-bottom: 2px;`;
			item.appendChild(t);

			const d = el('div', undefined, alert.description);
			d.style.cssText = 'font-size: 9px; color: var(--vscode-descriptionForeground, #858585);';
			item.appendChild(d);

			section.appendChild(item);
		}

		return section;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
