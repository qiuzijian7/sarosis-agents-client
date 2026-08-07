import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IConfirmationData, ILiveWorkflowAskUser } from './agentChatTypes.js';
import { AgentChatPanelStatusCards } from './agentChatPanel.statusCards.js';

/** 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分）。继承链见继承父类。 */
export abstract class AgentChatPanelConfirmCards extends AgentChatPanelStatusCards {
	protected override _createConfirmationCard(cf: IConfirmationData): HTMLElement {
			// Terminal confirmation card (has command field)
			if (cf.command) {
				return this._createTerminalConfirmationCard(cf);
			}

			const card = $('.confirmation-card');
			const header = append(card, $('.confirmation-card-header'));
			append(header, $('span.confirmation-card-title', undefined, cf.title));
			// Security level badge
			if (cf.securityLevel) {
				const badge = append(header, $(`span.security-badge.${cf.securityLevel}`));
				badge.textContent = cf.securityLevel === 'safe' ? '安全' : cf.securityLevel === 'cautious' ? '注意' : '危险';
			}
			const body = append(card, $('.confirmation-card-body'));
			append(body, $('p.confirmation-card-message', undefined, cf.message));
			if (cf.detail) {
				append(body, $('pre.confirmation-card-detail', undefined, cf.detail));
			}
			const actions = append(body, $('.confirmation-card-actions'));
			// Main action buttons
			for (const btn of cf.buttons) {
				const el = append(actions, $(
					`button.confirmation-card-btn${btn.primary ? '.primary' : ''}${btn.danger ? '.danger' : ''}`,
					undefined,
					btn.label,
				));
				this._register(addDisposableListener(el, EventType.CLICK, () => {
					this._onConfirmationAction?.(cf.id, btn.id);
				}));
			}
			// Auto-confirm options (once/session/workspace/always)
			if (cf.autoConfirmOptions?.length) {
				const autoSection = append(body, $('.confirmation-auto-options'));
				append(autoSection, $('span.confirmation-auto-options-label', undefined, '自动确认:'));
				for (const opt of cf.autoConfirmOptions) {
					const btn = append(autoSection, $('button.confirmation-auto-btn'));
					btn.textContent = opt.label;
					this._register(addDisposableListener(btn, EventType.CLICK, () => {
						this._onConfirmationAction?.(cf.id, opt.id);
					}));
				}
			}
			return card;
		}

	protected override _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement {
			const card = $('.confirmation-card.confirmation-card-terminal');
			const header = append(card, $('.confirmation-title-bar'));
			const titleContent = append(header, $('.confirmation-title-content'));
			// Terminal icon (chevron-right + line)
			const svgIcon = append(titleContent, $('svg'));
			svgIcon.setAttribute('width', '16');
			svgIcon.setAttribute('height', '16');
			svgIcon.setAttribute('viewBox', '0 0 24 24');
			svgIcon.setAttribute('fill', 'none');
			svgIcon.setAttribute('stroke', 'currentColor');
			svgIcon.setAttribute('stroke-width', '2');
			const polyline = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			polyline.setAttribute('points', '4 17 10 11 4 5');
			svgIcon.appendChild(polyline);
			const line = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '12');
			line.setAttribute('y1', '19');
			line.setAttribute('x2', '20');
			line.setAttribute('y2', '19');
			svgIcon.appendChild(line);

			append(titleContent, $('span.confirmation-title', undefined, '执行终端命令'));
			const badge = append(titleContent, $('span.confirmation-security-badge.security-cautious'));
			badge.textContent = '终端操作';

			// Command preview
			const cmdSection = append(card, $('.confirmation-terminal-command'));
			const cmdHeader = append(cmdSection, $('.terminal-command-header'));
			append(cmdHeader, $('span.terminal-prompt', undefined, '$'));
			const cmdText = cf.command || '';
			const isLong = cmdText.length > 100;
			const displayCmd = isLong ? cmdText.substring(0, 100) + '...' : cmdText;
			append(cmdHeader, $('code.terminal-command-text', undefined, displayCmd));

