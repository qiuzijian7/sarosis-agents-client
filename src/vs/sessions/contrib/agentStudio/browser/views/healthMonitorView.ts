/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { IHealthMonitorService, ISystemHealth, IHealthStatus } from '../../common/healthMonitor.js';
import { $ } from '../../../../../base/browser/dom.js';

// ------------------------------------------------------------------------------------
// Health Monitor 视图面板
// ------------------------------------------------------------------------------------

export class HealthMonitorViewPane extends ViewPane {

	private _systemHealthElement!: HTMLElement;
	private _instancesContainer!: HTMLElement;
	private _alertsContainer!: HTMLElement;

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
		@IHealthMonitorService private readonly _healthMonitorService: IHealthMonitorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('health-monitor-view');

		// 创建整体布局
		const layout = $('div.health-monitor-layout');
		container.appendChild(layout);

		// 系统健康状态
		this._systemHealthElement = $('div.system-health');
		layout.appendChild(this._systemHealthElement);

		// 实例健康状态
		const instancesSection = $('div.section');
		const instancesTitle = $('div.section-title');
		instancesTitle.textContent = 'Instance Health';
		instancesSection.appendChild(instancesTitle);

		this._instancesContainer = $('div.instances-container');
		instancesSection.appendChild(this._instancesContainer);
		layout.appendChild(instancesSection);

		// 活动告警
		const alertsSection = $('div.section');
		const alertsTitle = $('div.section-title');
		alertsTitle.textContent = 'Active Alerts';
		alertsSection.appendChild(alertsTitle);

		this._alertsContainer = $('div.alerts-container');
		alertsSection.appendChild(this._alertsContainer);
		layout.appendChild(alertsSection);

		// 加载数据
		this._loadData();

		// 监听健康状态变化
		this._register(
			this._healthMonitorService.onDidHealthChange((event) => {
				this._updateInstanceHealth(event.instanceId);
			})
		);

		// 监听告警触发
		this._register(
			this._healthMonitorService.onDidAlertTriggered((event) => {
				this._loadAlerts();
			})
		);
	}

	private async _loadData(): Promise<void> {
		await this._loadSystemHealth();
		await this._loadAllInstances();
		await this._loadAlerts();
	}

	private async _loadSystemHealth(): Promise<void> {
		try {
			const systemHealth: ISystemHealth = this._healthMonitorService.getSystemHealth();

			this._systemHealthElement.innerHTML = '';
			this._systemHealthElement.classList.add('system-health');

			// 健康评分
			const scoreElement = $('div.health-score');
			scoreElement.textContent = Math.round(systemHealth.overallScore).toString();
			scoreElement.classList.add(this._getHealthClass(systemHealth.overallScore));
			this._systemHealthElement.appendChild(scoreElement);

			// 详细信息
			const detailsElement = $('div.health-details');
			detailsElement.innerHTML = `
				<div>Instances: ${systemHealth.totalInstances}</div>
				<div>
					Healthy: ${systemHealth.healthyInstances} | 
					Warning: ${systemHealth.warningInstances} | 
					Critical: ${systemHealth.criticalInstances}
				</div>
			`;
			this._systemHealthElement.appendChild(detailsElement);
		} catch (error) {
			this._systemHealthElement.innerHTML = '<div class="error">Failed to load system health</div>';
		}
	}

	private async _loadAllInstances(): Promise<void> {
		try {
			const statuses: IHealthStatus[] = this._healthMonitorService.getAllHealthStatuses();

			this._instancesContainer.innerHTML = '';

			if (statuses.length === 0) {
				this._instancesContainer.innerHTML = '<div class="empty-message">No instances monitored yet.</div>';
				return;
			}

			for (const status of statuses) {
				this._updateInstanceHealth(status.instanceId);
			}
		} catch (error) {
			this._instancesContainer.innerHTML = '<div class="error">Failed to load instances</div>';
		}
	}

	private async _updateInstanceHealth(instanceId: string): Promise<void> {
		try {
			const status: IHealthStatus = this._healthMonitorService.getHealthStatus(instanceId);

			// 检查是否已存在该实例的卡片
			let card = this._instancesContainer.querySelector(`[data-instance-id="${instanceId}"]`);

			if (!card) {
				card = $('div.instance-card');
				card.setAttribute('data-instance-id', instanceId);
				this._instancesContainer.appendChild(card);
			}

			// 更新卡片内容
			card.innerHTML = `
				<div class="instance-header">
					<span class="instance-name">${instanceId}</span>
					<span class="health-badge ${status.status}">${status.status}</span>
				</div>
				<div class="instance-metrics">
					<div>API Calls: ${status.metrics.totalApiCalls}</div>
					<div>Success Rate: ${this._calculateSuccessRate(status.metrics)}%</div>
					<div>Avg Response: ${status.metrics.averageResponseTime.toFixed(0)}ms</div>
				</div>
			`;
		} catch (error) {
			console.error(`Failed to update health for instance ${instanceId}:`, error);
		}
	}

	private async _loadAlerts(): Promise<void> {
		try {
			const alerts = this._healthMonitorService.getActiveAlerts();

			this._alertsContainer.innerHTML = '';

			if (alerts.length === 0) {
				this._alertsContainer.innerHTML = '<div class="empty-message">No active alerts.</div>';
				return;
			}

			for (const alert of alerts) {
				const alertElement = $('div.alert-item');
				alertElement.classList.add(alert.severity);

				const timestamp = new Date(alert.triggeredAt).toLocaleString();

				alertElement.innerHTML = `
					<div class="alert-header">
						<strong>${alert.ruleId}</strong>
						<span class="alert-time">${timestamp}</span>
					</div>
					<div class="alert-message">${alert.message}</div>
				`;

				this._alertsContainer.appendChild(alertElement);
			}
		} catch (error) {
			this._alertsContainer.innerHTML = '<div class="error">Failed to load alerts</div>';
		}
	}

	private _calculateSuccessRate(metrics: any): number {
		if (metrics.totalApiCalls === 0) {
			return 0;
		}
		return Math.round((metrics.successfulApiCalls / metrics.totalApiCalls) * 100);
	}

	private _getHealthClass(score: number): string {
		if (score >= 80) {
			return 'healthy';
		}
		if (score >= 50) {
			return 'warning';
		}
		return 'critical';
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// 可以在这里调整布局
	}
}
