/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import { PromptFileParser } from '../../../common/promptSyntax/promptFileParser.js';
import { DEFAULT_AGENT_SOURCE_FOLDERS, SAROS_USER_AGENTS_SOURCE_FOLDER } from '../../../common/promptSyntax/config/promptFileLocations.js';
import { PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { getBuiltinAgents } from '../../../../../../../sessions/contrib/agentStudio/common/builtinAgents.js';

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
});