			if (isLong) {
				const showMoreBtn = append(cmdSection, $('button.terminal-show-more-btn'));
				showMoreBtn.textContent = '显示全部';
				// Toggle logic would need state management - simplified for now
			}

			// Action buttons
			const actions = append(card, $('.confirmation-actions'));
			const primaryAction = append(actions, $('.confirmation-primary-action'));

			const approveBtn = append(primaryAction, $('button.confirmation-btn.confirmation-btn-approve'));
			const approveSvg = append(approveBtn, $('svg'));
			approveSvg.setAttribute('width', '14');
			approveSvg.setAttribute('height', '14');
			approveSvg.setAttribute('viewBox', '0 0 24 24');
			approveSvg.setAttribute('fill', 'none');
			approveSvg.setAttribute('stroke', 'currentColor');
			approveSvg.setAttribute('stroke-width', '2');
			const approvePolyline = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			approvePolyline.setAttribute('points', '20 6 9 17 4 12');
			approveSvg.appendChild(approvePolyline);
			approveBtn.appendChild(this._ownerDocument.createTextNode('执行'));
			this._register(addDisposableListener(approveBtn, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, 'allow_once');
			}));

			// Dropdown for more options
			const dropdownContainer = append(primaryAction, $('.confirmation-dropdown-container'));
			const dropdownToggle = append(dropdownContainer, $('button.confirmation-dropdown-toggle'));
			const toggleSvg = append(dropdownToggle, $('svg'));
			toggleSvg.setAttribute('width', '12');
			toggleSvg.setAttribute('height', '12');
			toggleSvg.setAttribute('viewBox', '0 0 24 24');
			toggleSvg.setAttribute('fill', 'none');
			toggleSvg.setAttribute('stroke', 'currentColor');
			toggleSvg.setAttribute('stroke-width', '2');
			const togglePolyline = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			togglePolyline.setAttribute('points', '6 9 12 15 18 9');
			toggleSvg.appendChild(togglePolyline);

			const dropdownMenu = append(dropdownContainer, $('.confirmation-dropdown-menu'));
			for (const opt of (cf.autoConfirmOptions || [
				{ id: 'allow_session', label: '在此会话中允许' },
				{ id: 'allow_workspace', label: '在工作区中允许' },
				{ id: 'allow_always', label: '始终允许' },
			])) {
				const item = append(dropdownMenu, $('button.confirmation-dropdown-item'));
				item.textContent = opt.label;
				this._register(addDisposableListener(item, EventType.CLICK, () => {
					this._onConfirmationAction?.(cf.id, opt.id);
				}));
			}

			// Reject button
			const rejectBtn = append(actions, $('button.confirmation-btn.confirmation-btn-reject'));
			const rejectSvg = append(rejectBtn, $('svg'));
			rejectSvg.setAttribute('width', '14');
			rejectSvg.setAttribute('height', '14');
			rejectSvg.setAttribute('viewBox', '0 0 24 24');
			rejectSvg.setAttribute('fill', 'none');
			rejectSvg.setAttribute('stroke', 'currentColor');
			rejectSvg.setAttribute('stroke-width', '2');
			const rejectLine1 = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
			rejectLine1.setAttribute('x1', '18');
			rejectLine1.setAttribute('y1', '6');
			rejectLine1.setAttribute('x2', '6');
			rejectLine1.setAttribute('y2', '18');
			rejectSvg.appendChild(rejectLine1);
			const rejectLine2 = this._ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
			rejectLine2.setAttribute('x1', '6');
			rejectLine2.setAttribute('y1', '6');
			rejectLine2.setAttribute('x2', '18');
			rejectLine2.setAttribute('y2', '18');
			rejectSvg.appendChild(rejectLine2);
			rejectBtn.appendChild(this._ownerDocument.createTextNode('取消'));
			this._register(addDisposableListener(rejectBtn, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, 'reject');
			}));

			return card;
		}

	protected override _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement {
			const card = $(`.askuser-card.${askUser.status}`);
			const isPending = askUser.status === 'pending';
			const isAnswered = askUser.status === 'answered';

			// Header
			const header = append(card, $('.askuser-card-header'));
			const headerStatus = isPending
				? { icon: '❓', label: '需要输入', color: 'var(--vscode-charts-blue, #60a5fa)' }
				: isAnswered
					? { icon: '✓', label: '已回答', color: 'var(--vscode-charts-green, #34d399)' }
					: { icon: '⊘', label: askUser.status === 'cancelled' ? '已取消' : '已过期', color: 'var(--as-fg-secondary, #6c757d)' };
			append(header, $('span.askuser-card-icon', { style: `color:${headerStatus.color}` }, headerStatus.icon));
			append(header, $('span.askuser-card-title', undefined, askUser.nodeName));
			append(header, $('span.askuser-card-status', { style: `color:${headerStatus.color}` }, headerStatus.label));

			// Question
			append(card, $('div.askuser-card-question', undefined, askUser.question));

			// Options (interactive only while pending)
			if (isPending) {
				const optionsDiv = append(card, $(`.askuser-options.${askUser.multiSelect ? 'multi' : 'single'}`));
				askUser.options.forEach((opt, idx) => {
					const isSelected = askUser.selectedIndices.includes(idx);
					const optBtn = append(optionsDiv, $('button.askuser-option' + (isSelected ? '.selected' : '')));
					this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
						// Toggle selection
						const current = askUser.selectedIndices.slice();
						if (askUser.multiSelect) {
							const has = current.includes(idx);
							const next = has ? current.filter(i => i !== idx) : [...current, idx].sort((a, b) => a - b);
							askUser.selectedIndices = next;
						} else {
							askUser.selectedIndices = [idx];
						}
						// Re-render this card
						const msgEl = card.closest('.chat-message') as HTMLElement;
						if (msgEl) {
							const msgId = msgEl.dataset.msgId;
							if (msgId) {
								const msg = this._messages.find(m => m.id === msgId);
								if (msg) { this._updateMessageDom(this._messages.indexOf(msg), msg); }
							}
						}
					}));
					append(optBtn, $('span.askuser-option-marker', undefined, askUser.multiSelect ? (isSelected ? '☑' : '☐') : (isSelected ? '●' : '○')));
					const body = append(optBtn, $('span.askuser-option-body'));
					append(body, $('span.askuser-option-label', undefined, opt.label));
					if (opt.description) {
						append(body, $('span.askuser-option-description', undefined, opt.description));
					}
				});

				// Submit button
				const actions = append(card, $('.askuser-actions'));
				const canSubmit = askUser.selectedIndices.length > 0;
				const submitBtn = append(actions, $('button.askuser-submit' + (canSubmit ? '' : '.disabled'))) as HTMLButtonElement;
				submitBtn.textContent = askUser.multiSelect ? `提交选择 (${askUser.selectedIndices.length})` : '提交';
				submitBtn.disabled = !canSubmit;
				this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
					if (!canSubmit) { return; }
					const selectedLabels = askUser.selectedIndices.map(i => askUser.options[i]?.label).filter(Boolean);
					// Call onAskUserSubmit callback
					this._onAskUserSubmit?.(askUser.id, askUser.executionId, askUser.nodeId, askUser.multiSelect ? selectedLabels : selectedLabels[0] ?? '');
				}));
			}

			// Answered summary (read-only)
			if (isAnswered) {
				const answerDiv = append(card, $('.askuser-answer'));
				append(answerDiv, $('div.askuser-answer-label', undefined, '已选择:'));
				const valuesDiv = append(answerDiv, $('.askuser-answer-values'));
				const selection = Array.isArray(askUser.selection) ? askUser.selection : [askUser.selection];
				selection.forEach(s => {
					if (typeof s === 'string' && s.length > 0) {
						append(valuesDiv, $('span.askuser-answer-chip', undefined, s));
					}
				});
			}

			return card;
		}
}
