/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Checkpoint entry (Void-inspired).
 * Represents a point in time that can be restored (time-travel navigation).
 */
export interface ICheckpoint {
	readonly id: string;
	readonly employeeId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label: string;
	readonly description: string | undefined;
	readonly createdAt: number; // Unix timestamp (ms)
	readonly fileSnapshotIds: string[];
	readonly isGhost: boolean;
	/** The chat message ID associated with this checkpoint (for time-travel navigation). */
	readonly messageId: string | undefined;
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
}

/**
 * Payload for creating a new checkpoint.
 */
export interface ICreateCheckpointPayload {
	readonly employeeId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label?: string;
	readonly description?: string;
	readonly fileSnapshots: IFileSnapshotData[]; // file contents to snapshot
	/** The chat message ID associated with this checkpoint (for time-travel navigation). */
	readonly messageId?: string;
}

/**
 * File snapshot data (without id/checkpointId, for creation).
 */
export interface IFileSnapshotData {
	readonly uri: URI;
	readonly languageId: string | undefined;
	readonly content: string;
}

/**
 * Result of jumping to a checkpoint.
 */
export interface IJumpToCheckpointResult {
	readonly checkpointId: string;
	readonly restoredFiles: string[]; // URIs that were restored
	readonly removedMessages: number; // number of messages removed (after checkpoint)
}
