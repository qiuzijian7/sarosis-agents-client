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
	/** Primary identity field (Batch 9.3a: employeeId removed). */
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
}

/**
 * Payload for creating a new checkpoint.
 */
export interface ICreateCheckpointPayload {
	/** @deprecated Batch 9.3a: legacy alias kept for cross-process callers (host RPC payloads).
	 * New code should use agentId. Will be removed once messageProtocol is fully migrated. */
	readonly employeeId?: string;
	/** Primary identity field (Batch 9.1 onward). Required when employeeId is omitted. */
	readonly agentId?: string;
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
}
