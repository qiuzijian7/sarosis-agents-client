/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { TerminalCompletionAction, resolveTerminalCompletionAction } from '../../../../browser/widget/chatContentParts/toolInvocationParts/terminalCompletionCollapse.js';

/**
 * Regression guard for the「terminal 工具卡片执行完毕后不自动折叠」bug.
 *
 * The card previously only folded its inner output section and never the outer
 * collapsible wrapper, so a successful command left the whole card expanded.
 * These tests pin the decision table that drives both folds.
 */
suite('resolveTerminalCompletionAction', () => {

	test('success (exit 0) without user interaction → collapse', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 0,
			userToggledOutput: false,
			autoExpandFailures: false,
		}), TerminalCompletionAction.Collapse);
	});

	test('success (exit 0) even with autoExpandFailures on → collapse (failures flag only affects failures)', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 0,
			userToggledOutput: false,
			autoExpandFailures: true,
		}), TerminalCompletionAction.Collapse);
	});

	test('success (exit 0) but user manually toggled output → leave untouched', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 0,
			userToggledOutput: true,
			autoExpandFailures: false,
		}), TerminalCompletionAction.None);
	});

	test('failure (non-zero exit) with autoExpandFailures on → expand', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 1,
			userToggledOutput: false,
			autoExpandFailures: true,
		}), TerminalCompletionAction.Expand);
	});

	test('failure (non-zero exit) with autoExpandFailures off → leave untouched', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 127,
			userToggledOutput: false,
			autoExpandFailures: false,
		}), TerminalCompletionAction.None);
	});

	test('failure does not collapse even if user did not interact', () => {
		assert.notStrictEqual(resolveTerminalCompletionAction({
			exitCode: 2,
			userToggledOutput: false,
			autoExpandFailures: true,
		}), TerminalCompletionAction.Collapse);
	});

	test('unknown exit code (undefined) → leave untouched', () => {
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: undefined,
			userToggledOutput: false,
			autoExpandFailures: true,
		}), TerminalCompletionAction.None);
	});

	test('user toggled output suppresses expand on failure too', () => {
		// autoExpandFailures would normally expand, but the user already made a
		// choice — the wrapper should still be forced open for visibility though,
		// because a failed command must not be silently hidden.
		assert.strictEqual(resolveTerminalCompletionAction({
			exitCode: 1,
			userToggledOutput: true,
			autoExpandFailures: true,
		}), TerminalCompletionAction.Expand);
	});
});
