/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SessionsTitleBarContribution } from './sessionsTitleBarWidget.js';
import './views/sessionsViewActions.js';
import './sessionsActions.js';

// Activity Bar "Sessions" button removed — Agent Studio Sessions button is retained.
// The original container ID was 'agentic.workbench.view.sessionsContainer'.
const _agentSessionsViewIcon = registerIcon('chat-sessions-icon', Codicon.commentDiscussionSparkle, localize('agentSessionsViewIcon', 'Icon for Agent Sessions View'));
void _agentSessionsViewIcon; // keep icon registration for potential references elsewhere

// [Sarosis] Session title pill removed from the title bar command center.
// In the path-A three-column layout the command center sits centered, which
// places this pill directly above the middle (File) column — it read as a
// stray "New Session" button at the top of the middle column. The right
// column's own titlebar (stage 3) carries the workspace dropdown + agent
// count + window controls instead, so this widget is no longer registered.
// Re-enable by uncommenting if a session-title affordance is needed again.
// registerWorkbenchContribution2(SessionsTitleBarContribution.ID, SessionsTitleBarContribution, WorkbenchPhase.AfterRestored);
void SessionsTitleBarContribution;
