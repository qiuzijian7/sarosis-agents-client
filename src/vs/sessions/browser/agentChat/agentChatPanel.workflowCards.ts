import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { renderMarkdown } from '../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveCollectVariable, ILiveWorkflowSubAgent } from './agentChatTypes.js';
import { AgentChatPanelDelegateCards } from './agentChatPanel.delegateCards.js';

/**
 * 工作流实时执行可视化：trace 视图 / 变量收集卡 / 节点卡 / 时间线。
 * 自 agentChatPanel.delegateCards.ts 抽离（上帝对象拆分 P5c）。
 */
export abstract class AgentChatPanelWorkflowCards extends AgentChatPanelDelegateCards {

	protected override _createLiveWorkflowTraceView(
			workflowExecutions: Record<string, ILiveWorkflowExecution>,
			workflowEvents?: ILiveWorkflowEvent[],
			collectVariables?: Record<string, ILiveCollectVariable>
		): HTMLElement {
			const container = $('.wf-trace');

			for (const [execId, exec] of Object.entries(workflowExecutions)) {
				// ── Workflow Card ──
				const card = append(container, $('.wf-card'));
				card.classList.add(exec.status); // running | completed | failed | cancelled

				// ── Header ──
				const header = append(card, $('.wf-header'));
				const toggle = append(header, $('span.wf-toggle', undefined, '▼'));
				append(header, $('span.wf-icon', undefined, '🔀'));
				append(header, $('span.wf-name', undefined, exec.workflowName || 'Workflow'));
				const statusMap: Record<string, { label: string; cls: string }> = {
					running: { label: '运行中', cls: 'running' },
					completed: { label: '已完成', cls: 'completed' },
					failed: { label: '失败', cls: 'failed' },
					cancelled: { label: '已取消', cls: 'cancelled' },
				};
				const sInfo = statusMap[exec.status] ?? { label: exec.status, cls: 'running' };
				const badge = append(header, $('span.wf-status-badge'));
				badge.classList.add(sInfo.cls);
				if (sInfo.cls === 'running') {
					append(badge, $('span.dot'));
					append(badge, document.createTextNode(sInfo.label));
				} else {
					const icon = sInfo.cls === 'completed' ? '✓' : sInfo.cls === 'failed' ? '✗' : '⛔';
					append(badge, document.createTextNode(`${icon} ${sInfo.label}`));
				}

				// ── Body ──
				const body = append(card, $('.wf-body'));

				// ── Collect Variables Card (if pending) ──
				if (collectVariables) {
					const vars = Object.values(collectVariables).filter(v => v.executionId === execId);
					for (const cv of vars) {
						if (cv.status === 'pending') {
							body.appendChild(this._createCollectVarsCard(execId, cv));
						}
					}
				}

				// ── Node Cards ──
				for (const sa of exec.subAgents) {
					if (sa.id === '__workflow__') { continue; } // skip synthetic root
					body.appendChild(this._createNodeCard(sa));
				}

				// ── Timeline ──
				if (workflowEvents && workflowEvents.length > 0) {
					const events = workflowEvents.filter(e => e.executionId === execId);
					if (events.length > 0) {
						card.appendChild(this._createTimeline(exec, events));
					}
				}

				// ── Header toggle ──
				this._register(addDisposableListener(header, EventType.CLICK, () => {
					const isHidden = body.style.display === 'none';
					body.style.display = isHidden ? '' : 'none';
					toggle.textContent = isHidden ? '▼' : '▶';
					toggle.classList.toggle('collapsed', !isHidden);
				}));
			}

			return container;
		}

