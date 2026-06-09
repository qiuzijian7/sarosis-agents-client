/*---------------------------------------------------------------------------------------------
 *  ConfigHtmlChatBox — AI chat box mounted ABOVE the ConfigHtml source editor.
 *
 *  Sends the user's natural-language request to the model with the `confightml`
 *  skill activated (dedicated system prompt, one-shot generation that does NOT
 *  route into the main chat panel), then writes the returned HTML straight into
 *  the editor below via `onHtmlGenerated`.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { htmlGenerate } from './configMdBridge';

interface ChatTurn {
	role: 'user' | 'assistant';
	text: string;
	error?: boolean;
}

interface ConfigHtmlChatBoxProps {
	agentId: string;
	/** Current editor contents — passed as the base document for incremental edits. */
	getCurrentHtml: () => string;
	/** Called with the extracted HTML when generation succeeds. */
	onHtmlGenerated: (html: string) => void;
}

export const ConfigHtmlChatBox: React.FC<ConfigHtmlChatBoxProps> = ({
	agentId,
	getCurrentHtml,
	onHtmlGenerated,
}) => {
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	const [turns, setTurns] = useState<ChatTurn[]>([]);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Auto-scroll the transcript to the latest turn.
	useEffect(() => {
		const el = listRef.current;
		if (el) { el.scrollTop = el.scrollHeight; }
	}, [turns, busy]);

	const send = useCallback(async () => {
		const msg = input.trim();
		if (!msg || busy) { return; }
		setInput('');
		setTurns((t) => [...t, { role: 'user', text: msg }]);
		setBusy(true);
		try {
			const currentHtml = getCurrentHtml();
			const { html, raw } = await htmlGenerate(agentId, msg, {
				currentHtml: currentHtml && currentHtml.trim() ? currentHtml : undefined,
			});
			if (html && html.trim()) {
				onHtmlGenerated(html);
				setTurns((t) => [...t, { role: 'assistant', text: '已生成 HTML 并写入下方编辑器 ✓' }]);
			} else {
				setTurns((t) => [...t, {
					role: 'assistant',
					text: raw && raw.trim() ? raw.trim() : '模型未返回可用的 HTML，请补充描述后重试。',
					error: true,
				}]);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			setTurns((t) => [...t, { role: 'assistant', text: `生成失败：${reason}`, error: true }]);
		} finally {
			setBusy(false);
			// Restore focus to the input for rapid iteration.
			requestAnimationFrame(() => taRef.current?.focus());
		}
	}, [input, busy, agentId, getCurrentHtml, onHtmlGenerated]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter sends; Shift+Enter inserts a newline.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}, [send]);

	return (
		<div className="confightml-chat">
			<div className="confightml-chat-header">
				<span className="confightml-chat-title">AI 生成 HTML</span>
				<span className="confightml-chat-skill">confightml</span>
			</div>

			{turns.length > 0 && (
				<div ref={listRef} className="confightml-chat-list">
					{turns.map((t, i) => (
						<div
							key={i}
							className={`confightml-chat-turn ${t.role}${t.error ? ' error' : ''}`}
						>
							<span className="confightml-chat-role">{t.role === 'user' ? '你' : 'AI'}</span>
							<span className="confightml-chat-text">{t.text}</span>
						</div>
					))}
					{busy && (
						<div className="confightml-chat-turn assistant pending">
							<span className="confightml-chat-role">AI</span>
							<span className="confightml-chat-text">正在生成 HTML…</span>
						</div>
					)}
				</div>
			)}

			<div className="confightml-chat-inputrow">
				<textarea
					ref={taRef}
					className="confightml-chat-input"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="描述你想要的页面，例如：做一个产品落地页，含标题、三个特性卡片和行动按钮…"
					rows={2}
					disabled={busy}
					spellCheck={false}
				/>
				<button
					className="confightml-chat-send"
					onClick={() => void send()}
					disabled={busy || !input.trim()}
					title="发送（Enter）/ 换行（Shift+Enter）"
				>
					{busy ? '生成中…' : '发送'}
				</button>
			</div>
		</div>
	);
};
