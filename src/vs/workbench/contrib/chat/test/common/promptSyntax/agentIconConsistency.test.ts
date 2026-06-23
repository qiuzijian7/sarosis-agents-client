/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import { PromptFileParser } from '../../../common/promptSyntax/promptFileParser.js';
import { DEFAULT_AGENT_SOURCE_FOLDERS, SAROS_USER_AGENTS_SOURCE_FOLDER } from '../../../common/promptSyntax/config/promptFileLocations.js';
import { PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { getBuiltinAgents } from '../../../../../../sessions/contrib/agentStudio/common/builtinAgents.js';

/**
 * Expected icon mapping for builtin agents.
 * These must match both builtinAgents.ts and the .agent.md files in ~/.saros/agents/.
 */
const EXPECTED_ICONS: Record<string, string> = {
	'Coder': '👨‍💻',
	'Researcher': '🔬',
	'Writer': '✍️',
	'Designer': '🎨',
	'Planner': '📋',
	'Tester': '🧪',
	'DevOps': '🚀',
	'Version Manager': '📦',
	'Data Analyst': '📊',
	'Code Explorer': '🔭',
	'Code Architect': '🏗️',
	'Code Reviewer': '🔍',
	'Workflow Agent': '🧩',
	'Saros Claw': '🦞',
};

suite('AgentIconConsistency', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Test 1: PromptHeader.icon correctly parses the icon field from YAML front matter.
	 * This verifies the first link in the data chain: .agent.md → PromptHeader.icon
	 */
	test('PromptHeader.icon parses emoji from YAML front matter', () => {
		const uri = URI.parse('file:///test/test.agent.md');
		const content = [
			'---',
			'name: Coder',
			'description: Writes code',
			'model: claude-sonnet-4-20250514',
			'icon: "👨‍💻"',
			'---',
			'',
			'# Coder',
			'',
			'You are an expert software engineer.',
		].join('\n');

		const result = new PromptFileParser().parse(uri, content);
		assert.ok(result.header, 'Header should be parsed');
		assert.strictEqual(result.header!.icon, '👨‍💻', 'PromptHeader.icon should return the emoji');
	});

	/**
	 * Test 2: PromptHeader.icon returns undefined when icon field is missing.
	 */
	test('PromptHeader.icon returns undefined when icon field is absent', () => {
		const uri = URI.parse('file:///test/no-icon.agent.md');
		const content = [
			'---',
			'name: NoIcon',
			'description: No icon field',
			'---',
			'',
			'Body content.',
		].join('\n');

		const result = new PromptFileParser().parse(uri, content);
		assert.ok(result.header, 'Header should be parsed');
		assert.strictEqual(result.header!.icon, undefined, 'PromptHeader.icon should be undefined');
	});

	/**
	 * Test 3: PromptHeader.icon handles multi-codepoint emojis (e.g., 👨‍💻).
	 */
	test('PromptHeader.icon handles multi-codepoint emojis', () => {
		const uri = URI.parse('file:///test/emoji.agent.md');
		const emojis = ['👨‍💻', '🔬', '✍️', '🎨', '📋', '🧪', '🚀', '📦', '📊', '🔭', '🏗️', '🔍', '🧩', '🦞'];

		for (const emoji of emojis) {
			const content = `---\nname: Test\ndescription: Test\nicon: "${emoji}"\n---\n\n# Test\n`;
			const result = new PromptFileParser().parse(uri, content);
			assert.ok(result.header, `Header should be parsed for emoji ${emoji}`);
			assert.strictEqual(result.header!.icon, emoji, `PromptHeader.icon should return ${emoji}`);
		}
	});

	/**
	 * Test 4: All builtin agents have the expected icons.
	 * This verifies that builtinAgents.ts icons match the expected mapping.
	 */
	test('builtinAgents.ts icons match expected values', () => {
		const agents = getBuiltinAgents();
		assert.ok(agents.length >= 14, `Should have at least 14 builtin agents, got ${agents.length}`);

		for (const agent of agents) {
			const expectedIcon = EXPECTED_ICONS[agent.name];
			assert.ok(expectedIcon, `No expected icon defined for agent "${agent.name}"`);
			assert.strictEqual(
				agent.icon,
				expectedIcon,
				`Agent "${agent.name}" icon should be ${expectedIcon}, got ${agent.icon}`
			);
		}
	});

	/**
	 * Test 5: .agent.md content generated for builtin agents contains the correct icon field.
	 * This simulates what ensureBuiltinAgentMdFiles() would write.
	 */
	test('generated .agent.md content contains correct icon field', () => {
		const agents = getBuiltinAgents();

		for (const agent of agents) {
			// Simulate the content generation logic from ensureBuiltinAgentMdFiles()
			const toolsLine = agent.tools?.length ? `\ntools: ${agent.tools.join(', ')}` : '';
			const categoryLine = agent.category ? `\ncategory: ${agent.category}` : '';
			const content = `---\nname: ${agent.name}\ndescription: ${agent.description || ''}\nmodel: ${agent.model || 'claude-sonnet-4-20250514'}${toolsLine}${categoryLine}\nicon: "${agent.icon || '🤖'}"\n---\n\n# ${agent.name}\n\n${agent.systemPrompt || ''}\n`;

			// Parse the generated content and verify the icon
			const uri = URI.parse(`file:///test/${agent.id}.agent.md`);
			const result = new PromptFileParser().parse(uri, content);
			assert.ok(result.header, `Header should be parsed for agent "${agent.name}"`);
			assert.strictEqual(
				result.header!.icon,
				EXPECTED_ICONS[agent.name],
				`Parsed icon for "${agent.name}" should be ${EXPECTED_ICONS[agent.name]}`
			);
		}
	});

	/**
	 * Test 6: DEFAULT_AGENT_SOURCE_FOLDERS only contains ~/.saros/agents.
	 * This verifies the unified data source — no other agent directories are scanned.
	 */
	test('DEFAULT_AGENT_SOURCE_FOLDERS only contains ~/.saros/agents', () => {
		assert.strictEqual(DEFAULT_AGENT_SOURCE_FOLDERS.length, 1, 'Should only have one agent source folder');
		assert.strictEqual(
			DEFAULT_AGENT_SOURCE_FOLDERS[0].path,
			SAROS_USER_AGENTS_SOURCE_FOLDER,
			`Should be ${SAROS_USER_AGENTS_SOURCE_FOLDER}`
		);
		assert.strictEqual(
			DEFAULT_AGENT_SOURCE_FOLDERS[0].storage,
			PromptsStorage.user,
			'Should be user storage'
		);
	});

	/**
	 * Test 7: Every builtin agent has a non-empty icon.
	 */
	test('every builtin agent has a non-empty icon', () => {
		const agents = getBuiltinAgents();
		for (const agent of agents) {
			assert.ok(
				agent.icon && agent.icon.length > 0,
				`Agent "${agent.name}" should have a non-empty icon`
			);
		}
	});

	/**
	 * Test 8: Icon field without quotes is also parsed correctly.
	 * Some .agent.md files might have `icon: 🔬` without quotes.
	 */
	test('PromptHeader.icon parses unquoted emoji', () => {
		const uri = URI.parse('file:///test/unquoted.agent.md');
		const content = [
			'---',
			'name: Test',
			'description: Test',
			'icon: 🔬',
			'---',
			'',
			'# Test',
		].join('\n');

		const result = new PromptFileParser().parse(uri, content);
		assert.ok(result.header, 'Header should be parsed');
		assert.strictEqual(result.header!.icon, '🔬', 'PromptHeader.icon should return the unquoted emoji');
	});

	/**
	 * Test 9: Icon backfill — agents without an icon field can derive it from
	 * the matching builtin agent by presetId / id / name.
	 *
	 * This simulates the backfill logic in AgentStudioService.getAgents() which
	 * handles agents stored in older data files (e.g. employees.json) that lack
	 * the icon field. Without this, the webview agent dropdown shows fallback
	 * avatars instead of the preset emoji.
	 */
	test('icon backfill derives icon from builtin agent by presetId', () => {
		const builtins = getBuiltinAgents();

		// Build the lookup map (same logic as getAgents() backfill)
		const builtinByKey = new Map<string, string>();
		for (const b of builtins) {
			if (b.icon) {
				builtinByKey.set(b.id.toLowerCase(), b.icon);
				builtinByKey.set(b.name.toLowerCase(), b.icon);
			}
		}

		// Simulate agents from employees.json (no icon, but has presetId)
		const storedAgents = [
			{ id: '1779681355627-7m8935i', name: 'Planner', presetId: 'planner', icon: undefined as string | undefined },
			{ id: '1779771531976-413no35', name: 'Coder', presetId: 'coder', icon: undefined as string | undefined },
			{ id: 'xyz', name: 'Researcher', presetId: 'researcher', icon: undefined as string | undefined },
		];

		const expectedAfterBackfill: Record<string, string> = {
			'Planner': '📋',
			'Coder': '👨‍💻',
			'Researcher': '🔬',
		};

		for (const agent of storedAgents) {
			if (!agent.icon) {
				const derived =
					(agent.presetId && builtinByKey.get(agent.presetId.toLowerCase())) ||
					builtinByKey.get(agent.id.toLowerCase()) ||
					builtinByKey.get(agent.name.toLowerCase());
				if (derived) {
					agent.icon = derived;
				}
			}
			assert.strictEqual(
				agent.icon,
				expectedAfterBackfill[agent.name],
				`Backfilled icon for "${agent.name}" should be ${expectedAfterBackfill[agent.name]}`
			);
		}
	});

	/**
	 * Test 10: Icon backfill by name when presetId is absent.
	 */
	test('icon backfill derives icon from builtin agent by name', () => {
		const builtins = getBuiltinAgents();
		const builtinByKey = new Map<string, string>();
		for (const b of builtins) {
			if (b.icon) {
				builtinByKey.set(b.id.toLowerCase(), b.icon);
				builtinByKey.set(b.name.toLowerCase(), b.icon);
			}
		}

		// Agent with no presetId and no icon — backfill by name only
		const agent = { id: 'custom-123', name: 'Designer', presetId: undefined as string | undefined, icon: undefined as string | undefined };
		const derived =
			(agent.presetId && builtinByKey.get(agent.presetId.toLowerCase())) ||
			builtinByKey.get(agent.id.toLowerCase()) ||
			builtinByKey.get(agent.name.toLowerCase());
		assert.strictEqual(derived, '🎨', 'Should derive Designer icon by name');
	});
});
