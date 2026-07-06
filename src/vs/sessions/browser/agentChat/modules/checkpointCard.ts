/*---------------------------------------------------------------------------------------------
 *  Checkpoint detail card renderer — extracted from agentChatPanel.ts
 *  Pure function: takes data + callbacks, returns HTMLElement.
 *--------------------------------------------------------------------------------------------*/

import type { ICheckpointInfo } from '../agentChatTypes.js';

export function createCheckpointDetailCard(
	cp: ICheckpointInfo,
	isLatest: boolean,
	seqNum: number,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onCheckpointAction: ((action: string, payload?: any) => void) | undefined,
	onOpenFile: ((path: string) => void) | undefined,
): HTMLElement {
	const card = document.createElement('div');
	card.className = 'cp-detail';

	// Header
	const header = document.createElement('div');
	header.className = 'cp-detail-header';

	const icon = document.createElement('span');
	icon.className = 'cp-detail-icon';
	icon.textContent = '📝';
	header.appendChild(icon);

	const title = document.createElement('span');
	title.className = 'cp-detail-title';
	title.textContent = `检查点 #${seqNum}: ${cp.label}`;
	header.appendChild(title);

	if (!isLatest) {
		const ghost = document.createElement('span');
		ghost.className = 'ghost-tag';
		ghost.textContent = 'ghost';
		header.appendChild(ghost);
	}

	const time = document.createElement('span');
	time.className = 'cp-detail-time';
	time.textContent = new Date(cp.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
	header.appendChild(time);

	// Inline action buttons
	const actions = document.createElement('div');
	actions.className = 'cp-detail-actions';

	const undoBtn = document.createElement('button');
	undoBtn.className = 'cp-action-btn danger';
	undoBtn.textContent = '撤销';
	undoBtn.title = '撤销此检查点的所有文件改动';
	undoBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		onCheckpointAction?.('undoAll', { checkpointId: cp.id });
	});
	actions.appendChild(undoBtn);

	const keepBtn = document.createElement('button');
	keepBtn.className = 'cp-action-btn success';
	keepBtn.textContent = '保留';
	keepBtn.title = '保留此检查点的所有文件改动';
	keepBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		onCheckpointAction?.('keepAll', { checkpointId: cp.id });
	});
	actions.appendChild(keepBtn);

	if (cp.files.length > 0) {
		const diffBtn = document.createElement('button');
		diffBtn.className = 'cp-action-btn diff';
		diffBtn.textContent = '差异';
		diffBtn.title = '查看此检查点的文件差异';
		diffBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			onCheckpointAction?.('openDiff', { checkpointId: cp.id });
		});
		actions.appendChild(diffBtn);
	}

	header.appendChild(actions);
	card.appendChild(header);

	// File list
	if (cp.files.length > 0) {
		const files = document.createElement('div');
		files.className = 'cp-files';
		for (const f of cp.files) {
			const fileEl = document.createElement('div');
			fileEl.className = 'cp-file';

			const status = document.createElement('span');
			status.className = `file-status ${f.status === 'modified' ? 'M' : f.status === 'created' ? 'A' : 'D'}`;
			status.textContent = f.status === 'modified' ? 'M' : f.status === 'created' ? 'A' : 'D';
			fileEl.appendChild(status);

			const path = document.createElement('span');
			path.className = 'file-path';
			const displayName = f.path.replace(/\\/g, '/').split('/').pop() || f.path;
			path.textContent = displayName;
			path.title = f.path;
			fileEl.appendChild(path);

			fileEl.addEventListener('click', (e) => {
				e.stopPropagation();
				onOpenFile?.(f.path);
			});
			files.appendChild(fileEl);
		}
		card.appendChild(files);
	}

	return card;
}
