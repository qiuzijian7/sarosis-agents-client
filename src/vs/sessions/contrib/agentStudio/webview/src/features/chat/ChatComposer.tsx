/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Composer
 *  Mirrors sarosis-webui EmployeeChat layout exactly:
 *  - chat-composer-box (rounded container, textarea on top, toolbar below)
 *  - chat-toolbar-left: attachment / voice / web-search / divider / provider-tag / model-tag
 *  - chat-send-circle (round send button on the right)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useCallback, KeyboardEvent } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';

interface ChatComposerProps {
	onSend: (message: string) => void;
	isLoading?: boolean;
	placeholder?: string;
}

export function ChatComposer({ onSend, isLoading = false, placeholder }: ChatComposerProps): React.ReactElement {
	const [input, setInput] = useState('');
	const [webSearchEnabled, setWebSearchEnabled] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const { activeEmployeeId } = useChatStore();
	const { employees } = useEmployeeStore();

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);
	const composerPlaceholder = placeholder || (activeEmployee ? `Message ${activeEmployee.name}...` : '输入消息...');

	const provider = activeEmployee?.provider || 'Provider';
	const model = activeEmployee?.model || 'Model';

	const handleSend = useCallback(() => {
		if (!input.trim() || isLoading) return;
		onSend(input.trim());
		setInput('');
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto';
		}
	}, [input, isLoading, onSend]);

	const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}, [handleSend]);

	const handleInput = useCallback(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = 'auto';
			textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
		}
	}, []);

	return (
		<div className="chat-input-area">
			<div className="chat-composer-box">
				{/* 上方：文本输入 */}
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					onInput={handleInput}
					placeholder={composerPlaceholder}
					disabled={isLoading}
					rows={1}
					className="chat-composer-textarea"
				/>

				{/* 下方：工具栏 */}
				<div className="chat-composer-toolbar">
					{/* 左侧工具按钮组 */}
					<div className="chat-toolbar-left">
						{/* 附件 */}
						<button className="chat-toolbar-btn" title="上传附件">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
							</svg>
						</button>

						{/* 语音 */}
						<button className="chat-toolbar-btn" title="语音输入">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
								<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
								<line x1="12" y1="19" x2="12" y2="23" />
								<line x1="8" y1="23" x2="16" y2="23" />
							</svg>
						</button>

						{/* 联网搜索 */}
						<button
							className={`chat-toolbar-btn has-label ${webSearchEnabled ? 'active' : ''}`}
							title="联网搜索"
							onClick={() => setWebSearchEnabled(!webSearchEnabled)}
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10" />
								<line x1="2" y1="12" x2="22" y2="12" />
								<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
							</svg>
							<span className="toolbar-btn-label">联网</span>
						</button>

						{/* 分隔线 */}
						<div className="chat-toolbar-divider" />

						{/* Provider 选择器 */}
						<div className="provider-model-chip-wrap">
							<button className="chat-toolbar-btn has-label provider-tag" title="选择 Provider">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
									<line x1="8" y1="21" x2="16" y2="21" />
									<line x1="12" y1="17" x2="12" y2="21" />
								</svg>
								<span className="toolbar-btn-label">{provider}</span>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
						</div>

						{/* Model 选择器 */}
						<div className="provider-model-chip-wrap">
							<button className="chat-toolbar-btn has-label model-tag" title="选择模型">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<polyline points="4 17 10 11 4 5" />
									<line x1="12" y1="19" x2="20" y2="19" />
								</svg>
								<span className="toolbar-btn-label">{model}</span>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
						</div>
					</div>

					{/* 右侧发送/取消按钮 */}
					<button
						onClick={isLoading ? undefined : handleSend}
						disabled={!input.trim() && !isLoading}
						className={`chat-send-circle ${isLoading ? 'chat-cancel-circle' : ''}`}
						title={isLoading ? '取消执行' : '发送 (Enter)'}
					>
						{isLoading ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
								<rect x="6" y="6" width="12" height="12" rx="2" />
							</svg>
						) : (
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
								<line x1="12" y1="19" x2="12" y2="5" />
								<polyline points="5 12 12 5 19 12" />
							</svg>
						)}
					</button>
				</div>
			</div>

			{/* 快捷键提示 */}
			<div className="composer-hint">
				Enter 发送，Shift + Enter 换行
			</div>
		</div>
	);
}
