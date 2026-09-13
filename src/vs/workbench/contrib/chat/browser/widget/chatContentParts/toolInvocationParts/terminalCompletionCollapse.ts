/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure decision logic for how a terminal tool card should fold its collapsible
 * wrapper once the underlying command resolves.
 *
 * Extracted from `ChatTerminalToolProgressPart._handleCommandCompletion` so the
 * "should the card auto-collapse on success?" behaviour can be unit-tested
 * without standing up the full DOM/DI graph.
 */
export const enum TerminalCompletionAction {
	/** Leave the wrapper as-is (user already toggled it, or a non-zero exit while failures stay expanded). */
	None = 'none',
	/** Fold the outer wrapper (and inner output) — successful command that the user has not touched. */
	Collapse = 'collapse',
	/** Force the outer wrapper open so a failed command stays visible. */
	Expand = 'expand',
}

export interface ITerminalCompletionInput {
	/** Exit code reported for the resolved command, or `undefined` when it is not (yet) known. */
	readonly exitCode: number | undefined;
	/** Whether the user has manually expanded/collapsed the output during the run. */
	readonly userToggledOutput: boolean;
	/** Value of the `chat.tools.terminal.autoExpandFailures`-style configuration flag. */
	readonly autoExpandFailures: boolean;
}

/**
 * Decide what the terminal card should do to its collapsible wrapper on completion.
 *
 * Rules (mirroring VS Code's built-in behaviour):
 *  - Success (exit 0) and the user has not touched the card → collapse.
 *  - Failure (non-zero exit) with `autoExpandFailures` on → expand (keep it visible).
 *  - Anything else → leave untouched.
 */
export function resolveTerminalCompletionAction(input: ITerminalCompletionInput): TerminalCompletionAction {
	const { exitCode, userToggledOutput, autoExpandFailures } = input;

	if (exitCode === undefined) {
		return TerminalCompletionAction.None;
	}

	const isFailure = exitCode !== 0;
	if (isFailure) {
		return autoExpandFailures ? TerminalCompletionAction.Expand : TerminalCompletionAction.None;
	}

	// Success: collapse only when the user has not expressed a preference.
	return userToggledOutput ? TerminalCompletionAction.None : TerminalCompletionAction.Collapse;
}
