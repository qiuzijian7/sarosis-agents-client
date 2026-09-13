/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Per-file change summary attached to a checkpoint (for the checkpoint bar UI).
 */
export interface ICheckpointFileChange {
	/** Full URI string of the changed file. */
	readonly uri: string;
	/** Short file name (last path segment). */
	readonly fileName: string;
	/** Full filesystem path (for the hover tooltip / detail row). */
	readonly fsPath: string;
	/** Number of added lines (new content vs. pre-edit snapshot). */
	readonly additions: number;
	/** Number of removed lines. */
	readonly deletions: number;
}

/**
 * Checkpoint entry (Void-inspired).
 * Represents a point in time that can be restored (time-travel navigation).
 */
export interface ICheckpoint {
	readonly id: string;
	/** Primary identity field (the agent instance id). */
	readonly agentId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label: string;
	readonly description: string | undefined;
	readonly createdAt: number; // Unix timestamp (ms)
	readonly fileSnapshotIds: string[];
	readonly isGhost: boolean;
	/** The chat message ID associated with this checkpoint (for time-travel navigation). */
	readonly messageId: string | undefined;
	/** Per-file change summary for the checkpoint bar (additions/deletions). */
	readonly files?: ICheckpointFileChange[];
}

/**
 * File snapshot (Void-inspired: VoidFileSnapshot).
 * Captures the full content of a file at checkpoint time.
 */
export interface IFileSnapshot {
	readonly id: string;
	readonly checkpointId: string;
	readonly uri: URI;
	readonly languageId: string | undefined;
	readonly content: string; // full file content at snapshot time
	/**
	 * Whether the file already existed on disk at snapshot time.
	 * `false` means the file was newly created by the edit, so reverting
	 * (jumpToCheckpoint) must DELETE the file rather than write empty content.
	 * Optional for backward-compat with snapshots created before this field
	 * existed (treated as `true` → restore-by-write).
	 */
	readonly existedBefore?: boolean;
	/**
	 * 内容因体积过大或为二进制被省略（2026-09-12，P2-3）：此时 `content` 为空，
	 * 回退**跳过该文件**并计入 {@link IJumpToCheckpointResult.skippedFiles}。
	 *
	 * 为什么不能「写入空内容」：二进制经 `VSBuffer.toString()` 解码后再写回会产出
	 * **损坏文件** —— 比不回退更糟（用户以为已还原）。故宁可不回退并显式告知。
	 */
	readonly contentOmitted?: boolean;
}

/**
 * Payload for creating a new checkpoint.
 */
export interface ICreateCheckpointPayload {
	/** Primary identity field (the agent instance id). */
	readonly agentId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label?: string;
	readonly description?: string;
	readonly fileSnapshots: IFileSnapshotData[]; // file contents to snapshot
	/** The chat message ID associated with this checkpoint (for time-travel navigation). */
	readonly messageId?: string;
	/** Per-file change summary for the checkpoint bar. */
	readonly files?: ICheckpointFileChange[];
}

/**
 * File snapshot data (without id/checkpointId, for creation).
 */
export interface IFileSnapshotData {
	readonly uri: URI;
	readonly languageId: string | undefined;
	readonly content: string;
	/** Whether the file already existed on disk at snapshot time. See IFileSnapshot.existedBefore. */
	readonly existedBefore?: boolean;
}

/**
 * Result of jumping to a checkpoint.
 */
export interface IJumpToCheckpointResult {
	readonly checkpointId: string;
	readonly restoredFiles: string[]; // URIs that were restored
	readonly removedMessages: number; // number of messages removed (after checkpoint)
	/**
	 * 因快照内容被省略（超大 / 二进制）而**未能回退**的文件（2026-09-12，P2-3）。
	 * 调用方应向用户显式提示（对齐 Claude Code「skipped N files」），
	 * 避免用户误以为已完全还原。
	 */
	readonly skippedFiles?: string[];
}