	protected override _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement {
			const card = $('.collect-vars-card');
			const header = append(card, $('.collect-vars-header'));
			append(header, $('span.icon', undefined, '📝'));
			append(header, $('span.title', undefined, '请填入工作流变量'));

			const form = append(card, $('.collect-vars-form'));
			const inputs: HTMLInputElement[] = [];
			for (const v of cv.variables) {
				const field = append(form, $('.collect-vars-field'));
				append(field, $('label', undefined, `${v.name}${v.defaultValue ? ` (默认: ${v.defaultValue})` : ''}`));
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'collect-vars-input';
				input.placeholder = v.defaultValue ? `默认: ${v.defaultValue}` : `请输入 ${v.name}`;
				input.value = cv.values[v.name] ?? v.defaultValue ?? '';
				field.appendChild(input);
				inputs.push(input);
			}
			if (this._onSubmitVariables) {
				const btn = append(form, $('button.collect-vars-submit', undefined, '提交')) as HTMLButtonElement;
				this._register(addDisposableListener(btn, EventType.CLICK, () => {
					const values: Record<string, string> = {};
					cv.variables.forEach((v, i) => { values[v.name] = inputs[i]?.value ?? v.defaultValue ?? ''; });
					this._onSubmitVariables!(execId, values);
					btn.disabled = true;
					btn.textContent = '已提交';
				}));
			}
			return card;
		}

