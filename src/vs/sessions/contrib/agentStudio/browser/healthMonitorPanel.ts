/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHealthMonitorService } from '../common/healthMonitor.js';
import { ILogService } from '../../../../platform/log/common/log.js';


// ------------------------------------------------------------------------------------
// Health Monitor 面板
// ------------------------------------------------------------------------------------

export class HealthMonitorPanel extends Disposable {
  private readonly _panel: any; // WebviewPanel
  private readonly _healthMonitorService: IHealthMonitorService;
  private readonly _logService: ILogService;

  constructor(
    panel: any,
    @IHealthMonitorService healthMonitorService: IHealthMonitorService,
    @ILogService logService: ILogService,
  ) {
    super();
    this._panel = panel;
    this._healthMonitorService = healthMonitorService;
    this._logService = logService;

    // 设置 Webview
    this._setupWebview();

    // 监听健康状态变化
    this._register(
      this._healthMonitorService.onDidHealthChange((event) => {
        this._updateHealthStatus(event.instanceId);
      })
    );

    // 监听告警触发
    this._register(
      this._healthMonitorService.onDidAlertTriggered((event) => {
        this._updateAlerts();
      })
    );

    // 初始加载
    this._updateSystemHealth();
    this._updateAllHealthStatuses();
    this._updateAlerts();
  }

  private _setupWebview(): void {
    const webview = this._panel.webview;
    webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
    };

    webview.html = this._getHtmlContent();

