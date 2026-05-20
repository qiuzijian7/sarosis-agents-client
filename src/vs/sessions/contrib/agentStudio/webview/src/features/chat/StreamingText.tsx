/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Streaming Text Component
 *
 *  Enhanced streaming text display inspired by OpenClaw's grouped-render.ts:
 *  - Immediate text rendering (Host already throttles at 16ms frames)
 *  - Blinking cursor indicator at the end
 *  - Basic inline code detection for streaming content
 *  - Newline preservation (pre-wrap)
 *  - Auto-scroll friendly (no additional animation delays)
 *
 *  Ref: OpenClaw ui/src/ui/chat/grouped-render.ts renderStreamingGroup
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';

interface StreamingTextProps {
	text: string;
	/** Whether to show the blinking cursor (default: true) */
	showCursor?: boolean;
	/** Optional className for styling variants */
	className?: string;
}

/**
 * Displays streaming text with a blinking cursor.
 *
 * Design decisions (inspired by OpenClaw):
 * - No typewriter animation: the Host already does 16ms frame throttling,
 *   so adding client-side animation would cause jank
 * - Uses dangerouslySetInnerHTML for basic formatting (inline code, line breaks)
 *   only when content contains backtick patterns
 * - Pre-wrap CSS for proper whitespace handling
 * - Cursor at the end indicates "still generating"
 */
export function StreamingText({ text, showCursor = true, className }: StreamingTextProps): React.ReactElement {
	// Simple inline formatting for streaming content:
	// Convert `code` to <code> tags and preserve newlines
	const formattedContent = useMemo(() => {
		if (!text) { return ''; }

		// If no backticks, just return raw text (most common case — fast path)
		if (!text.includes('`')) {
			return null; // Signal to use plain text rendering
		}

		// Basic inline code formatting (single backtick)
		// This gives visual feedback during streaming without full markdown parsing
		let html = escapeHtml(text);
		html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
		return html;
	}, [text]);

	if (!text) {
		return (
			<div className={`streaming-text ${className || ''}`}>
				{showCursor && <span className="cursor-blink">▊</span>}
			</div>
		);
	}

	// Use innerHTML only if we detected formatting, otherwise plain text (safer + faster)
	if (formattedContent) {
		return (
			<div className={`streaming-text ${className || ''}`}>
				<span dangerouslySetInnerHTML={{ __html: formattedContent }} />
				{showCursor && <span className="cursor-blink">▊</span>}
			</div>
		);
	}

	return (
		<div className={`streaming-text ${className || ''}`}>
			{text}
			{showCursor && <span className="cursor-blink">▊</span>}
		</div>
	);
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
