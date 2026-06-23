/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerWorktreeCheckpointCommands } from './worktreeCheckpointCommands.js';

/**
 * Register worktree checkpoint contributions (commands).
 */
export function registerWorktreeCheckpointContributions(): void {
	registerWorktreeCheckpointCommands();
}
