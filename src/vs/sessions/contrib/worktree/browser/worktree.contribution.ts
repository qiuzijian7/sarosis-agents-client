/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { WorktreeService } from './worktreeService.js';
import { IWorkspaceAdapterService } from '../common/workspaceAdapter.js';
import { WorktreeAdapterService } from './worktreeAdapterService.js';

// --- Register Services ---
// View container and view registrations are now handled by the unified
// sessions Explorer in src/vs/sessions/contrib/files/browser/files.contribution.ts

registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);
registerSingleton(IWorkspaceAdapterService, WorktreeAdapterService, InstantiationType.Delayed);
