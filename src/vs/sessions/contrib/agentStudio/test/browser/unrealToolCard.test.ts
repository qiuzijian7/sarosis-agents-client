/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../../../../../../..');
const BASE = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
const TOOL_CARDS = 'src/vs/sessions/browser/agentChat/agentChatPanel.toolCards.ts';
const UNREAL_CARD = 'src/vs/sessions/browser/agentChat/agentChatPanel.unrealCard.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';

const UNREAL_TOOLS = [
	'unreal_health', 'unreal_exec', 'unreal_wait', 'unreal_help',
	'unreal_dump', 'unreal_build', 'unreal_find_asset',
];

function read(rel: string): string {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
