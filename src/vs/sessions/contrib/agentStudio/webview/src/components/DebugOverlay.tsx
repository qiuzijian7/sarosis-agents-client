/*---------------------------------------------------------------------------------------------
 *  DebugOverlay — floating panel that shows [CoderTrace] logs in the Agent Studio UI
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef } from 'react';
import { useDebugTraceStore } from '../store/useDebugTraceStore';

const PANEL_WIDTH = 480;
const PANEL_MAX_HEIGHT = 320;

export function DebugOverlay(): React.ReactElement | null {
	const { entries, visible, toggleVisible, clear } = useDebugTraceStore();
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new entries
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [entries.length]);

	if (!visible) {
		// Floating toggle button (bottom-right corner)
		return (
			<button
				onClick={toggleVisible}
				style={{
					position: 'fixed',
					bottom: 12,
					right: 12,
					zIndex: 99999,
					background: '#1e1e1e',
					color: '#4fc3f7',
					border: '1px solid #4fc3f7',
					borderRadius: 6,
					padding: '4px 10px',
					fontSize: 11,
					fontFamily: 'monospace',
					cursor: 'pointer',
					opacity: 0.7,
				}}
				title="Show CoderTrace logs"
			>
				🔍 Trace ({entries.length})
			</button>
		);
	}

	return (
		<div
			style={{
				position: 'fixed',
				bottom: 12,
				right: 12,
				zIndex: 99999,
				width: PANEL_WIDTH,
				maxHeight: PANEL_MAX_HEIGHT,
				background: '#1a1a2e',
				border: '1px solid #4fc3f7',
				borderRadius: 8,
				fontFamily: "'Consolas', 'Courier New', monospace",
				fontSize: 11,
				display: 'flex',
				flexDirection: 'column',
				boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '6px 10px',
					borderBottom: '1px solid #333',
					color: '#4fc3f7',
					fontWeight: 'bold',
					fontSize: 12,
				}}
			>
				<span>🔍 CoderTrace ({entries.length})</span>
				<div style={{ display: 'flex', gap: 8 }}>
					<button
						onClick={clear}
						style={{
							background: 'transparent',
							color: '#888',
							border: 'none',
							cursor: 'pointer',
							fontSize: 11,
						}}
					>
						Clear
					</button>
					<button
						onClick={toggleVisible}
						style={{
							background: 'transparent',
							color: '#888',
							border: 'none',
							cursor: 'pointer',
							fontSize: 13,
						}}
					>
						✕
					</button>
				</div>
			</div>

			{/* Log entries */}
			<div
				ref={scrollRef}
				style={{
					overflowY: 'auto',
					padding: '4px 8px',
					maxHeight: PANEL_MAX_HEIGHT - 36,
				}}
			>
				{entries.length === 0 && (
					<div style={{ color: '#666', padding: '8px 0' }}>
						Waiting for trace events...
					</div>
				)}
				{entries.map((entry) => {
					const time = new Date(entry.timestamp);
					const ts = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}.${time.getMilliseconds().toString().padStart(3, '0')}`;
					const isStart = entry.message.includes('START');
					const isComplete = entry.message.includes('COMPLETE');
					const isError = entry.message.includes('ERROR');
					const color = isError ? '#f48771' : isComplete ? '#89d185' : isStart ? '#4fc3f7' : '#ccc';

					return (
						<div
							key={entry.id}
							style={{
								padding: '2px 0',
								borderBottom: '1px solid #222',
								color,
								wordBreak: 'break-all' as const,
							}}
						>
							<span style={{ color: '#666', marginRight: 6 }}>{ts}</span>
							{entry.message}
						</div>
					);
				})}
			</div>
		</div>
	);
}
