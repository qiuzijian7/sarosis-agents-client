/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ICheckpointService } from '../common/checkpointService.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import type { ICheckpointInfo } from '../../../browser/agentChat/agentChatTypes.js';

/**
 * CheckpointManager — manages checkpoint bar refresh and actions
 * (undoAll / keepAll / openDiff) for the active agent session.
 *
 * Extracted from NativeChatEditorPane to isolate checkpoint logic
 * (~100 lines) from the EditorPane lifecycle code.
 */
export class CheckpointManager extends Disposable {

	constructor(
		private readonly _checkpointService: ICheckpointService,
		private readonly _commandService: ICommandService,
	) {
		super();
	}

	/**
	 * Set the active session for checkpoint scoping.
	 */
	setActiveSession(agentId: string, sessionId: string): void {
		try {
			this._checkpointService.setActiveSession(agentId, sessionId);
		} catch { /* ignore */ }
	}

	/**
	 * Refresh the checkpoint bar with the latest checkpoints for the active session.
	 */
	async refreshBar(panel: IChatPanel | undefined, agentId: string | null, sessionId: string | null): Promise<void> {
		if (!agentId || !sessionId || !panel) {
			panel?.setCheckpoint(null);
			return;
		}
		try {
			const list = await this._checkpointService.listCheckpoints(agentId, sessionId);
			const live = list.filter(cp => !cp.isGhost);
			if (live.length === 0) {
				panel.setCheckpoint(null);
				return;
			}
		// Aggregate file changes across all live checkpoints (de-dup by path,
		// last status wins; additions/deletions 累加——回退弹窗展示真实 +N -M)
		const byPath = new Map<string, { path: string; status: 'modified' | 'created' | 'deleted'; additions: number; deletions: number }>();
		for (const cp of live) {
			if (!cp.files) { continue; }
			for (const f of cp.files) {
				const status: 'modified' | 'created' | 'deleted' =
					(f as any).status === 'created' ? 'created'
						: (f as any).status === 'deleted' ? 'deleted'
							: 'modified';
				const key = (f as any).path ?? (f as any).fsPath ?? (f as any).uri ?? '';
				if (!key) { continue; }
				const prev = byPath.get(key);
				byPath.set(key, {
					path: key,
					status,
					additions: (prev?.additions ?? 0) + ((f as any).additions ?? 0),
					deletions: (prev?.deletions ?? 0) + ((f as any).deletions ?? 0),
				});
			}
		}
			const files = Array.from(byPath.values()).filter(f => !!f.path);
			const latest = live[live.length - 1];
			const info: ICheckpointInfo = {
				id: latest.id,
				label: latest.label || (latest.type === 'tool_edit' ? '工具修改' : '用户检查点'),
				timestamp: latest.createdAt,
				fileCount: files.length || latest.fileSnapshotIds.length,
				files,
			};
			panel.setCheckpoint(info);
		} catch {
			panel.setCheckpoint(null);
		}
	}

	/**
	 * Handle a checkpoint action (undoAll / keepAll / openDiff).
	 */
	async handleAction(
		panel: IChatPanel | undefined,
		agentId: string | null,
		sessionId: string | null,
		action: 'undoAll' | 'keepAll' | 'openDiff',
		payload?: { filePath?: string; checkpointId?: string },
	): Promise<void> {
		if (!agentId || !sessionId) { return; }
		try {
			if (action === 'undoAll') {
				await this._checkpointService.revertAllCheckpoints(agentId, sessionId);
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				panel?.setCheckpoint(null);
				return;
			}
			if (action === 'keepAll') {
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				panel?.setCheckpoint(null);
				return;
			}
			if (action === 'openDiff') {
				try {
					await this._commandService.executeCommand(
						'agentStudio.openCheckpointDiff',
						{ agentId, sessionId, filePath: payload?.filePath },
					);
				} catch { /* command not registered */ }
			}
		} catch {
			// ignore
		}
	}
}
