/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 原路径指向 `terminalContrib/chatAgentTools/common/terminalToolIds.js`（不存在）。
// canonical 枚举实际在 `chat/common/tools/terminalToolIds.ts`，其文件头注释明确要求：
// "The canonical enum lives here so that `chat/common` can reference the IDs
//  **without depending on `terminalContrib/`**"。
// 故 `chat/` 层应引用同层的 common，而不是反向依赖 terminalContrib。
import { TerminalToolId } from '../../common/tools/terminalToolIds.js';
import { IToolResultCompressor, IToolResultFilter, IToolResultFilterOutput } from '../../common/tools/toolResultCompressor.js';

/**
 * Options for {@link createTruncationFilter}.
 *
 * Output that exceeds either limit is truncated head-first (we keep the
 * beginning, which is usually the most relevant for logs / file reads) and a
 * short marker is left in place of the dropped tail. These defaults mirror the
 * opencode CLI's "2000 lines / 50KB" hard cap.
 */
export interface ITruncationFilterOptions {
	/** Keep at most this many lines; extra trailing lines are dropped. */
	readonly maxLines: number;
	/** Keep at most this many UTF-16 code units; extra trailing chars dropped. */
	readonly maxChars: number;
}

const DEFAULT_OPTIONS: ITruncationFilterOptions = {
	maxLines: 2000,
	maxChars: 50 * 1024,
};

/**
 * Tools whose raw output can blow up the context window. The terminal family
 * dominates here (long builds, big diffs, task output), so we seed the list
 * with those IDs and let callers extend it.
 */
const DEFAULT_TOOL_IDS: readonly string[] = [
	TerminalToolId.RunInTerminal,
	TerminalToolId.GetTerminalOutput,
	TerminalToolId.SendToTerminal,
	TerminalToolId.CreateAndRunTask,
	TerminalToolId.GetTaskOutput,
	TerminalToolId.RunTask,
	TerminalToolId.TerminalLastCommand,
	TerminalToolId.TerminalSelection,
];

const TRUNCATED_LINES_MARKER = (dropped: number): string =>
	`\n[... ${dropped} line(s) truncated ...]`;
const TRUNCATED_CHARS_MARKER = (dropped: number): string =>
	`\n[... ${dropped} char(s) truncated ...]`;

/**
 * Build a pure truncation filter. The filter never grows its input: if the text
 * is already within both limits it returns `compressed: false` and the service
 * passes it through untouched ("Never make it worse").
 */
export function createTruncationFilter(
	toolIds: readonly string[],
	options: Partial<ITruncationFilterOptions> = {},
): IToolResultFilter {
	const opts: ITruncationFilterOptions = { ...DEFAULT_OPTIONS, ...options };
	const ids = toolIds.length > 0 ? toolIds : DEFAULT_TOOL_IDS;
	const filterId = `chat.truncation.${opts.maxLines}L.${opts.maxChars}C`;

	return {
		id: filterId,
		toolIds: ids,
		matches: () => true,
		apply(text: string): IToolResultFilterOutput {
			let current = text;

			// Line-based cap first. Keep at most opts.maxLines complete lines:
			// stop right after the (maxLines - 1)-th newline so the retained
			// text holds exactly maxLines lines (not one extra).
			if (opts.maxLines > 0) {
				let newlineCount = 0;
				for (let i = 0; i < current.length; i++) {
					if (current.charCodeAt(i) === 10 /* \n */) {
						newlineCount++;
						if (newlineCount >= opts.maxLines - 1) {
							const kept = i; // keep up to and including this newline
							const dropped = countLines(current.slice(kept + 1));
							if (dropped > 0) {
								current = current.slice(0, kept + 1) + TRUNCATED_LINES_MARKER(dropped);
							}
							break;
						}
					}
				}
			}

			// Character-based cap second (covers very long single lines).
			// Reserve room for the marker so the final result stays within
			// opts.maxChars — otherwise the appended marker pushes it back over.
			if (opts.maxChars > 0 && current.length > opts.maxChars) {
				const marker = TRUNCATED_CHARS_MARKER(current.length - opts.maxChars);
				const keepLen = Math.max(0, opts.maxChars - marker.length);
				current = current.slice(0, keepLen) + marker;
			}

			const compressed = current.length < text.length;
			return { text: current, compressed };
		},
	};
}

function countLines(s: string): number {
	if (s.length === 0) {
		return 0;
	}
	let n = 1;
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === 10) {
			n++;
		}
	}
	return n;
}

/**
 * Register the default truncation filter onto a compressor instance. Safe to
 * call multiple times (each registers an independent filter object). The
 * filter only fires when `chat.tools.compressOutput.enabled` is on, per the
 * service, and only when a text part actually exceeds a limit.
 */
export function registerToolResultTruncationFilters(compressor: IToolResultCompressor): void {
	compressor.registerFilter(createTruncationFilter(DEFAULT_TOOL_IDS));
}
