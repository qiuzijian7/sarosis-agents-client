/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Composer
 *  Mirrors sarosis-webui EmployeeChat layout exactly:
 *  - chat-composer-box (rounded container, textarea on top, toolbar below)
 *  - chat-toolbar-left: attachment / voice / web-search / divider / provider-tag / agent-tag / model-tag
 *  - chat-send-circle (round send button on the right)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useCallback, KeyboardEvent, useEffect, useMemo } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useProviderStore } from '../../store/useProviderStore';
import type { ProviderInfo } from '../../store/useProviderStore';

interface ChatComposerProps {
	onSend: (message: string) => void;
	onCancel?: () => void;
	isLoading?: boolean;
	placeholder?: string;
}

// 输入框高度上下限（px）。最低值保证至少能完整显示一行+padding，最高值避免遮挡消息列表。
const TEXTAREA_MIN_HEIGHT = 60;
const TEXTAREA_MAX_HEIGHT = 300;
const TEXTAREA_DEFAULT_HEIGHT = 60;

export function ChatComposer({ onSend, onCancel, isLoading = false, placeholder }: ChatComposerProps): React.ReactElement {
	const [input, setInput] = useState('');
	const [webSearchEnabled, setWebSearchEnabled] = useState(false);
	const [showProviderDropdown, setShowProviderDropdown] = useState(false);
	const [showAgentDropdown, setShowAgentDropdown] = useState(false);
	const [showModelDropdown, setShowModelDropdown] = useState(false);
	const [modelSearchQuery, setModelSearchQuery] = useState('');
	const modelSearchInputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// 用户通过拖动条手动设置过的高度。一旦设置，自动撑高将以其为下限（内容更多时可继续撑大到 MAX）。
	const userResizedHeightRef = useRef<number | null>(null);
	// 拖动状态
	const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
	const providerDropdownRef = useRef<HTMLDivElement>(null);
	const agentDropdownRef = useRef<HTMLDivElement>(null);
	const modelDropdownRef = useRef<HTMLDivElement>(null);
	const { activeEmployeeId } = useChatStore();
	const { employees } = useEmployeeStore();
	const { providers, selection, selectProvider, openProviderSettings } = useProviderStore();

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);
	const composerPlaceholder = placeholder || (activeEmployee ? `Message ${activeEmployee.name}...` : '输入消息...');

	// 从 provider store 获取当前选中的 Provider/Model 名称
	const authenticatedProviders = providers.filter(p => p.authStatus === 'authenticated');
	const providerDisplay = selection?.providerName || activeEmployee?.provider;

	// 获取当前选中 Provider 的可用模型/Agent 列表
	const currentProvider = selection
		? authenticatedProviders.find(p => p.id === selection.providerId)
		: null;

	// 判断当前 provider 是否支持 agents
	const supportsAgents = !!(currentProvider?.supportsAgents && currentProvider.agents && currentProvider.agents.length > 0);

	// Agent 显示名称
	const selectedAgent = useMemo(() => {
		if (!supportsAgents || !selection?.agentId || !currentProvider?.agents) { return null; }
		return currentProvider.agents.find(a => a.id === selection.agentId) || null;
	}, [supportsAgents, selection?.agentId, currentProvider?.agents]);
	const agentDisplay = selectedAgent?.name || selection?.agentId || 'Agent';

	// Model 显示：当 supportsAgents 时显示选中 agent 对应的 model，否则显示普通 model
	// selection?.modelId 是 provider 内部 id（可能是 qualified id 形如 "vendor/.../model"）。
	// 优先从 currentProvider.models 查找它对应的友好显示名，避免下拉/已选状态出现 qualified id。
	const modelDisplay = useMemo(() => {
		const id = selection?.modelId;
		if (!id) { return activeEmployee?.model || 'Model'; }
		const meta = currentProvider?.models.find(m => m.id === id);
		return meta?.name || id;
	}, [selection?.modelId, currentProvider?.models, activeEmployee?.model]);

	// 当前 agent 支持的 models（用于 model 下拉菜单过滤）
	const availableModels = useMemo(() => {
		if (!currentProvider) { return []; }
		if (supportsAgents && selectedAgent?.models) {
			// Agent 模式：从 agent 声明的 model id 列表中映射回 currentProvider.models 里的友好名。
			// 如果 agent 给出的字符串恰好不在 provider.models 中（少见），就回退用字符串本身做兜底。
			const byId = new Map(currentProvider.models.map(m => [m.id, m.name]));
			return selectedAgent.models.map(modelId => ({
				id: modelId,
				name: byId.get(modelId) || modelId,
			}));
		}
		return currentProvider.models;
	}, [currentProvider, supportsAgents, selectedAgent]);

	// 点击外部关闭下拉菜单
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
				setShowProviderDropdown(false);
			}
			if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
				setShowAgentDropdown(false);
			}
			if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
				setShowModelDropdown(false);
				setModelSearchQuery('');
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, []);

	// Model dropdown 打开时自动聚焦搜索框
	useEffect(() => {
		if (showModelDropdown && modelSearchInputRef.current) {
			// 延迟聚焦以确保 DOM 已渲染
			requestAnimationFrame(() => {
				modelSearchInputRef.current?.focus();
			});
		}
		if (!showModelDropdown) {
			setModelSearchQuery('');
		}
	}, [showModelDropdown]);

	// 根据搜索过滤模型列表
	const filteredModels = useMemo(() => {
		if (!modelSearchQuery.trim()) {
			return availableModels;
		}
		const query = modelSearchQuery.toLowerCase().trim();
		return availableModels.filter(m =>
			m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
		);
	}, [availableModels, modelSearchQuery]);

	const closeAllDropdowns = useCallback(() => {
		setShowProviderDropdown(false);
		setShowAgentDropdown(false);
		setShowModelDropdown(false);
		setModelSearchQuery('');
	}, []);

	const handleProviderSelect = useCallback((provider: ProviderInfo) => {
		if (provider.authStatus !== 'authenticated') {
			// 未认证的 Provider → 打开其设置页面引导用户配置
			openProviderSettings(provider.id);
			setShowProviderDropdown(false);
			return;
		}
		const firstModel = provider.models[0];
		const firstAgent = provider.agents?.[0];
		if (firstModel) {
			selectProvider(provider.id, firstModel.id, firstAgent?.id);
		}
		setShowProviderDropdown(false);
	}, [selectProvider, openProviderSettings]);

	const handleAgentSelect = useCallback((agentId: string) => {
		if (!selection || !currentProvider) { return; }
		// 选择 agent 后，自动选中该 agent 支持的第一个 model
		const agent = currentProvider.agents?.find(a => a.id === agentId);
		const firstModel = agent?.models?.[0] || selection.modelId;
		selectProvider(selection.providerId, firstModel, agentId);
		setShowAgentDropdown(false);
	}, [selection, currentProvider, selectProvider]);

	const handleModelSelect = useCallback((modelId: string) => {
		if (selection) {
			selectProvider(selection.providerId, modelId, selection.agentId);
		}
		setShowModelDropdown(false);
	}, [selection, selectProvider]);

	const handleSend = useCallback(() => {
		if (!input.trim()) return;
		onSend(input.trim());
		setInput('');
		if (textareaRef.current) {
			// 发送后清空内容：若用户手动调整过则保留其偏好高度，否则回到默认。
			const preferred = userResizedHeightRef.current ?? TEXTAREA_DEFAULT_HEIGHT;
			textareaRef.current.style.height = `${preferred}px`;
		}
	}, [input, onSend]);

	const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			// During streaming: Enter with content sends new message (auto-cancels stream)
			// During streaming: Enter without content does nothing
			if (isLoading && !input.trim()) { return; }
			handleSend();
		}
		// Escape to cancel streaming (VS Code Copilot Chat pattern: Ctrl+Escape / Escape)
		if (e.key === 'Escape' && isLoading && onCancel) {
			e.preventDefault();
			onCancel();
		}
	}, [handleSend, isLoading, onCancel, input]);

	const handleInput = useCallback(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			// 自动撑高：以用户偏好高度（若有）为下限，MAX 为上限。
			const minBase = userResizedHeightRef.current ?? TEXTAREA_MIN_HEIGHT;
			textarea.style.height = 'auto';
			const next = Math.min(
				Math.max(textarea.scrollHeight, minBase),
				TEXTAREA_MAX_HEIGHT,
			);
			textarea.style.height = `${next}px`;
		}
	}, []);

	// 拖动条：用户按住向上/向下拖动改变 textarea 高度
	const handleResizerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
		const textarea = textareaRef.current;
		if (!textarea) { return; }
		e.preventDefault();
		dragStateRef.current = {
			startY: e.clientY,
			startHeight: textarea.offsetHeight,
		};
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';

		const handleMove = (ev: MouseEvent) => {
			const ds = dragStateRef.current;
			if (!ds || !textareaRef.current) { return; }
			// resizer 在 textarea 上方：向上拖（clientY 减小）→ 高度增加
			const delta = ds.startY - ev.clientY;
			const next = Math.min(
				Math.max(ds.startHeight + delta, TEXTAREA_MIN_HEIGHT),
				TEXTAREA_MAX_HEIGHT,
			);
			textareaRef.current.style.height = `${next}px`;
			userResizedHeightRef.current = next;
		};
		const handleUp = () => {
			dragStateRef.current = null;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.removeEventListener('mousemove', handleMove);
			document.removeEventListener('mouseup', handleUp);
		};
		document.addEventListener('mousemove', handleMove);
		document.addEventListener('mouseup', handleUp);
	}, []);

	return (
		<div className="chat-input-area">
			<div className="chat-composer-box">
				{/* 顶部拖动条：手动调整 textarea 高度（最低 60px / 最高 300px） */}
				<div
					className="chat-composer-resizer"
					onMouseDown={handleResizerMouseDown}
					title="拖动调整输入框高度"
					role="separator"
					aria-orientation="horizontal"
				>
					<span className="chat-composer-resizer-grip" />
				</div>

				{/* 上方：文本输入 */}
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					onInput={handleInput}
					placeholder={composerPlaceholder}
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
					<div className="provider-model-chip-wrap" ref={providerDropdownRef}>
						<button
							className="chat-toolbar-btn has-label provider-tag"
							title="选择 Provider"
							onClick={() => {
								const wasOpen = showProviderDropdown;
								closeAllDropdowns();
								if (!wasOpen) { setShowProviderDropdown(true); }
							}}
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
								<line x1="8" y1="21" x2="16" y2="21" />
								<line x1="12" y1="17" x2="12" y2="21" />
							</svg>
							<span className="toolbar-btn-label">{providerDisplay}</span>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
								<path d="M6 9l6 6 6-6" />
							</svg>
						</button>
					{showProviderDropdown && authenticatedProviders.length > 0 && (
						<div className="provider-dropdown">
							{authenticatedProviders.map(p => {
								const isActive = selection?.providerId === p.id;
								return (
									<button
										key={p.id}
										className={`provider-dropdown-item ${isActive ? 'active' : ''}`}
										onClick={() => handleProviderSelect(p)}
									>
										<span className="provider-dropdown-name">{p.name}</span>
										<span className="provider-dropdown-detail">
											{p.supportsAgents
												? `${p.agents?.length || 0} agents`
												: `${p.models.length} models`}
										</span>
									</button>
								);
							})}
						</div>
					)}
					</div>

					{/* Agent 选择器（仅当 provider 支持 agents 时显示） */}
					{supportsAgents && (
						<div className="provider-model-chip-wrap" ref={agentDropdownRef}>
							<button
								className="chat-toolbar-btn has-label agent-tag"
								title="选择 Agent"
								onClick={() => {
									const wasOpen = showAgentDropdown;
									closeAllDropdowns();
									if (!wasOpen) { setShowAgentDropdown(true); }
								}}
							>
								{/* Agent 机器人图标 */}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<rect x="3" y="11" width="18" height="10" rx="2" />
									<circle cx="12" cy="5" r="2" />
									<path d="M12 7v4" />
									<line x1="8" y1="16" x2="8" y2="16" />
									<line x1="16" y1="16" x2="16" y2="16" />
								</svg>
								<span className="toolbar-btn-label">{agentDisplay}</span>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
							{showAgentDropdown && currentProvider?.agents && (
								<div className="provider-dropdown agent-dropdown">
									<div className="agent-dropdown-header">
										<span className="agent-dropdown-title">选择 Agent</span>
										<span className="agent-dropdown-count">{currentProvider.agents.length}</span>
									</div>
									{currentProvider.agents.map(a => (
										<button
											key={a.id}
											className={`provider-dropdown-item ${selection?.agentId === a.id ? 'active' : ''}`}
											onClick={() => handleAgentSelect(a.id)}
										>
											<div className="agent-item-info">
												<span className="provider-dropdown-name">{a.name}</span>
												{a.models && a.models.length > 0 && (
													<span className="agent-item-models">
														{a.models.join(', ')}
													</span>
												)}
											</div>
											{selection?.agentId === a.id && (
												<svg className="agent-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
													<polyline points="20 6 9 17 4 12" />
												</svg>
											)}
										</button>
									))}
								</div>
							)}
						</div>
					)}

					{/* Model 选择器 */}
					<div className="provider-model-chip-wrap" ref={modelDropdownRef}>
						<button
							className="chat-toolbar-btn has-label model-tag"
							title="选择模型"
							onClick={() => {
								const wasOpen = showModelDropdown;
								closeAllDropdowns();
								if (!wasOpen) { setShowModelDropdown(true); }
							}}
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="4 17 10 11 4 5" />
								<line x1="12" y1="19" x2="20" y2="19" />
							</svg>
							<span className="toolbar-btn-label">{modelDisplay}</span>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
								<path d="M6 9l6 6 6-6" />
							</svg>
						</button>
						{showModelDropdown && currentProvider && (
							<div className="provider-dropdown model-dropdown-searchable">
								{/* 搜索框 */}
								<div className="model-search-wrap">
									<svg className="model-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<circle cx="11" cy="11" r="8" />
										<line x1="21" y1="21" x2="16.65" y2="16.65" />
									</svg>
									<input
										ref={modelSearchInputRef}
										type="text"
										className="model-search-input"
										placeholder="搜索模型..."
										value={modelSearchQuery}
										onChange={(e) => setModelSearchQuery(e.target.value)}
										onKeyDown={(e) => {
											// 阻止 Enter 触发发送消息
											e.stopPropagation();
											if (e.key === 'Escape') {
												setShowModelDropdown(false);
												setModelSearchQuery('');
											}
											// Enter 选择第一个匹配结果
											if (e.key === 'Enter' && filteredModels.length > 0) {
												handleModelSelect(filteredModels[0].id);
												setModelSearchQuery('');
											}
										}}
									/>
									{modelSearchQuery && (
										<button
											className="model-search-clear"
											onClick={() => setModelSearchQuery('')}
											title="清除搜索"
										>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
												<line x1="18" y1="6" x2="6" y2="18" />
												<line x1="6" y1="6" x2="18" y2="18" />
											</svg>
										</button>
									)}
								</div>
								{/* 模型列表 */}
								<div className="model-dropdown-list">
									{filteredModels.map(m => (
										<button
											key={m.id}
											className={`provider-dropdown-item ${selection?.modelId === m.id ? 'active' : ''}`}
											onClick={() => {
												handleModelSelect(m.id);
												setModelSearchQuery('');
											}}
										>
											<span className="provider-dropdown-name">{m.name}</span>
										</button>
									))}
									{filteredModels.length === 0 && modelSearchQuery && (
										<div className="provider-dropdown-empty">无匹配模型 "{modelSearchQuery}"</div>
									)}
									{filteredModels.length === 0 && !modelSearchQuery && (
										<div className="provider-dropdown-empty">无可用模型</div>
									)}
								</div>
							</div>
						)}
					</div>
					</div>

				{/* 右侧发送/取消按钮 */}
				<button
					onClick={isLoading ? (input.trim() ? handleSend : onCancel) : handleSend}
					disabled={!input.trim() && !isLoading}
					className={`chat-send-circle ${isLoading && !input.trim() ? 'chat-cancel-circle' : ''}`}
					title={isLoading ? (input.trim() ? '发送新消息 (自动停止当前)' : '停止生成 (Escape)') : '发送 (Enter)'}
				>
						{isLoading && !input.trim() ? (
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
				Enter 发送，Shift + Enter 换行{isLoading ? '，Escape 停止' : ''}
			</div>
		</div>
	);
}