    // 处理来自 Webview 的消息
    this._register(
      webview.onDidReceiveMessage((message: any) => {
        this._handleWebviewMessage(message);
      })
    );
  }

  private _getHtmlContent(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Health Monitor</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header h1 {
      margin: 0;
      font-size: 24px;
    }

    .system-health {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 15px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 5px;
      margin-bottom: 20px;
    }

    .health-score {
      font-size: 48px;
      font-weight: bold;
    }

    .health-score.healthy { color: #89d185; }
    .health-score.warning { color: #e9d36c; }
    .health-score.critical { color: #f48771; }
    .health-score.unknown { color: #a9a9a9; }

    .health-details {
      flex: 1;
    }

    .instances {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .instance-card {
      padding: 15px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .instance-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .instance-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .instance-name {
      font-weight: bold;
      font-size: 16px;
    }

    .health-badge {
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: bold;
    }

    .health-badge.healthy {
      background-color: #89d185;
      color: #000;
    }

    .health-badge.warning {
      background-color: #e9d36c;
      color: #000;
    }

    .health-badge.critical {
      background-color: #f48771;
      color: #000;
    }

    .health-badge.unknown {
      background-color: #a9a9a9;
      color: #000;
    }

    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      font-size: 12px;
    }

    .metric {
      display: flex;
      justify-content: space-between;
    }

    .metric-label {
      color: var(--vscode-descriptionForeground);
    }

    .metric-value {
      font-weight: bold;
    }

    .alerts {
      margin-top: 20px;
    }

    .alert-item {
      padding: 10px;
      margin-bottom: 10px;
      border-left: 3px solid;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
    }

    .alert-item.critical {
      border-color: #f48771;
    }

    .alert-item.warning {
      border-color: #e9d36c;
    }

    .alert-item.info {
      border-color: #89d185;
    }

    .alert-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 5px;
    }

    .alert-time {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .alert-message {
      font-size: 13px;
    }

    .section-title {
      font-size: 18px;
      font-weight: bold;
      margin-bottom: 15px;
      padding-bottom: 5px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 2px;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🏥 Health Monitor</h1>
    <button onclick="refresh()">🔄 Refresh</button>
  </div>

  <div id="system-health" class="system-health">
    <div class="health-score unknown">--</div>
    <div class="health-details">
      <div>Instances: <span id="total-instances">0</span></div>
      <div>Healthy: <span id="healthy-instances">0</span> | Warning: <span id="warning-instances">0</span> | Critical: <span id="critical-instances">0</span></div>
    </div>
  </div>

  <div class="section-title">Instance Health</div>
  <div id="instances" class="instances">
    <div style="color: var(--vscode-descriptionForeground);">No instances monitored yet.</div>
  </div>

  <div class="section-title">Active Alerts</div>
  <div id="alerts" class="alerts">
    <div style="color: var(--vscode-descriptionForeground);">No active alerts.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function setAlertRule() {
      vscode.postMessage({ type: 'setAlertRule' });
    }

    // 处理来自扩展的消息
    window.addEventListener('message', (event) => {
      const message = event.data;
      
      switch (message.type) {
        case 'updateSystemHealth':
          updateSystemHealth(message.data);
          break;
        case 'updateHealthStatus':
          updateHealthStatus(message.instanceId, message.data);
          break;
        case 'updateAlerts':
          updateAlerts(message.alerts);
          break;
      }
    });

    function updateSystemHealth(data) {
      const scoreElement = document.querySelector('#system-health .health-score');
      scoreElement.textContent = Math.round(data.overallScore);
      scoreElement.className = 'health-score ' + getHealthClass(data.overallScore);
      
      document.getElementById('total-instances').textContent = data.totalInstances;
      document.getElementById('healthy-instances').textContent = data.healthyInstances;
      document.getElementById('warning-instances').textContent = data.warningInstances;
      document.getElementById('critical-instances').textContent = data.criticalInstances;
    }

    function getHealthClass(score) {
      if (score >= 80) return 'healthy';
      if (score >= 50) return 'warning';
      return 'critical';
    }

    function updateHealthStatus(instanceId, status) {
      // TODO: 更新特定实例的健康状态
      console.log('Health status updated:', instanceId, status);
    }

    function updateAlerts(alerts) {
      const alertsContainer = document.getElementById('alerts');
      
      if (alerts.length === 0) {
        alertsContainer.innerHTML = '<div style="color: var(--vscode-descriptionForeground);">No active alerts.</div>';
        return;
      }
      
      alertsContainer.innerHTML = alerts.map(alert => \`
        <div class="alert-item \${alert.severity}">
          <div class="alert-header">
            <strong>\${alert.ruleName}</strong>
            <span class="alert-time">\${new Date(alert.triggeredAt).toLocaleString()}</span>
          </div>
          <div class="alert-message">\${alert.message}</div>
        </div>
      \`).join('');
    }

    // 初始请求数据
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>
    `.trim();
  }

  private async _updateSystemHealth(): Promise<void> {
    try {
      const systemHealth = this._healthMonitorService.getSystemHealth();
      
      await this._panel.webview.postMessage({
        type: 'updateSystemHealth',
        data: {
          overallScore: systemHealth.overallScore,
          totalInstances: systemHealth.totalInstances,
          healthyInstances: systemHealth.healthyInstances,
          warningInstances: systemHealth.warningInstances,
          criticalInstances: systemHealth.criticalInstances,
        },
      });
    } catch (error) {
      this._logService.error('[HealthMonitorPanel] Failed to update system health:', error);
    }
  }

  private async _updateAllHealthStatuses(): Promise<void> {
    try {
      const statuses = this._healthMonitorService.getAllHealthStatuses();
      
      for (const status of statuses) {
        await this._updateHealthStatus(status.instanceId);
      }
    } catch (error) {
      this._logService.error('[HealthMonitorPanel] Failed to update health statuses:', error);
    }
  }

  private async _updateHealthStatus(instanceId: string): Promise<void> {
    try {
      const status = this._healthMonitorService.getHealthStatus(instanceId);
      
      await this._panel.webview.postMessage({
        type: 'updateHealthStatus',
        instanceId,
        data: {
          status: status.status,
          score: status.score,
          lastUpdated: status.lastUpdated,
          metrics: status.metrics,
          alerts: status.alerts,
        },
      });
    } catch (error) {
      this._logService.error(`[HealthMonitorPanel] Failed to update health status for ${instanceId}:`, error);
    }
  }

  private async _updateAlerts(): Promise<void> {
    try {
      const alerts = this._healthMonitorService.getActiveAlerts();
      
      await this._panel.webview.postMessage({
        type: 'updateAlerts',
        alerts: alerts.map(alert => ({
          id: alert.id,
          ruleId: alert.ruleId,
          ruleName: 'Unknown Rule', // TODO: 从 ruleId 获取规则名称
          severity: alert.severity,
          message: alert.message,
          triggeredAt: alert.triggeredAt,
        })),
      });
    } catch (error) {
      this._logService.error('[HealthMonitorPanel] Failed to update alerts:', error);
    }
  }

  private _handleWebviewMessage(message: any): void {
    switch (message.type) {
      case 'ready':
        this._updateSystemHealth();
        this._updateAllHealthStatuses();
        this._updateAlerts();
        break;
      case 'refresh':
        this._updateSystemHealth();
        this._updateAllHealthStatuses();
        this._updateAlerts();
        break;
      case 'setAlertRule':
        // TODO: 打开设置告警规则的对话框
        this._logService.info('[HealthMonitorPanel] Set alert rule requested');
        break;
    }
  }

  public override dispose(): void {
    super.dispose();
    this._panel.dispose();
  }
}