	protected override _createNodeCard(sa: ILiveWorkflowSubAgent): HTMLElement {
			const isRunning = sa.status === 'running';
			const isDone = sa.status === 'done';
			const isError = sa.status === 'error';

			const card = $('.node-card');
			card.classList.add(sa.status); // running | done | error | pending | cancelled

			// ── Collapse state (persists across re-renders) ──
			const userCollapsed = this._nodeCollapsedState.get(sa.id) === true;
			if (userCollapsed) { card.classList.add('collapsed'); }

			// ── Header ──
			const header = append(card, $('.node-header'));

			// Type icon
			const typeIcons: Record<string, { icon: string; cls: string }> = {
				agent: { icon: '🤖', cls: 'agent' },
				prompt: { icon: '📝', cls: 'prompt' },
				skill: { icon: '⚡', cls: 'skill' },
				tool: { icon: '🔧', cls: 'tool' },
			};
			const typeKey = (sa as any).type ?? 'agent';
			const tInfo = typeIcons[typeKey] ?? typeIcons.agent;
			const iconEl = append(header, $('.node-type-icon'));
			iconEl.classList.add(tInfo.cls);
			iconEl.textContent = tInfo.icon;

			// Info (name + task)
			const info = append(header, $('.node-info'));
			append(info, $('.node-name', undefined, sa.name));
			if (sa.task) {
				append(info, $('.node-task', undefined, sa.task));
			}

			// ── Collapse/expand button ──
			const collapseBtn = append(header, $('button.node-collapse-btn'));
			collapseBtn.classList.add(userCollapsed ? 'collapsed' : 'expanded');
			collapseBtn.title = userCollapsed ? '点击展开' : '点击收缩';
			const chevron = append(collapseBtn, $('span.icon-chevron'));
			chevron.textContent = userCollapsed ? '▶' : '▼';

			// Status indicator
			const statusEl = append(header, $('.node-status'));
			// Duration
			const dur = sa.endTime ? ((sa.endTime - sa.startTime) / 1000).toFixed(1) + 's' : isRunning ? '...' : '';
			if (dur) { append(statusEl, $('span.node-duration', undefined, dur)); }
			// Icon
			if (isRunning) {
				append(statusEl, $('span.spinner'));
			} else if (isDone) {
				append(statusEl, $('span.check', undefined, '✓'));
			} else if (isError) {
				append(statusEl, $('span.error', undefined, '✗'));
			} else {
				append(statusEl, $('span.node-pending', undefined, '等待中'));
			}

			// ── Body (collapsible) ──
			const nodeBody = append(card, $('.node-body'));
			if (userCollapsed) { nodeBody.style.display = 'none'; }

			// Streamed text / output / error
			if (isRunning && sa.streamedText) {
				const out = append(nodeBody, $('.node-output.running'));
				const md: IMarkdownString = { value: sa.streamedText, isTrusted: true, supportHtml: true };
				// Use renderMarkdown with parent element to track disposable lifecycle
				const prevDisposable = this._markdownDisposables.get(out);
				if (prevDisposable) { prevDisposable.dispose(); }
				this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
			} else if (isDone && (sa.output || sa.streamedText)) {
				const out = append(nodeBody, $('.node-output.done'));
				const text = sa.output || sa.streamedText || '';
				const md: IMarkdownString = { value: text, isTrusted: true, supportHtml: true };
				const prevDisposable = this._markdownDisposables.get(out);
				if (prevDisposable) { prevDisposable.dispose(); }
				this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
			} else if (isError && sa.error) {
				const out = append(nodeBody, $('.node-output.error'));
				out.textContent = sa.error;
			}

			// Tool calls
			if (sa.toolCalls && sa.toolCalls.length > 0) {
				const toolList = append(nodeBody, $('.tool-list'));
				for (const tc of sa.toolCalls as any[]) {
					const item = append(toolList, $('.tool-item'));
					const ti = append(item, $('.tool-icon'));
					ti.textContent = '🔧';
					append(item, $('span.tool-name', undefined, tc.name ?? 'unknown'));
					const ts = append(item, $('span.tool-status'));
					ts.classList.add(tc.status ?? 'done');
					const tIcon = tc.status === 'running' ? 'running...' : tc.status === 'error' ? '✗ error' : '✓ done';
					ts.textContent = tIcon;
				}
			}

			// ── Summary row (visible only when collapsed) ──
			const summary = append(card, $('.node-summary'));
			summary.style.display = userCollapsed ? 'block' : 'none';
			const toolCount = sa.toolCalls?.length ?? 0;
			const outputLen = (sa.output?.length ?? sa.streamedText?.length ?? 0);
			const parts: string[] = [];
			if (toolCount > 0) { parts.push(`${toolCount} 个工具调用`); }
			if (outputLen > 0) { parts.push(`输出约 ${outputLen} 字`); }
			if (isRunning) { parts.unshift('处理中'); }
			append(summary, $('span.node-summary-text', undefined, parts.join(' · ') || '暂无输出'));

			// ── Collapse/expand interaction ──
			// Toggle via button click. State is persisted in _nodeCollapsedState
			// so that DOM rebuilds (streaming updates) respect the user's choice
			// and do NOT auto-expand a manually-collapsed node.
			this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
			}));
			// Also allow header click (excluding the button itself) to toggle
			this._register(addDisposableListener(header, EventType.CLICK, (e) => {
				if (e.target === collapseBtn || collapseBtn.contains(e.target as Node)) { return; }
				this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
			}));

			return card;
		}

	protected override _createTimeline(exec: ILiveWorkflowExecution, events: ILiveWorkflowEvent[]): HTMLElement {
			const timeline = $('.wf-timeline');

			// Build ordered node list from events
			const nodeOrder: string[] = [];
			const nodeStatus: Record<string, string> = {};
			for (const e of events) {
				if (e.kind === 'subagent_start' && e.nodeId !== '__workflow__' && !nodeOrder.includes(e.nodeId)) {
					nodeOrder.push(e.nodeId);
				}
				if (e.kind === 'subagent_start') {
					nodeStatus[e.nodeId] = 'active';
				}
				if (e.kind === 'subagent_end') {
					nodeStatus[e.nodeId] = e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : 'done';
				}
			}
			// Also include nodes from subAgents
			for (const sa of exec.subAgents) {
				if (sa.id === '__workflow__') { continue; }
				if (!nodeOrder.includes(sa.id)) { nodeOrder.push(sa.id); }
				if (sa.status === 'running') { nodeStatus[sa.id] = 'active'; }
				else if (sa.status === 'done') { nodeStatus[sa.id] = 'done'; }
				else if (sa.status === 'error') { nodeStatus[sa.id] = 'error'; }
			}

			// Render: start → node1 → node2 → ... → end
			append(timeline, this._createTimelineItem('start', exec.status === 'running' ? 'active' : 'done'));
			for (let i = 0; i < nodeOrder.length; i++) {
				const nodeId = nodeOrder[i];
				const label = events.find(e => e.nodeId === nodeId)?.nodeName ?? nodeId;
				const st = nodeStatus[nodeId] ?? '';
				append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
				append(timeline, this._createTimelineItem(label, st));
			}
		append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
		const endStatus = exec.status === 'completed' ? 'done' : exec.status === 'failed' ? 'error' : exec.status === 'cancelled' ? 'done' : 'active';
		append(timeline, this._createTimelineItem('end', endStatus));

			return timeline;
		}

	protected override _createTimelineItem(label: string, status: string): HTMLElement {
			const el = $('.wf-timeline-item');
			if (status) { el.classList.add(status); }
			el.textContent = label;
			return el;
		}
}