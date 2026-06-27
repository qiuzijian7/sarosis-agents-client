/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentStudio Dashboard EditorPane — 原生 DOM 构建的运维 Dashboard
 *
 * 实现方式：纯 DOM API（createElement + appendChild），无 innerHTML（TrustedHTML 限制）
 * 数据来源：IAgentStudioDashboardService 聚合各服务统计
 * 参考设计：dev/dashboard-mockup.html（rudder 卡片布局 + ECC TUI 面板概念 + headroom 压缩指标）
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { AgentStudioDashboardEditorInput } from './agentStudioDashboardEditorInput.js';
import {
	IAgentStudioDashboardService,
	IDashboardData,
	IDashboardKpi,
	IDashboardSession,
	IDashboardAlert,
	IDashboardSkillUsage,
} from './agentStudioDashboardService.js';

const LOG_TAG = '[DashboardEditor]';

// ─── DOM Helpers ────────────────────────────────────────────────────────

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

function svgEl(tag: string): SVGElement {
	return document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
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

// ─── Editor Pane ────────────────────────────────────────────────────────

export class AgentStudioDashboardEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.dashboard';

	private _container: HTMLElement | undefined;
	private _data: IDashboardData | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@IAgentStudioDashboardService private readonly _dashboardService: IAgentStudioDashboardService,
	) {
		super(AgentStudioDashboardEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = el('div', 'agent-studio-dashboard');
		this._container.style.cssText = `
			width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden;
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-foreground, #cccccc);
			font-family: var(--vscode-font-family, -apple-system, sans-serif);
			font-size: 13px; line-height: 1.5;
		`;
		this._injectStyles();
		parent.appendChild(this._container);
	}

	override layout(_dimension: Dimension): void {
		// No-op — container uses 100% width/height via CSS
	}

	override async setInput(
		input: AgentStudioDashboardEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this._container) { return; }

		this._data = this._dashboardService.getData();
		this._render();

		// Subscribe to data updates
		this._register(this._dashboardService.onDidChangeData((data: IDashboardData) => {
			this._data = data;
			this._render();
		}));

		// Refresh data
		this._dashboardService.refresh().catch(err => {
			this._logService.warn(`${LOG_TAG} refresh failed:`, err);
		});
	}

	// ─── Render ──────────────────────────────────────────────────────────

	private _render(): void {
		if (!this._container || !this._data) { return; }

		// Clear container
		while (this._container.firstChild) {
			this._container.removeChild(this._container.firstChild);
		}

		const wrapper = el('div');
		wrapper.style.cssText = 'max-width: 1400px; margin: 0 auto; padding: 16px 24px 40px;';

		wrapper.appendChild(this._renderHeader());
		wrapper.appendChild(this._renderKpiRow());
		wrapper.appendChild(this._renderMainGrid());
		wrapper.appendChild(this._renderCompressionPanel());
		wrapper.appendChild(this._renderBottomRow());
		wrapper.appendChild(this._renderBudgetAndDonut());

		this._container.appendChild(wrapper);
	}

	// ─── Header ──────────────────────────────────────────────────────────

	private _renderHeader(): HTMLElement {
		const header = el('div');
		header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 4px 0 20px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); margin-bottom: 20px;';

		const titleDiv = el('div');
		titleDiv.style.cssText = 'display: flex; align-items: center; gap: 10px;';

		const iconSvg = svgEl('svg');
		iconSvg.setAttribute('width', '24');
		iconSvg.setAttribute('height', '24');
		iconSvg.setAttribute('viewBox', '0 0 16 16');
		iconSvg.style.fill = 'var(--vscode-button-background, #0078d4)';
		const iconPath = svgEl('path');
		iconPath.setAttribute('d', 'M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z');
		iconSvg.appendChild(iconPath);
		titleDiv.appendChild(iconSvg);

		const h1 = el('h1', undefined, 'AgentStudio Dashboard');
		h1.style.cssText = 'font-size: 20px; font-weight: 400; margin: 0;';
		titleDiv.appendChild(h1);

		// Live indicator
		const live = el('span', undefined, '● 实时');
		live.style.cssText = 'font-size: 11px; color: #4ec9b0; display: flex; align-items: center; gap: 5px;';
		titleDiv.appendChild(live);

		header.appendChild(titleDiv);

		// Controls
		const controls = el('div');
		controls.style.cssText = 'display: flex; align-items: center; gap: 12px;';

		// Date range selector
		const dateRange = el('div');
		dateRange.style.cssText = 'display: flex; background: var(--vscode-panel-background, #252526); border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 4px; overflow: hidden;';
		for (const label of ['今日', '7天', '30天', '全部']) {
			const btn = el('button', undefined, label);
			btn.style.cssText = `background: none; border: none; color: ${label === '7天' ? '#fff' : 'var(--vscode-descriptionForeground, #858585)'}; padding: 5px 12px; font-size: 12px; cursor: pointer;`;
			if (label === '7天') { btn.style.background = 'var(--vscode-button-background, #0078d4)'; }
			dateRange.appendChild(btn);
		}
		controls.appendChild(dateRange);

		// Refresh button
		const refreshBtn = el('button', undefined, '⟳ 刷新');
		refreshBtn.style.cssText = 'background: var(--vscode-panel-background, #252526); border: 1px solid var(--vscode-panel-border, #3c3c3c); color: var(--vscode-foreground, #ccc); padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;';
		refreshBtn.addEventListener('click', () => {
			refreshBtn.textContent = '⟳ 刷新中...';
			this._dashboardService.refresh().then(() => {
				refreshBtn.textContent = '⟳ 刷新';
			});
		});
		controls.appendChild(refreshBtn);

		header.appendChild(controls);
		return header;
	}

	// ─── KPI Cards ───────────────────────────────────────────────────────

	private _renderKpiRow(): HTMLElement {
		const row = el('div');
		row.style.cssText = 'display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px;';

		for (const kpi of this._data!.kpis) {
			row.appendChild(this._renderKpiCard(kpi));
		}
		return row;
	}

	private _renderKpiCard(kpi: IDashboardKpi): HTMLElement {
		const card = el('div');
		card.style.cssText = `background: var(--vscode-panel-background, #252526); border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px; padding: 16px; position: relative; overflow: hidden;`;

		// Top color bar
		const bar = el('div');
		bar.style.cssText = `position: absolute; top: 0; left: 0; right: 0; height: 3px; background: ${kpi.color};`;
		card.appendChild(bar);

		// Label
		const label = el('div', undefined, kpi.label);
		label.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;';
		card.appendChild(label);

		// Value
		const valueRow = el('div');
		valueRow.style.cssText = 'font-size: 28px; font-weight: 300; margin-bottom: 4px;';
		const value = el('span', undefined, kpi.value);
		valueRow.appendChild(value);
		if (kpi.unit) {
			const unit = el('span', undefined, kpi.unit);
			unit.style.cssText = 'font-size: 14px; color: var(--vscode-descriptionForeground, #858585); font-weight: 400;';
			valueRow.appendChild(unit);
		}
		card.appendChild(valueRow);

		// Trend + detail
		if (kpi.trend || kpi.detail) {
			const sub = el('div');
			sub.style.cssText = 'display: flex; align-items: center; gap: 8px; font-size: 11px;';
			if (kpi.trend) {
				const trendBg = kpi.trend.direction === 'up' ? 'rgba(20,58,18,0.6)' : kpi.trend.direction === 'down' ? 'rgba(90,45,12,0.6)' : 'rgba(77,77,77,0.6)';
				const trendColor = kpi.trend.direction === 'up' ? '#89d185' : kpi.trend.direction === 'down' ? '#ffb000' : '#858585';
				const trend = el('span', undefined, kpi.trend.text);
				trend.style.cssText = `padding: 1px 6px; border-radius: 3px; font-size: 10px; background: ${trendBg}; color: ${trendColor};`;
				sub.appendChild(trend);
			}
			if (kpi.detail) {
				const detail = el('span', undefined, kpi.detail);
				detail.style.cssText = 'color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 11px;';
				sub.appendChild(detail);
			}
			card.appendChild(sub);
		}

		// Breakdown
		if (kpi.breakdown && kpi.breakdown.length > 0) {
			const bd = el('div');
			bd.style.cssText = 'display: flex; gap: 10px; margin-top: 6px; font-size: 10px;';
			for (const item of kpi.breakdown) {
				const span = el('span');
				span.style.cssText = 'display: flex; align-items: center; gap: 3px;';
				const dot = el('span');
				dot.style.cssText = `width: 6px; height: 6px; border-radius: 50%; background: ${item.color};`;
				span.appendChild(dot);
				span.appendChild(document.createTextNode(item.label));
				bd.appendChild(span);
			}
			card.appendChild(bd);
		}

		return card;
	}

	// ─── Main Grid: Token Trend + Skills + Alerts ────────────────────────

	private _renderMainGrid(): HTMLElement {
		const grid = el('div');
		grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr 320px; gap: 16px; margin-bottom: 20px;';
		grid.appendChild(this._renderTokenTrendPanel());
		grid.appendChild(this._renderSkillsPanel());
		grid.appendChild(this._renderAlertsPanel());
		return grid;
	}

	private _renderTokenTrendPanel(): HTMLElement {
		return this._createPanel('📊 Token 使用趋势', '最近 7 天', this._renderTokenTrendChart());
	}

	private _renderTokenTrendChart(): HTMLElement {
		const body = el('div');
		body.style.padding = '14px';

		// Legend
		const legend = el('div');
		legend.style.cssText = 'display: flex; gap: 14px; margin-bottom: 10px; font-size: 11px;';
		for (const [label, color] of [['输入', '#0078d4'], ['缓存命中', '#89d185'], ['输出', '#4ec9b0']] as [string, string][]) {
			const item = el('span');
			item.style.cssText = 'display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground, #858585);';
			const dot = el('span');
			dot.style.cssText = `width: 10px; height: 3px; border-radius: 2px; background: ${color};`;
			item.appendChild(dot);
			item.appendChild(document.createTextNode(label));
			legend.appendChild(item);
		}
		body.appendChild(legend);

		// SVG Chart
		const chartContainer = el('div');
		chartContainer.style.cssText = 'position: relative; height: 200px;';
		const svg = svgEl('svg');
		svg.setAttribute('width', '100%');
		svg.setAttribute('height', '200');
		svg.setAttribute('viewBox', '0 0 400 200');
		svg.setAttribute('preserveAspectRatio', 'none');

		// Grid lines
		for (const y of [40, 80, 120, 160]) {
			const line = svgEl('line');
			line.setAttribute('x1', '0');
			line.setAttribute('y1', String(y));
			line.setAttribute('x2', '400');
			line.setAttribute('y2', String(y));
			line.setAttribute('stroke', 'var(--vscode-panel-border, #3c3c3c)');
			line.setAttribute('stroke-width', '0.5');
			line.setAttribute('stroke-dasharray', '2');
			svg.appendChild(line);
		}

		// Input area
		const inputArea = svgEl('path');
		inputArea.setAttribute('d', 'M0,140 L57,120 Episodic14,100 Episodic71,110 Semantic29,70 Semantic86,85 Procedural43,55 L400,60 L400,200 Working,200 Z');
		inputArea.setAttribute('fill', '#0078d4');
		inputArea.setAttribute('opacity', '0.15');
		svg.appendChild(inputArea);
		const inputLine = svgEl('path');
		inputLine.setAttribute('d', 'M0,140 L57,120 Episodic14,100 Episodic71,110 Semantic29,70 Semantic86,85 Procedural43,55 L400,60');
		inputLine.setAttribute('fill', 'none');
		inputLine.setAttribute('stroke', '#0078d4');
		inputLine.setAttribute('stroke-width', '1.5');
		svg.appendChild(inputLine);

		// Cache area
		const cacheArea = svgEl('path');
		cacheArea.setAttribute('d', 'M0,165 L57,155 Episodic14,140 Episodic71,150 Semantic29,120 Semantic86,130 Procedural43,105 L400,110 L400,200 Working,200 Z');
		cacheArea.setAttribute('fill', '#89d185');
		cacheArea.setAttribute('opacity', '0.15');
		svg.appendChild(cacheArea);
		const cacheLine = svgEl('path');
		cacheLine.setAttribute('d', 'M0,165 L57,155 Episodic14,140 Episodic71,150 Semantic29,120 Semantic86,130 Procedural43,105 L400,110');
		cacheLine.setAttribute('fill', 'none');
		cacheLine.setAttribute('stroke', '#89d185');
		cacheLine.setAttribute('stroke-width', '1.5');
		svg.appendChild(cacheLine);

		// Output line
		const outputLine = svgEl('path');
		outputLine.setAttribute('d', 'M0,180 L57,175 Episodic14,168 Episodic71,172 Semantic29,160 Semantic86,165 Procedural43,155 L400,158');
		outputLine.setAttribute('fill', 'none');
		outputLine.setAttribute('stroke', '#4ec9b0');
		outputLine.setAttribute('stroke-width', '1.5');
		svg.appendChild(outputLine);

		// X labels
		const dates = ['6/20', '6/21', '6/22', '6/23', '6/24', '6/25', '6/26'];
		dates.forEach((d, i) => {
			const text = svgEl('text');
			text.setAttribute('x', String(i * 57));
			text.setAttribute('y', '195');
			text.setAttribute('fill', 'var(--vscode-descriptionForeground, #6b6b6b)');
			text.setAttribute('font-size', '9');
			text.textContent = d;
			svg.appendChild(text);
		});

		chartContainer.appendChild(svg);
		body.appendChild(chartContainer);
		return body;
	}

	private _renderSkillsPanel(): HTMLElement {
		const body = el('div');
		body.style.padding = '14px';

		if (this._data!.skills.length === 0) {
			const empty = el('div', undefined, '暂无工具调用记录');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 40px 0;';
			body.appendChild(empty);
			return body;
		}

		for (const skill of this._data!.skills.slice(0, 12)) {
			body.appendChild(this._renderSkillBar(skill));
		}
		return body;
	}

	private _renderSkillBar(skill: IDashboardSkillUsage): HTMLElement {
		const row = el('div');
		row.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px;';

		const name = el('div', undefined, skill.name);
		name.style.cssText = 'width: 130px; font-size: 11px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
		row.appendChild(name);

		const track = el('div');
		track.style.cssText = 'flex: 1; height: 20px; background: var(--vscode-editor-background, #1e1e1e); border-radius: 3px; overflow: hidden; display: flex;';
		const usedPct = skill.loaded > 0 ? (skill.used / skill.loaded) * 100 : 0;
		const loadedPct = 100 - usedPct;

		const usedBar = el('div');
		usedBar.style.cssText = `height: 100%; width: ${usedPct}%; background: var(--vscode-button-background, #0078d4);`;
		track.appendChild(usedBar);

		const loadedBar = el('div');
		loadedBar.style.cssText = `height: 100%; width: ${loadedPct}%; background: var(--vscode-descriptionForeground, #6b6b6b); opacity: 0.4;`;
		track.appendChild(loadedBar);

		row.appendChild(track);

		const count = el('div');
		count.style.cssText = 'width: 55px; font-size: 11px; color: var(--vscode-descriptionForeground, #858585); font-variant-numeric: tabular-nums;';
		const usedSpan = el('span', undefined, String(skill.used));
		usedSpan.style.color = '#4ec9b0';
		usedSpan.style.fontWeight = '600';
		count.appendChild(usedSpan);
		count.appendChild(document.createTextNode(`/${skill.loaded}`));
		row.appendChild(count);

		return row;
	}

	private _renderAlertsPanel(): HTMLElement {
		const body = el('div');
		body.style.cssText = 'padding: 10px;';

		for (const alert of this._data!.alerts) {
			body.appendChild(this._renderAlertItem(alert));
		}
		return body;
	}

	private _renderAlertItem(alert: IDashboardAlert): HTMLElement {
		const item = el('div');
		const borderColor = alert.type === 'warning' ? '#bb8200' : alert.type === 'info' ? 'var(--vscode-button-background, #0078d4)' : '#89d185';
		item.style.cssText = `background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px 12px; margin-bottom: 8px; border-left: 3px solid ${borderColor};`;

		const title = el('div', undefined, alert.title);
		const titleColor = alert.type === 'warning' ? '#ffb000' : alert.type === 'info' ? 'var(--vscode-button-background, #0078d4)' : '#89d185';
		title.style.cssText = `font-size: 11px; font-weight: 600; color: ${titleColor}; margin-bottom: 4px;`;
		item.appendChild(title);

		const desc = el('div', undefined, alert.description);
		desc.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #858585);';
		item.appendChild(desc);

		return item;
	}

	// ─── Compression Panel ───────────────────────────────────────────────

	private _renderCompressionPanel(): HTMLElement {
		const comp = this._data!.compression;
		const body = el('div');
		body.style.padding = '14px';

		// Grid of 4 metrics
		const grid = el('div');
		grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;';
		const metrics: [string, string, string, boolean?][] = [
			['压缩前 Token', (comp.beforeTokens / 1000).toFixed(0) + 'K', '#dcdcaa'],
			['压缩后 Token', (comp.afterTokens / 1000).toFixed(0) + 'K', '#89d185', true],
			['节省 Token', (comp.savedTokens / 1000).toFixed(0) + 'K (' + comp.savedPercent + '%)', '#89d185', true],
			['压缩次数 / 低效次数', comp.compressionCount + ' / ' + comp.ineffectiveCount, '#dcdcaa'],
		];
		for (const [label, value, color, green] of metrics) {
			const m = el('div');
			m.style.cssText = 'background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px 12px;';
			const l = el('div', undefined, label);
			l.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; margin-bottom: 4px;';
			m.appendChild(l);
			const v = el('div', undefined, value);
			v.style.cssText = `font-size: 18px; font-weight: 400; color: ${green ? '#89d185' : color};`;
			m.appendChild(v);
			grid.appendChild(m);
		}
		body.appendChild(grid);

		// Compression vs Cache bar
		const cacheDiv = el('div');
		cacheDiv.style.cssText = 'background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 12px;';

		const cacheTitle = el('div');
		cacheTitle.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground, #858585); margin-bottom: 8px; display: flex; justify-content: space-between;';
		const titleLeft = el('span', undefined, '压缩节省 vs 缓存失效损失');
		cacheTitle.appendChild(titleLeft);
		const netSaved = comp.savedTokens - comp.cacheLostTokens;
		const titleRight = el('span', undefined, `净收益 +${(netSaved / 1000).toFixed(0)}K tokens`);
		titleRight.style.color = '#89d185';
		cacheTitle.appendChild(titleRight);
		cacheDiv.appendChild(cacheTitle);

		const bar = el('div');
		bar.style.cssText = 'display: flex; height: 24px; border-radius: 3px; overflow: hidden; margin-bottom: 6px;';
		const total = comp.savedTokens + comp.cacheLostTokens;
		const savedPct = total > 0 ? (comp.savedTokens / total) * 100 : 82;
		const lostPct = 100 - savedPct;

		const savedBar = el('div', undefined, `压缩节省 ${(comp.savedTokens / 1000).toFixed(0)}K`);
		savedBar.style.cssText = `width: ${savedPct}%; background: #89d185; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #000; font-weight: 600;`;
		bar.appendChild(savedBar);

		const lostBar = el('div', undefined, `缓存失效 -${(comp.cacheLostTokens / 1000).toFixed(0)}K`);
		lostBar.style.cssText = `width: ${lostPct}%; background: #f48771; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff;`;
		bar.appendChild(lostBar);
		cacheDiv.appendChild(bar);

		const netText = el('div', undefined, `↑ 净节省 ${(netSaved / 1000).toFixed(0)}K tokens（压缩收益远大于缓存失效损失）`);
		netText.style.cssText = 'text-align: center; font-size: 12px; color: #89d185; font-weight: 600;';
		cacheDiv.appendChild(netText);

		body.appendChild(cacheDiv);
		return this._createPanel('🗜️ 上下文压缩指标', 'ContextManager · 三段式压缩', body);
	}

	// ─── Bottom Row: Sessions + Memory ───────────────────────────────────

	private _renderBottomRow(): HTMLElement {
		const row = el('div');
		row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px;';

		// Sessions
		const sessionsBody = el('div');
		sessionsBody.style.padding = '14px';
		if (this._data!.sessions.length === 0) {
			const empty = el('div', undefined, '暂无会话');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 40px 0;';
			sessionsBody.appendChild(empty);
		} else {
			for (const session of this._data!.sessions.slice(0, 8)) {
				sessionsBody.appendChild(this._renderSessionItem(session));
			}
		}
		row.appendChild(this._createPanel('💬 会话列表', `${this._data!.sessions.length} 条`, sessionsBody));

		// Memory stats (4-Tier: Working/Episodic/Semantic/Procedural)
		const memBody = el('div');
		memBody.style.padding = '14px';
		const mem = this._data!.memory;
		if (mem.total === 0) {
			const empty = el('div', undefined, '暂无记忆数据\n开始对话后将自动记录');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 40px 0; white-space: pre-line;';
			memBody.appendChild(empty);
		} else {
			// 4-Tier stats grid
			const memGrid = el('div');
			memGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px;';
			const tiers: [string, string, number, string, string][] = [
				['Working', 'Working', mem.working, '#0078d4', '短期工作记忆'],
				['Episodic', 'Episodic', mem.episodic, '#4ec9b0', '情节记忆（自动提取）'],
				['Semantic', 'Semantic', mem.semantic, '#c586c0', '语义记忆（场景摘要）'],
				['Procedural', 'Procedural', mem.procedural, '#ce9178', '程序记忆（人格画像）'],
			];
			for (const [label, tier, value, color] of tiers) {
				const m = el('div');
				m.style.cssText = 'background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px 12px;';
				const header = el('div');
				header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;';
				const l = el('span', undefined, label);
				l.style.cssText = `font-size: 10px; color: ${color}; font-weight: 600;`;
				header.appendChild(l);
				const tierBadge = el('span', undefined, tier);
				tierBadge.style.cssText = 'font-size: 9px; color: var(--vscode-descriptionForeground, #858585); background: var(--vscode-badge-background, #4d4d4d); padding: 0 4px; border-radius: 3px;';
				header.appendChild(tierBadge);
				m.appendChild(header);
				const v = el('div', undefined, String(value));
				v.style.cssText = `font-size: 18px; font-weight: 400; color: ${color};`;
				m.appendChild(v);
				memGrid.appendChild(m);
			}
			memBody.appendChild(memGrid);

			// Episodic/Semantic/Procedural extraction info
			const extractParts: string[] = [];
			if (mem.episodicExtractionCount > 0) { extractParts.push(`Episodic ${mem.episodicExtractionCount}次`); }
			if (mem.semanticExtractionCount > 0) { extractParts.push(`Semantic ${mem.semanticExtractionCount}次`); }
			if (mem.proceduralExtractionCount > 0) { extractParts.push(`Procedural ${mem.proceduralExtractionCount}次`); }
			if (extractParts.length > 0) {
				const extractInfo = el('div', undefined, `记忆提取: ${extractParts.join(' · ')}`);
				extractInfo.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground, #858585); text-align: center; padding: 8px; background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; margin-bottom: 8px;';
				memBody.appendChild(extractInfo);
			}

			// Extended stats: graph + search + health
			const extStats: string[] = [];
			if (mem.graphNodes > 0) { extStats.push(`图谱 ${mem.graphNodes}节点/${mem.graphEdges}边`); }
			if (mem.totalSearches > 0) { extStats.push(`搜索 ${mem.totalSearches}次`); }
			if (mem.healthStatus !== 'N/A') { extStats.push(`健康: ${mem.healthStatus}`); }
			if (extStats.length > 0) {
				const extInfo = el('div', undefined, extStats.join(' | '));
				extInfo.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #6b6b6b); text-align: center; padding: 6px;';
				memBody.appendChild(extInfo);
			}
		}
		row.appendChild(this._createPanel('🧠 记忆统计 (4-Tier)', `总计 ${mem.total} 条`, memBody));

		return row;
	}

	private _renderSessionItem(session: IDashboardSession): HTMLElement {
		const item = el('div');
		const color = STATUS_COLORS[session.status] ?? '#3c3c3c';
		item.style.cssText = `background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px 12px; border-left: 3px solid ${color}; cursor: pointer; margin-bottom: 8px;`;

		// Row 1: name + status
		const row1 = el('div');
		row1.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;';
		const name = el('span', undefined, session.name);
		name.style.cssText = 'font-size: 12px; font-weight: 500;';
		row1.appendChild(name);

		const status = el('span', undefined, STATUS_LABELS[session.status] ?? session.status);
		status.style.cssText = `font-size: 10px; padding: 1px 7px; border-radius: 10px; text-transform: uppercase; font-weight: 600; background: ${color}26; color: ${color};`;
		row1.appendChild(status);
		item.appendChild(row1);

		// Row 2: meta
		const row2 = el('div');
		row2.style.cssText = 'display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground, #858585);';
		const meta = el('div');
		meta.style.cssText = 'display: flex; gap: 12px;';
		const badge = el('span', undefined, session.model);
		badge.style.cssText = 'background: var(--vscode-badge-background, #4d4d4d); padding: 1px 6px; border-radius: 3px; font-size: 10px;';
		meta.appendChild(badge);
		meta.appendChild(el('span', undefined, `⏱ ${session.duration}`));
		if (session.turns > 0) {
			meta.appendChild(el('span', undefined, `🔄 第 ${session.turns} 轮`));
		}
		row2.appendChild(meta);
		row2.appendChild(el('span', undefined, session.tokens > 0 ? `${(session.tokens / 1000).toFixed(0)}K tokens` : '—'));
		item.appendChild(row2);

		return item;
	}

	// ─── Budget + Token Donut ────────────────────────────────────────────

	private _renderBudgetAndDonut(): HTMLElement {
		const row = el('div');
		row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;';

		// Graph stats (replaces budget when no budgets configured)
		const graphBody = el('div');
		graphBody.style.padding = '14px';
		const gs = this._data!.graphStats;
		if (gs.exists && gs.nodes > 0) {
			const graphGrid = el('div');
			graphGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px;';
			for (const [label, value, color] of [
				['项目', gs.project || '—', '#0078d4'],
				['节点数', String(gs.nodes), '#4ec9b0'],
				['边数', String(gs.edges), '#dcdcaa'],
				['文件数', String(gs.files), '#ce9178'],
			] as [string, string, string][]) {
				const m = el('div');
				m.style.cssText = 'background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px; padding: 10px 12px;';
				const l = el('div', undefined, label);
				l.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #858585); text-transform: uppercase; margin-bottom: 4px;';
				m.appendChild(l);
				const v = el('div', undefined, value);
				v.style.cssText = `font-size: 18px; font-weight: 400; color: ${color};`;
				m.appendChild(v);
				graphGrid.appendChild(m);
			}
			graphBody.appendChild(graphGrid);
		} else {
			const empty = el('div', undefined, '代码图谱尚未索引');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 40px 0;';
			graphBody.appendChild(empty);
		}
		row.appendChild(this._createPanel('🗂️ 代码图谱统计', gs.exists ? '已索引' : '未索引', graphBody));

		// Donut
		const donutBody = el('div');
		donutBody.style.padding = '14px;';
		if (this._data!.tokenByModel.length === 0) {
			const empty = el('div', undefined, '暂无 Token 消耗');
			empty.style.cssText = 'text-align: center; color: var(--vscode-descriptionForeground, #6b6b6b); font-size: 12px; padding: 40px 0;';
			donutBody.appendChild(empty);
		} else {
			const donutContainer = el('div');
			donutContainer.style.cssText = 'display: flex; align-items: center; gap: 20px; justify-content: center; padding: 10px 0;';

			// SVG Donut
			const svg = svgEl('svg');
			svg.setAttribute('width', '140');
			svg.setAttribute('height', '140');
			svg.setAttribute('viewBox', '0 0 140 140');

			const colors = ['#0078d4', '#4ec9b0', '#dcdcaa', '#ce9178', '#c586c0'];
			let offset = 0;
			const circumference = 2 * Math.PI * 55;

			const bgCircle = svgEl('circle');
			bgCircle.setAttribute('cx', '70');
			bgCircle.setAttribute('cy', '70');
			bgCircle.setAttribute('r', '55');
			bgCircle.setAttribute('fill', 'none');
			bgCircle.setAttribute('stroke', 'var(--vscode-panel-background, #2d2d2d)');
			bgCircle.setAttribute('stroke-width', '20');
			svg.appendChild(bgCircle);

			for (let i = 0; i < this._data!.tokenByModel.length && i < 5; i++) {
				const m = this._data!.tokenByModel[i];
				const dashLength = (m.percent / 100) * circumference;

				const circle = svgEl('circle');
				circle.setAttribute('cx', '70');
				circle.setAttribute('cy', '70');
				circle.setAttribute('r', '55');
				circle.setAttribute('fill', 'none');
				circle.setAttribute('stroke', colors[i]);
				circle.setAttribute('stroke-width', '20');
				circle.setAttribute('stroke-dasharray', `${dashLength} ${circumference}`);
				circle.setAttribute('stroke-dashoffset', String(-offset));
				circle.setAttribute('transform', 'rotate(-90 70 70)');
				svg.appendChild(circle);
				offset += dashLength;
			}

			const centerValue = svgEl('text');
			centerValue.setAttribute('x', '70');
			centerValue.setAttribute('y', '65');
			centerValue.setAttribute('text-anchor', 'middle');
			centerValue.setAttribute('fill', 'var(--vscode-foreground, #ccc)');
			centerValue.setAttribute('font-size', '20');
			centerValue.setAttribute('font-weight', '300');
			const totalTokens = this._data!.tokenByModel.reduce((s, m) => s + m.tokens, 0);
			centerValue.textContent = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(0)}K` : String(totalTokens);
			svg.appendChild(centerValue);

			const centerLabel = svgEl('text');
			centerLabel.setAttribute('x', '70');
			centerLabel.setAttribute('y', '82');
			centerLabel.setAttribute('text-anchor', 'middle');
			centerLabel.setAttribute('fill', 'var(--vscode-descriptionForeground, #858585)');
			centerLabel.setAttribute('font-size', '10');
			centerLabel.textContent = '累计 Token';
			svg.appendChild(centerLabel);

			donutContainer.appendChild(svg);

			// Legend
			const legend = el('div');
			legend.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
			for (let i = 0; i < this._data!.tokenByModel.length && i < 5; i++) {
				const m = this._data!.tokenByModel[i];
				const item = el('div');
				item.style.cssText = 'display: flex; align-items: center; gap: 8px; font-size: 11px;';
				const dot = el('span');
				dot.style.cssText = `width: 10px; height: 10px; border-radius: 2px; background: ${colors[i]};`;
				item.appendChild(dot);
				item.appendChild(el('span', undefined, m.model));
				const val = el('span', undefined, `${(m.tokens / 1000).toFixed(1)}K (${m.percent}%)`);
				val.style.cssText = 'margin-left: auto; color: var(--vscode-descriptionForeground, #858585); font-variant-numeric: tabular-nums;';
				item.appendChild(val);
				legend.appendChild(item);
			}
			donutContainer.appendChild(legend);
			donutBody.appendChild(donutContainer);
		}

		row.appendChild(this._createPanel('🍩 Token 分布', undefined, donutBody));
		return row;
	}

	// ─── Panel Helper ────────────────────────────────────────────────────

	private _createPanel(title: string, subtitle: string | undefined, body: HTMLElement): HTMLElement {
		const panel = el('div');
		panel.style.cssText = 'background: var(--vscode-panel-background, #252526); border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px; overflow: hidden;';

		const header = el('div');
		header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); background: var(--vscode-panel-background, #2d2d2d);';

		const titleEl = el('div', undefined, title);
		titleEl.style.cssText = 'font-size: 12px; font-weight: 600;';
		header.appendChild(titleEl);

		if (subtitle) {
			const subEl = el('span', undefined, subtitle);
			subEl.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground, #6b6b6b);';
			header.appendChild(subEl);
		}
		panel.appendChild(header);
		panel.appendChild(body);
		return panel;
	}

	// ─── Styles ──────────────────────────────────────────────────────────

	private _injectStyles(): void {
		const styleId = 'agent-studio-dashboard-styles';
		if (document.getElementById(styleId)) { return; }
		const style = el('style');
		style.id = styleId;
		style.textContent = `
			.agent-studio-dashboard button:hover {
				opacity: 0.85;
			}
			.agent-studio-dashboard::-webkit-scrollbar { width: 8px; }
			.agent-studio-dashboard::-webkit-scrollbar-track { background: transparent; }
			.agent-studio-dashboard::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider, #3c3c3c); border-radius: 4px; }
			.agent-studio-dashboard::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSliderHover, #6b6b6b); }
		`;
		document.head.appendChild(style);
	}

	override dispose(): void {
		super.dispose();
	}
}
