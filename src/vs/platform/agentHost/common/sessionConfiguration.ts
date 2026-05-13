/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationNode, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

/**
 * Configuration keys for Session & Context Enhancement.
 *
 * These settings control:
 * - Context compression behavior
 * - Memory management features
 *
 * Configuration structure:
 * ```json
 * {
 *   "sarosis.session.compression": {
 *     "enabled": true,
 *     "thresholdPercent": 0.50
 *   },
 *   "sarosis.session.memory": {
 *     "enabled": true,
 *     "maxPrefetchResults": 5
 *   }
 * }
 * ```
 */

const configuration: IConfigurationNode = {
	id: 'sarosis.session',
	order: 100,
	type: 'object',
	title: 'Session & Context Enhancement',
	properties: {
		// ── Compression Settings ──────────────────────────────

		'sarosis.session.compression.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable automatic context compression when token usage exceeds threshold.',
			tags: ['onOff'],
		},

		'sarosis.session.compression.thresholdPercent': {
			type: 'number',
			default: 0.50,
			minimum: 0.1,
			maximum: 0.95,
			description: 'Token usage ratio (0-1) that triggers automatic compression.',
		},

		'sarosis.session.compression.headProtectCount': {
			type: 'integer',
			default: 3,
			minimum: 1,
			maximum: 10,
			description: 'Number of messages to protect at the start of conversation (system prompt + initial context).',
		},

		'sarosis.session.compression.tailBudgetRatio': {
			type: 'number',
			default: 0.20,
			minimum: 0.05,
			maximum: 0.50,
			description: 'Token budget ratio to protect at the end of conversation (recent context).',
		},

		'sarosis.session.compression.toolOutputTruncateLength': {
			type: 'integer',
			default: 500,
			minimum: 100,
			maximum: 2000,
			description: 'Maximum characters for tool output summaries during pruning (Stage 1).',
		},

		// ── Memory Settings ──────────────────────────────────

		'sarosis.session.memory.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable cross-session memory management.',
			tags: ['onOff'],
		},

		'sarosis.session.memory.maxPrefetchResults': {
			type: 'integer',
			default: 5,
			minimum: 1,
			maximum: 20,
			description: 'Maximum number of memories to prefetch and inject per turn.',
		},

		'sarosis.session.memory.autoExtract': {
			type: 'boolean',
			default: true,
			description: 'Automatically extract memorable content from conversations.',
			tags: ['onOff'],
		},

		'sarosis.session.memory.defaultImportance': {
			type: 'number',
			default: 0.5,
			minimum: 0.0,
			maximum: 1.0,
			description: 'Default importance score for auto-extracted memories.',
		},
	},
};

/**
 * Register the configuration with the VSCode configuration registry.
 *
 * Call this function during workbench initialization.
 */
export function registerSessionConfiguration(): void {
	Registry.as<IConfigurationRegistry>('config.configuration').registerConfiguration(configuration);
}
