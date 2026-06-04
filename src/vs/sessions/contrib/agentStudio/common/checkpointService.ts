/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { ICheckpoint, ICreateCheckpointPayload, IJumpToCheckpointResult, IFileSnapshot } from './checkpointTypes.js';

export const ICheckpointService =
	createDecorator<ICheckpointService>('agentStudioCheckpointService');

/**
 * Checkpoint service (Void-inspired time-travel navigation).
 *
 * Browser-layer implementation that persists checkpoint metadata and full file
 * snapshots as JSON via {@link IFileService}, stored under the workspace home
 * directory (`Workspace.path/.sarosisworkspace/checkpoints`). This avoids the
 * cross-process limitation of the old node/SQLite implementation: the webview
 * controller and the builtin tool provider both run in the renderer (browser)
 * process and can inject this service directly through DI.
 */
export interface ICheckpointService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires whenever a checkpoint is created (via any path). The webview
	 * controller subscribes to this to push a `chat.checkpointCreated` event so
	 * the UI can render a checkpoint card inline without an extra round-trip.
	 */
	readonly onDidCreateCheckpoint: Event<ICheckpoint>;

	/**
	 * Register the active chat session for an agent. Tool-edit checkpoints
	 * (created deep inside the tool provider, which only knows the agentId) use
	 * this mapping to resolve the sessionId for storage scoping.
	 */
	setActiveSession(employeeId: string, sessionId: string): void;

	/**
	 * Convenience capture point for tool edits: the builtin tool provider calls
	 * this right before writing a file. Resolves the active session for the
	 * agent, snapshots the file's current (pre-write) content, and creates a
	 * tool_edit checkpoint. No-op if no active session is registered.
	 *
	 * @param employeeId The agent performing the edit.
	 * @param fileUri The file about to be written (absolute path/URI string).
	 * @param newContent The content that will be written (used to compute the
	 *   additions/deletions summary shown in the checkpoint bar). Optional.
	 */
	captureBeforeToolEdit(employeeId: string, fileUri: string, newContent?: string): Promise<void>;

	/**
	 * Create a new checkpoint by persisting the provided file snapshots.
	 * @param payload Checkpoint creation payload (already contains file contents).
	 * @returns The created checkpoint metadata.
	 */
	createCheckpoint(payload: ICreateCheckpointPayload): Promise<ICheckpoint>;

	/**
	 * Read the current on-disk content of the given file URIs and create a
	 * checkpoint from them. Convenience wrapper used at automatic capture points
	 * (user message / tool edit) where the caller only knows the file URIs.
	 *
	 * Files that cannot be read (e.g. not yet created) are skipped silently.
	 *
	 * @param employeeId The agent/employee owning the checkpoint.
	 * @param sessionId The chat session.
	 * @param type Whether this is a user_edit or tool_edit checkpoint.
	 * @param fileUris Absolute file URIs (string form) to snapshot.
	 * @param opts Optional label / description / messageId.
	 */
	createCheckpointFromUris(
		employeeId: string,
		sessionId: string,
		type: 'user_edit' | 'tool_edit',
		fileUris: string[],
		opts?: { label?: string; description?: string; messageId?: string },
	): Promise<ICheckpoint | undefined>;

	/**
	 * Jump to (restore) a checkpoint: writes each snapshot's content back to disk
	 * and marks subsequent checkpoints as ghost (unreachable).
	 * @returns Restored file URIs (caller truncates chat history).
	 */
	jumpToCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<IJumpToCheckpointResult>;

	/** Get a single checkpoint by id. */
	getCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<ICheckpoint | undefined>;

	/** List all checkpoints for an employee + session, ordered by createdAt asc. */
	listCheckpoints(employeeId: string, sessionId: string): Promise<ICheckpoint[]>;

	/** Delete a checkpoint and its file snapshots. */
	deleteCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<void>;

	/** Get file snapshots for a checkpoint.
	 *  Returns the full snapshot objects (id, uri, languageId, content).
	 *  Browser-layer only; used by the controller to open diff editors. */
	getFileSnapshots(employeeId: string, sessionId: string, checkpointId: string): Promise<IFileSnapshot[]>;

	/**
	 * Get the snapshot content for a specific file in a checkpoint.
	 * Convenience wrapper used by the controller to open a diff editor:
	 * reads the snapshot JSON from disk and returns the file content at checkpoint time.
	 * Returns `undefined` if the snapshot or file is not found.
	 */
	getSnapshotContentForFile(
		employeeId: string,
		sessionId: string,
		checkpointId: string,
		fileUri: string,
	): Promise<string | undefined>;
}
