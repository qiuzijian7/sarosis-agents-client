/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Streaming Text Component (Typewriter effect)
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';

interface StreamingTextProps {
	text: string;
	speed?: number; // characters per frame (default: all at once since Host already throttles)
}

/**
 * Displays text with a smooth typewriter effect.
 * Since the Host already does 16ms frame throttling, this component
 * simply renders the latest text immediately (no additional animation delay).
 */
export function StreamingText({ text }: StreamingTextProps): React.ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);

	// For streaming text, we render directly since chunks arrive throttled
	return (
		<div ref={containerRef} className="streaming-text">
			{text}
			<span className="cursor-blink">▊</span>
		</div>
	);
}
