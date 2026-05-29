/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------
 *
 * Tool Extraction Utilities — borrowed from Void Editor's extractGrammar.ts patterns
 *
 * This module provides robust text processing utilities for tool call extraction:
 *  - SurroundingsRemover: incremental string processing (like a sliding window)
 *  - endsWithAnyPrefixOf: check if string ends with any prefix of a target
 *  - trimBeforeAndAfterNewLines: trim whitespace around first/last newline
 *
 * These utilities are inspired by Void Editor's approach to handle streaming text
 * and partial tool call tags.
 */

/**
 * SurroundingsRemover — treat a string as a sliding window [i, j].
 *
 * Like Void's original, this lets you incrementally peel off known prefixes/suffixes
 * without copying the whole string. Useful for parsing incomplete XML/tool tags
 * in streaming scenarios.
 */
export class SurroundingsRemover {
	readonly originalS: string;
	i: number;
	j: number;

	/** string is originalS[i...j] */
	constructor(s: string) {
		this.originalS = s;
		this.i = 0;
		this.j = s.length - 1;
	}

	/** Current window value */
	value(): string {
		return this.originalS.substring(this.i, this.j + 1);
	}

	/**
	 * Remove prefix from left. Returns whether the entire prefix was removed.
	 * e.g. prefix = "<tool_name>", string = "<tool_name>xxx" → removes "<tool_name>", returns true
	 *      prefix = "<tool_name>", string = "<tool_"       → removes "<tool_", returns false
	 */
	removePrefix(prefix: string): boolean {
		let offset = 0;
		while (this.i <= this.j && offset <= prefix.length - 1) {
			if (this.originalS.charAt(this.i) !== prefix.charAt(offset)) {
				break;
			}
			offset += 1;
			this.i += 1;
		}
		return offset === prefix.length;
	}

	/**
	 * Remove suffix from right. Returns whether the entire suffix was removed.
	 *
	 * Unlike Void's original that worked right-to-left, this implementation
	 * checks all possible prefixes of `suffix` against the end of the current value.
	 * This is more intuitive and handles partial suffix matches (streaming).
	 */
	removeSuffix(suffix: string): boolean {
		const s = this.value();
		// for every possible prefix of `suffix`, check if string ends with it
		for (let len = Math.min(s.length, suffix.length); len >= 1; len -= 1) {
			if (s.endsWith(suffix.substring(0, len))) {
				this.j -= len;
				return len === suffix.length;
			}
		}
		return false;
	}

	/**
	 * Remove from current position (i) until we find `until` string.
	 * If `alsoRemoveUntilStr` is true, also removes the `until` string itself.
	 * Returns whether `until` was found.
	 */
	removeFromStartUntilFullMatch(until: string, alsoRemoveUntilStr: boolean): boolean {
		const index = this.originalS.indexOf(until, this.i);
		if (index === -1) {
			return false;
		}
		if (alsoRemoveUntilStr) {
			this.i = index + until.length;
		} else {
			this.i = index;
		}
		return true;
	}
}

/**
 * Check if `str` ends with any prefix of `anyPrefix`.
 *
 * Useful for detecting partially-written tags in streaming text.
 * e.g. endsWithAnyPrefixOf("<tool_call>", "<tool_call>") → "<tool_call>" (full match)
 *      endsWithAnyPrefixOf("<think>", "<think>")     → "<think>" (full match)
 *      endsWithAnyPrefixOf("<think>abc", "<think>") → "<think>" (full match)
 *      endsWithAnyPrefixOf("<think>", "</think>") → "<think>" (partial match, prefix of </think>)
 *      endsWithAnyPrefixOf("abc", "<think>")      → null (no match)
 */
export const endsWithAnyPrefixOf = (str: string, anyPrefix: string): string | null => {
	for (let i = anyPrefix.length; i >= 1; i--) {
		const prefix = anyPrefix.slice(0, i);
		if (str.endsWith(prefix)) return prefix;
	}
	return null;
};

/**
 * Trim all whitespace up until the first newline, and all whitespace up until the last newline.
 *
 * Useful for cleaning parameter content extracted from XML tags.
 * e.g. "\n  <param>value</param>\n" → "<param>value</param>"
 */
export const trimBeforeAndAfterNewLines = (s: string): string => {
	if (!s) return s;

	const firstNewLineIndex = s.indexOf('\n');
	if (firstNewLineIndex !== -1 && s.substring(0, firstNewLineIndex).trim() === '') {
		s = s.substring(firstNewLineIndex + 1, Infinity);
	}

	const lastNewLineIndex = s.lastIndexOf('\n');
	if (lastNewLineIndex !== -1 && s.substring(lastNewLineIndex + 1, Infinity).trim() === '') {
		s = s.substring(0, lastNewLineIndex);
	}

	return s;
};
