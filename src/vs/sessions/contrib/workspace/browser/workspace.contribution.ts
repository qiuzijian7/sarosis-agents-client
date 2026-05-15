/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// NOTE: The Workspace view container in the activity bar is now registered by
// agentStudio.contribution.ts (id: 'agentStudio.workspace', order: 10).
// This file previously registered a duplicate 'workbench.view.workspaceContainer'
// which caused two identical Workspace buttons in the activity bar.
// The standalone registration has been removed to avoid the duplication.

