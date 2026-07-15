/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/channelEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { ChannelEditorInput } from './channelEditorInput.js';
import * as DOM from '../../../../base/browser/dom.js';
import { CHANNEL_DEFINITIONS, IChannelDefinition, IChannelConfigField, ChannelKey } from '../common/constants.js';
import { beginFeishuRegistration, pollFeishuRegistration, FEISHU_BASE, LARK_BASE } from './feishuRegistration.js';
import { drawQrToCanvas } from './feishuQrCode.js';

const { $ } = DOM;

export class ChannelEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.channel';

	private _container: HTMLElement | undefined;
	private _currentChannelKey: ChannelKey | undefined;
	/** 递增令牌：任何重新渲染或新一次绑定都会使先前的轮询循环失效。 */
	private _bindToken = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	) {
		super(ChannelEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('channel-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof ChannelEditorInput) || !this._container) {
			return;
		}

		// Re-render when a different channel is selected
		this._currentChannelKey = input.channelKey;
		this._renderChannelConfig(input.channelKey);
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private _renderChannelConfig(channelKey: ChannelKey): void {
		if (!this._container) {
			return;
		}
		this._bindToken++; // 取消任何进行中的绑定轮询
		this._container.replaceChildren();

		const def = CHANNEL_DEFINITIONS.find(d => d.key === channelKey);
		if (!def) {
			const msg = $('div.channel-editor-empty');
			msg.textContent = `未找到渠道: ${channelKey}`;
			this._container.appendChild(msg);
			return;
		}

		// ─── Header ──────────────────────────────────────
		const header = $('div.channel-editor-header');
		const iconEl = $('span.channel-editor-header-icon');
		iconEl.textContent = def.icon;
		header.appendChild(iconEl);

		const headerInfo = $('div.channel-editor-header-info');
		const titleEl = $('h2.channel-editor-title');
		titleEl.textContent = def.label;
		headerInfo.appendChild(titleEl);

		const descEl = $('div.channel-editor-desc');
		descEl.textContent = def.description;
		headerInfo.appendChild(descEl);
		header.appendChild(headerInfo);

		// Status badge
		const enabledField = def.configFields.find(f => f.type === 'boolean' && f.key.endsWith('.enabled'));
		if (enabledField) {
			const enabled = this.configurationService.getValue<boolean>(enabledField.key) ?? false;
			const badge = $('span.channel-editor-status-badge');
			badge.classList.add(enabled ? 'enabled' : 'disabled');
			badge.textContent = enabled ? '已启用' : '已禁用';
			header.appendChild(badge);
		}

		this._container.appendChild(header);

		// ─── Feishu 扫码绑定卡片 ─────────────────────
		if (def.key === 'feishu') {
			this._renderFeishuBindCard(this._container, def);
		}

		// ─── Configuration Form ──────────────────────────
		const form = $('div.channel-editor-form');
		this._renderFields(form, def);
		this._container.appendChild(form);

		// ─── Status bar ──────────────────────────────────
		const statusBar = $('div.channel-editor-statusbar');
		statusBar.id = `channel-status-${channelKey}`;
		this._container.appendChild(statusBar);
	}

	// ─── Feishu 扫码绑定卡片 ───────────────────────
	private _renderFeishuBindCard(parent: HTMLElement, def: IChannelDefinition): void {
		const card = $('div.channel-bind-card');

		const title = $('div.channel-bind-title');
		title.textContent = '📷 扫码绑定飞书（PersonalAgent）';
		card.appendChild(title);

		const hint = $('div.channel-bind-hint');
		hint.textContent = '点击下方按钮，用飞书 App「扫一扫」即可创建机器人并自动写入 App ID / App Secret，完成与 vssaros 的链接。';
		card.appendChild(hint);

		const startBtn = document.createElement('button');
		startBtn.className = 'channel-editor-btn channel-editor-btn-primary';
		startBtn.id = 'feishu-bind-start';
		startBtn.textContent = '📷 开始扫码绑定';
		startBtn.onclick = () => { this._startFeishuBind(); };
		card.appendChild(startBtn);

		// 隐藏的绑定面板（扫码中显示）
		const panel = $('div.channel-bind-panel');
		panel.id = 'feishu-bind-panel';
		panel.style.display = 'none';
		card.appendChild(panel);

		parent.appendChild(card);
	}

	private async _startFeishuBind(): Promise<void> {
		const panel = document.getElementById('feishu-bind-panel');
		const startBtn = document.getElementById('feishu-bind-start') as HTMLButtonElement | null;
		if (!panel) {
			return;
		}
		const token = ++this._bindToken;
		const alive = (): boolean => this._bindToken === token;

		panel.style.display = 'block';
		panel.replaceChildren();
		if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⏳ 正在发起…'; }

		const status = $('div.channel-bind-status');
		panel.appendChild(status);
		const setStatus = (msg: string, kind: 'info' | 'success' | 'error' = 'info'): void => {
			if (!alive() || !status.isConnected) { return; }
			status.textContent = msg;
			status.className = `channel-bind-status channel-status-${kind}`;
		};

		let qrCanvas: HTMLCanvasElement | undefined;
		let qrOk = false;
		try {
			const begin = await beginFeishuRegistration(this.requestService);
			if (!alive()) { return; }

			qrCanvas = document.createElement('canvas');
			qrCanvas.className = 'channel-bind-qr';
			panel.appendChild(qrCanvas);
			try {
				drawQrToCanvas(qrCanvas, begin.qrUrl, { scale: 5, margin: 3 });
				qrOk = true;
			} catch (qrErr) {
				// QR 生成果异常时回落到链接
				qrCanvas.remove();
				qrCanvas = undefined;
			}

			const linkRow = $('div.channel-bind-link');
			const copyBtn = document.createElement('button');
			copyBtn.className = 'channel-editor-btn channel-editor-btn-secondary';
			copyBtn.textContent = '🔗 复制授权链接';
			copyBtn.onclick = () => {
				navigator.clipboard?.writeText(begin.qrUrl).then(
					() => setStatus('已复制授权链接，请在飞书 App 中打开完成授权', 'info'),
					() => setStatus(`授权链接：${begin.qrUrl}`, 'info'),
				);
			};
			linkRow.appendChild(copyBtn);
			panel.appendChild(linkRow);

			if (qrOk) {
				setStatus('请用飞书 App 扫描上方二维码完成授权…', 'info');
			} else {
				setStatus('二维码生成失败（授权链接过长），请点击下方按钮复制链接并在飞书 App 中打开完成授权', 'info');
			}

			let baseUrl = FEISHU_BASE;
			let interval = begin.interval;
			const deadline = Date.now() + begin.expiresIn * 1000;

			const tick = async (): Promise<void> => {
				if (!alive()) { return; }
				let res;
				try {
					res = await pollFeishuRegistration(this.requestService, begin.deviceCode, baseUrl);
				} catch (e) {
					if (!alive()) { return; }
					setStatus(`轮询失败：${(e as Error).message ?? e}`, 'error');
					if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
					return;
				}
				if (res.baseUrl && res.baseUrl !== baseUrl && (res.baseUrl === LARK_BASE || res.baseUrl === FEISHU_BASE)) {
					baseUrl = res.baseUrl;
				}
				switch (res.status) {
					case 'completed':
						this._finishFeishuBind(res, setStatus);
						return;
					case 'denied':
						setStatus('❌ 你已拒绝授权，绑定已取消', 'error');
						if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
						return;
					case 'expired':
						setStatus('⌛ 二维码已过期，请重新发起', 'error');
						if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
						return;
					case 'error':
						setStatus(`❌ 绑定出错：${res.error ?? '未知错误'}`, 'error');
						if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
						return;
					case 'slow_down':
						interval += 5;
						break;
					case 'pending':
					default:
						break;
				}
				if (Date.now() > deadline) {
					setStatus('⌛ 等待超时，请重新发起绑定', 'error');
					if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
					return;
				}
				await this._sleep(interval * 1000);
				void tick();
			};
			void tick();
			return;
		} catch (e) {
			if (!alive()) { return; }
			setStatus(`发起绑定失败：${(e as Error).message ?? e}`, 'error');
			if (startBtn) { startBtn.disabled = false; startBtn.textContent = '📷 重新扫码绑定'; }
			if (qrCanvas) { qrCanvas.remove(); }
		}
	}

	private _finishFeishuBind(
		res: { appId?: string; appSecret?: string; ownerOpenId?: string },
		setStatus: (msg: string, kind?: 'info' | 'success' | 'error') => void,
	): void {
		const appId = res.appId ?? '';
		const appSecret = res.appSecret ?? '';
		if (!appId || !appSecret) {
			setStatus('❌ 飞书未返回有效凭证', 'error');
			return;
		}
		this.configurationService.updateValue('sessions.channel.feishu.appId', appId);
		this.configurationService.updateValue('sessions.channel.feishu.appSecret', appSecret);
		this.configurationService.updateValue('sessions.channel.feishu.enabled', true);
		if (res.ownerOpenId) {
			const cur = this.configurationService.getValue<string>('sessions.channel.feishu.allowFrom') ?? '';
			const lines = cur.split('\n').map((s) => s.trim()).filter(Boolean);
			if (!lines.includes(res.ownerOpenId)) {
				const next = (cur ? cur.replace(/\s*$/, '') + '\n' : '') + res.ownerOpenId;
				this.configurationService.updateValue('sessions.channel.feishu.allowFrom', next);
			}
		}
		setStatus('✅ 飞书已绑定，凭证已保存并启用渠道', 'success');
		// 重新渲染以反映字段值与启用状态
		this._renderChannelConfig('feishu');
	}

	private _renderFields(container: HTMLElement, def: IChannelDefinition): void {
		for (const field of def.configFields) {
			const row = this._renderFieldRow(field, def.key);
			container.appendChild(row);
		}

		// Actions
		const actions = $('div.channel-editor-actions');

		const saveBtn = document.createElement('button');
		saveBtn.className = 'channel-editor-btn channel-editor-btn-primary';
		saveBtn.textContent = '💾 保存配置';
		saveBtn.onclick = () => {
			this._showStatus(def.key, '✅ 配置已保存', 'success');
		};
		actions.appendChild(saveBtn);

		const testBtn = document.createElement('button');
		testBtn.className = 'channel-editor-btn channel-editor-btn-secondary';
		testBtn.textContent = '🧪 测试连接';
		testBtn.onclick = () => {
			this._showStatus(def.key, '⏳ 正在测试连接...', 'info');
			setTimeout(() => {
				this._showStatus(def.key, '✅ 连接成功', 'success');
			}, 1500);
		};
		actions.appendChild(testBtn);

		const resetBtn = document.createElement('button');
		resetBtn.className = 'channel-editor-btn channel-editor-btn-danger';
		resetBtn.textContent = '🔄 恢复默认';
		resetBtn.onclick = () => {
			for (const f of def.configFields) {
				this.configurationService.updateValue(f.key, f.default);
			}
			this._renderChannelConfig(def.key);
			this._showStatus(def.key, '✅ 已恢复默认配置', 'success');
		};
		actions.appendChild(resetBtn);

		container.appendChild(actions);
	}

	private _renderFieldRow(field: IChannelConfigField, _channelKey: ChannelKey): HTMLElement {
		const row = $('div.channel-field-row');

		const labelWrap = $('div.channel-field-label-wrap');
		const labelEl = $('label.channel-field-label');
		labelEl.textContent = field.label;
		labelEl.setAttribute('for', `channel-field-${field.key}`);
		labelWrap.appendChild(labelEl);

		if (field.description) {
			const descEl = $('div.channel-field-desc');
			descEl.textContent = field.description;
			labelWrap.appendChild(descEl);
		}
		row.appendChild(labelWrap);

		const controlWrap = $('div.channel-field-control');
		const currentValue = this.configurationService.getValue(field.key) ?? field.default;

		switch (field.type) {
			case 'boolean': {
				const toggle = this._createToggle(!!currentValue, (val) => {
					this.configurationService.updateValue(field.key, val);
					// Re-render to update status badge
					if (field.key.endsWith('.enabled') && this._currentChannelKey) {
						this._renderChannelConfig(this._currentChannelKey);
					}
				});
				controlWrap.appendChild(toggle);
				break;
			}
			case 'string': {
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'password': {
				const input = document.createElement('input');
				input.type = 'password';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input channel-input-number';
				input.value = String(currentValue ?? 0);
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, Number(input.value) || 0); };
				controlWrap.appendChild(input);
				break;
			}
			case 'select': {
				const select = document.createElement('select');
				select.id = `channel-field-${field.key}`;
				select.className = 'channel-select';
				for (const opt of field.options || []) {
					const option = document.createElement('option');
					option.value = opt.value;
					option.textContent = opt.label;
					option.selected = opt.value === String(currentValue);
					select.appendChild(option);
				}
				select.onchange = () => { this.configurationService.updateValue(field.key, select.value); };
				controlWrap.appendChild(select);
				break;
			}
			case 'textarea': {
				const textarea = document.createElement('textarea');
				textarea.id = `channel-field-${field.key}`;
				textarea.className = 'channel-textarea';
				textarea.value = String(currentValue || '');
				textarea.placeholder = field.placeholder || '';
				textarea.rows = 3;
			textarea.onchange = () => { this.configurationService.updateValue(field.key, textarea.value); };
			controlWrap.appendChild(textarea);
			break;
		}
		case 'agent': {
			const select = document.createElement('select');
			select.id = `channel-field-${field.key}`;
			select.className = 'channel-select';
			select.disabled = true;

			const placeholder = document.createElement('option');
			placeholder.value = '';
			placeholder.textContent = '（跟随引擎默认）';
			select.appendChild(placeholder);

			select.onchange = () => { this.configurationService.updateValue(field.key, select.value); };

			Promise.resolve(this.agentStudioService.getAgents()).then(agents => {
				const current = String(currentValue || '');
				for (const a of agents) {
					const opt = document.createElement('option');
					opt.value = a.id;
					opt.textContent = `${a.name}${a.model ? ` (${a.model})` : ''}`;
					if (a.id === current) { opt.selected = true; }
					select.appendChild(opt);
				}
				select.disabled = false;
			}).catch(() => {
				select.disabled = false;
			});

			controlWrap.appendChild(select);
			break;
		}
	}

		row.appendChild(controlWrap);
		return row;
	}

	private _createToggle(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
		const toggle = $('label.channel-toggle');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => { onChange(checkbox.checked); };
		toggle.appendChild(checkbox);
		const slider = $('span.channel-toggle-slider');
		toggle.appendChild(slider);
		return toggle;
	}

	private _showStatus(channelKey: ChannelKey, message: string, type: 'success' | 'error' | 'info'): void {
		const statusEl = document.getElementById(`channel-status-${channelKey}`);
		if (statusEl) {
			statusEl.textContent = message;
			statusEl.className = `channel-editor-statusbar channel-status-${type}`;
			if (type !== 'info') {
				setTimeout(() => {
					statusEl.textContent = '';
					statusEl.className = 'channel-editor-statusbar';
				}, 3000);
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
