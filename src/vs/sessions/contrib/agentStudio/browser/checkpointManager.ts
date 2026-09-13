/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ICheckpointService } from '../common/checkpointService.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import type { ICheckpointInfo } from '../../../browser/agentChat/agentChatTypes.js';

/**
 * CheckpointManager — manages checkpoint bar refresh and actions
 * (undoAll / keepAll / openDiff) for the active agent session.
 *
 * Extracted from NativeChatEditorPane to isolate checkpoint logic
 * (~100 lines) from the EditorPane lifecycle code.
 *
 * 2026-09-12（P0-4）：所有空 `catch {}` 改为 `logService.warn` —— 此前检查点条
 * 静默消失（refreshBar 抛错）或「查看变更」毫无反应（命令未注册）时，日志里
 * **零痕迹**，排障只能靠猜。对齐项目内「降级必须可见」原则。
 */
export class CheckpointManager extends Disposable {

	constructor(
		private readonly _checkpointService: ICheckpointService,
		private readonly _commandService: ICommandService,
		private readonly _logService: ILogService,
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
		} catch (err) {
			// 2026-09-12（P0-4）：此前空 catch 吞错 —— 检查点条静默消失时无从排查。
			this._logService.warn(
				`[CheckpointManager] refreshBar failed (agent=${agentId}, session=${sessionId}): ${err}`,
			);
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
	): Promise<{ skippedFiles?: string[] } | undefined> {
		if (!agentId || !sessionId) { return undefined; }
		try {
			if (action === 'undoAll') {
				const result = await this._checkpointService.revertAllCheckpoints(agentId, sessionId);
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				panel?.setCheckpoint(null);
				// 2026-09-12（P2-3）：把「因体积/二进制未纳入检查点而未回退」的文件
				// 上抛给调用方提示用户（对齐 Claude Code「skipped N files」）。
				return { skippedFiles: result.skippedFiles };
			}
			if (action === 'keepAll') {
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				panel?.setCheckpoint(null);
				return undefined;
			}
			if (action === 'openDiff') {
				try {
					await this._commandService.executeCommand(
						'agentStudio.openCheckpointDiff',
						{ agentId, sessionId, filePath: payload?.filePath },
					);
				} catch (err) {
					// 2026-09-12（P0-4）：该命令此前**全仓未注册**，异常被空 catch 吞掉 →
					// 用户点「查看变更」毫无反应、日志零痕迹。现至少留痕（命令仍未注册，
					// 属已知缺口，修复方案见 doc/checkpoint-mechanism-analysis.md P0-4）。
					this._logService.warn(
						`[CheckpointManager] openDiff unavailable — command 'agentStudio.openCheckpointDiff' ` +
						`is not registered (agent=${agentId}, session=${sessionId}): ${err}`,
					);
				}
			}
		} catch (err) {
			this._logService.warn(
				`[CheckpointManager] action "${action}" failed (agent=${agentId}, session=${sessionId}): ${err}`,
			);
		}
		return undefined;
	}
}
