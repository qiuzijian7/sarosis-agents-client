/*---------------------------------------------------------------------------------------------
 *  History overlay renderer — extracted from agentChatPanel.ts
 *  Renders session history list with rename/delete/select actions.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import type { IAgentSessionMeta } from '../agentChatTypes.js';

export interface HistoryCallbacks {
	onRenameSession?: (sessionId: string, newName: string) => void;
	onDeleteSession?: (sessionId: string) => void;
	onForkSession?: (sessionId: string) => void;
	onOpenSession?: (sessionId: string) => void;
	onNewSession?: () => void;
	onClose: () => void;
}

export interface HistoryContext {
	readonly agentSessions: ReadonlyArray<IAgentSessionMeta>;
}

export function renderHistoryOverlay(
	container: HTMLElement,
	context: HistoryContext,
	cbs: HistoryCallbacks,
	registerFn: (d: IDisposable) => IDisposable,
): HTMLElement {
	const overlay = append(container, $(".chat-history-overlay"));

	// Header
	const header = append(overlay, $(".chat-history-header"));
	append(header, $("span.chat-history-title", undefined, '聊天历史'));

	// Close button
	const closeBtn = append(header, $("button.chat-history-close-btn"));
	closeBtn.title = '关闭';
	const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	closeSvg.setAttribute('width', '16'); closeSvg.setAttribute('height', '16');
	closeSvg.setAttribute('viewBox', '0 0 24 24');
	closeSvg.setAttribute('fill', 'none'); closeSvg.setAttribute('stroke', 'currentColor');
	closeSvg.setAttribute('stroke-width', '2'); closeSvg.setAttribute('stroke-linecap', 'round');
	closeSvg.setAttribute('stroke-linejoin', 'round');
	const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
	closeSvg.appendChild(closePath);
	closeBtn.appendChild(closeSvg);
	registerFn(addDisposableListener(closeBtn, EventType.CLICK, () => cbs.onClose()));

	// Content
	const content = append(overlay, $(".chat-history-content"));
	if (context.agentSessions.length === 0) {
		append(content, $(".chat-history-empty", undefined, '当前 Agent 暂无历史会话'));
	} else {
		const list = append(content, $(".chat-history-list"));
		for (const s of context.agentSessions) {
			const item = append(list, $(".chat-history-item"));
			const info = append(item, $(".chat-history-item-info"));
			const nameEl = append(info, $("span.chat-history-item-name", undefined, s.name));
			const time = append(info, $("span.chat-history-item-time"));
			time.textContent = formatRelativeTime(s.updatedAt);

			const actions = append(item, $(".chat-history-item-actions"));
			// Fork (copy → independent session 试探性会话, 对齐 LangGraph copy_thread)
			const forkBtn = append(actions, $("button.chat-history-item-btn"));
			forkBtn.title = '复制会话（分叉为独立会话）';
			const forkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			forkSvg.setAttribute('width', '14'); forkSvg.setAttribute('height', '14');
			forkSvg.setAttribute('viewBox', '0 0 24 24');
			forkSvg.setAttribute('fill', 'none'); forkSvg.setAttribute('stroke', 'currentColor');
			forkSvg.setAttribute('stroke-width', '2'); forkSvg.setAttribute('stroke-linecap', 'round');
			forkSvg.setAttribute('stroke-linejoin', 'round');
			const fp1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			fp1.setAttribute('d', 'M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4');
			const fp2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			fp2.setAttribute('d', 'M5 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z');
			forkSvg.append(fp1, fp2);
			forkBtn.appendChild(forkSvg);
			registerFn(addDisposableListener(forkBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				cbs.onForkSession?.(s.id);
			}));

			// Rename
			const renameBtn = append(actions, $("button.chat-history-item-btn"));
			renameBtn.title = '重命名';
			const renameSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			renameSvg.setAttribute('width', '14'); renameSvg.setAttribute('height', '14');
			renameSvg.setAttribute('viewBox', '0 0 24 24');
			renameSvg.setAttribute('fill', 'none'); renameSvg.setAttribute('stroke', 'currentColor');
			renameSvg.setAttribute('stroke-width', '2'); renameSvg.setAttribute('stroke-linecap', 'round');
			renameSvg.setAttribute('stroke-linejoin', 'round');
			const rp1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			rp1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
			const rp2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			rp2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
			renameSvg.append(rp1, rp2);
			renameBtn.appendChild(renameSvg);
			registerFn(addDisposableListener(renameBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				// Electron 不支持 window.prompt（无实现，返回 null/抛错）→ 用内联 input
				// 重命名，与 sessionHistoryView._startRenameSession 模式一致。
				if (nameEl.querySelector('input')) { return; }  // 已处于编辑态
				const original = s.name;
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'chat-history-item-rename-input';
				input.value = original;
				input.maxLength = 100;
				input.placeholder = '会话名称';
				nameEl.replaceWith(input);
				input.focus();
				input.select();
				let finished = false;
				const finish = (commit: boolean) => {
					if (finished) { return; }
					finished = true;
					const newName = input.value.trim() || original;
					const newSpan = document.createElement('span');
					newSpan.className = 'chat-history-item-name';
					newSpan.textContent = newName;
					input.replaceWith(newSpan);
					if (commit && newName !== original) {
						cbs.onRenameSession?.(s.id, newName);
					}
				};
				registerFn(addDisposableListener(input, EventType.KEY_DOWN, (ev) => {
					const key = (ev as KeyboardEvent).key;
					if (key === 'Enter') { ev.preventDefault(); finish(true); }
					else if (key === 'Escape') { ev.preventDefault(); finish(false); }
				}));
				registerFn(addDisposableListener(input, 'blur', () => finish(true)));
				registerFn(addDisposableListener(input, EventType.CLICK, (ev) => ev.stopPropagation()));
				registerFn(addDisposableListener(input, EventType.MOUSE_DOWN, (ev) => ev.stopPropagation()));
			}));

			// Delete
			const delBtn = append(actions, $("button.chat-history-item-btn delete-btn"));
			delBtn.title = '删除';
			const delSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			delSvg.setAttribute('width', '14'); delSvg.setAttribute('height', '14');
			delSvg.setAttribute('viewBox', '0 0 24 24');
			delSvg.setAttribute('fill', 'none'); delSvg.setAttribute('stroke', 'currentColor');
			delSvg.setAttribute('stroke-width', '2'); delSvg.setAttribute('stroke-linecap', 'round');
			delSvg.setAttribute('stroke-linejoin', 'round');
			const dp1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			dp1.setAttribute('d', 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
			delSvg.appendChild(dp1);
			delBtn.appendChild(delSvg);
			// Electron 不支持 window.confirm（无实现）→ 两步确认：第一次点击进入
			// 待确认态（按钮变红，3s 后自动复位），再次点击才删除。
			let deleteArmed = false;
			let armTimer: number | undefined;
			registerFn(addDisposableListener(delBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (!deleteArmed) {
					deleteArmed = true;
					delBtn.classList.add('armed');
					delBtn.title = '再次点击确认删除';
					if (armTimer) { window.clearTimeout(armTimer); }
					armTimer = window.setTimeout(() => {
						deleteArmed = false;
						delBtn.classList.remove('armed');
						delBtn.title = '删除';
					}, 3000);
					return;
				}
				deleteArmed = false;
				if (armTimer) { window.clearTimeout(armTimer); }
				delBtn.classList.remove('armed');
				delBtn.title = '删除';
				cbs.onDeleteSession?.(s.id);
			}));

			registerFn(addDisposableListener(item, EventType.CLICK, () => {
				cbs.onClose();
				cbs.onOpenSession?.(s.id);
			}));
		}
	}

	// Footer
	const footer = append(overlay, $(".chat-history-footer"));
	const newBtn = append(footer, $("button.chat-history-new-btn"));
	newBtn.textContent = '+ 新建对话';
	registerFn(addDisposableListener(newBtn, EventType.CLICK, () => cbs.onNewSession?.()));

	return overlay;
}

function formatRelativeTime(iso: string): string {
	try {
		const t = new Date(iso).getTime();
		const diff = Date.now() - t;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return '刚刚';
		if (mins < 60) return `${mins} 分钟前`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours} 小时前`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days} 天前`;
		return new Date(iso).toLocaleDateString('zh-CN');
	} catch { return iso; }
}
