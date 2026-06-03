/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Composer
 *  Mirrors sarosis-webui EmployeeChat layout exactly:
 *  - chat-composer-box (rounded container, textarea on top, toolbar below)
 *  - chat-toolbar-left: attachment / voice / web-search / divider / provider-tag / agent-tag / model-tag
 *  - chat-send-circle (round send button on the right)
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { useState, useRef, useCallback, KeyboardEvent, useEffect, useMemo } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useProviderStore } from '../../store/useProviderStore';
import type { ProviderInfo, ProviderModelInfo } from '../../store/useProviderStore';
import { sendRequest } from '../../bridge/messageClient';

interface ChatComposerProps {
	onSend: (message: string) => void;
	onCancel?: () => void;
	isLoading?: boolean;
	placeholder?: string;
	/** Called when a special command (e.g. /plan) is executed */
	onCommand?: (commandId: string, args: string) => void;
}

// 输入框高度上下限（px）。最低值保证至少能完整显示一行+padding，最高值避免遮挡消息列表。
const TEXTAREA_MIN_HEIGHT = 60;
const TEXTAREA_MAX_HEIGHT = 300;
const TEXTAREA_DEFAULT_HEIGHT = 60;

// 圆环进度条几何参数：viewBox 20×20，半径 7，周长 = 2πr。
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 将 token 数格式化为紧凑可读字符串（如 58.8K / 1.2M）。 */
function formatTokens(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
	return String(n);
}

/**
 * 粗略 token 估算（参考 Hermes-Agent estimate_tokens_rough：字符数/4 向上取整）。
 * 不引入 tokenizer，char/4 足以驱动进度条实时变化。空串返回 0。
 */
function estimateTokens(text: string | undefined | null): number {
	if (!text) { return 0; }
	return Math.ceil(text.length / 4);
}

export function ChatComposer({ onSend, onCancel, isLoading = false, placeholder, onCommand }: ChatComposerProps): React.ReactElement {
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
	const modeDropdownRef = useRef<HTMLDivElement>(null);
	const [showModeDropdown, setShowModeDropdown] = useState(false);

	// 命令系统状态
	const [showCommandMenu, setShowCommandMenu] = useState(false);
	const [commandFilter, setCommandFilter] = useState('');
	const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
	
	// 技能菜单状态
	const [showSkillMenu, setShowSkillMenu] = useState(false);
	const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
	const [skillFilter, setSkillFilter] = useState('');
	const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
	const skillMenuRef = useRef<HTMLDivElement>(null);
	const commandMenuRef = useRef<HTMLDivElement>(null);
	const { activeEmployeeId, chatMode, setChatMode } = useChatStore();
	const { employees } = useEmployeeStore();
	const { providers, selection, selectProvider, openProviderSettings, authenticatedProviders: getAuthenticatedProviders, currentModelInfo, currentReasoningConfig, setReasoningConfig } = useProviderStore();

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);
	const composerPlaceholder = placeholder || (activeEmployee ? `Message ${activeEmployee.name}...` : '输入消息...');

	// Mode options — with descriptions and icons (ref: CodeBuddy-IDE-模式分析.md)
	const modeOptions = useMemo(() => {
		const all: Array<{ id: 'craft' | 'ask' | 'plan' | 'workflow'; label: string; description: string; icon: string }> = [
			{
				id: 'craft',
				label: 'Craft',
				description: 'Agent 模式 — 完整工具访问，可直接修改代码和执行命令',
				icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
			},
			{
				id: 'ask',
				label: 'Ask',
				description: '问答模式 — 只读工具访问，提供技术解答和建议',
				icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm1 5.5v5h-2v-5h2z',
			},
			{
				id: 'plan',
				label: 'Plan',
				description: '计划模式 — 只读探索 + 任务拆解，确认后切换执行模式',
				icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
			},
			{
				id: 'workflow',
				label: 'Workflow',
				description: '工作流模式 — Craft + 完成后驱动下游 Agent 执行',
				icon: 'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3',
			},
		];
		const isPlanner = activeEmployee?.agentType === 'planner'
			|| activeEmployee?.presetId === 'planner'
			|| activeEmployee?.role?.toLowerCase().includes('planner')
			|| activeEmployee?.name?.toLowerCase() === 'planner';
		if (!isPlanner) {
			return all.filter(m => m.id !== 'plan');
		}
		return all;
	}, [activeEmployee]);

	// 从 provider store 获取当前选中的 Provider/Model 名称
	// 使用 store 的计算属性 authenticatedProviders 确保过滤逻辑一致
	const authenticatedProviders = getAuthenticatedProviders();
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
			// Agent 模式：从 agent 声明的 model id 列表中映射回 currentProvider.models 里的完整模型信息。
			// 如果 agent 给出的字符串恰好不在 provider.models 中（少见），就回退构造一个仅含 id/name 的兜底项。
			const byId = new Map(currentProvider.models.map(m => [m.id, m]));
			return selectedAgent.models.map(modelId => {
				const full = byId.get(modelId);
				return full ?? ({ id: modelId, name: modelId } as ProviderModelInfo);
			});
		}
		return currentProvider.models;
	}, [currentProvider, supportsAgents, selectedAgent]);

	// ── Thinking / Reasoning UI 状态 ────────────────────────────────
	// 订阅 reasoningConfig 原始 state 以触发重渲染（getter 本身不订阅）。
	const reasoningConfigMap = useProviderStore(s => s.reasoningConfig);
	// 当前选中模型的能力信息
	const currentModel = useMemo(
		() => currentModelInfo(),
		[currentModelInfo, selection?.providerId, selection?.modelId, providers]
	);
	// 模型是否支持思考模式
	const modelSupportsReasoning = !!(currentModel?.supportsReasoning || currentModel?.reasoningType);
	// 推理 UI 形态：'effort-slider' 显示 Low/Medium/High，'budget-slider' 显示 token 滑块，其余仅开关
	const reasoningUIType: 'budget-slider' | 'effort-slider' | 'switch' = useMemo(() => {
		if (currentModel?.reasoningType === 'effort-slider') { return 'effort-slider'; }
		if (currentModel?.reasoningType === 'budget-slider') { return 'budget-slider'; }
		return 'switch';
	}, [currentModel?.reasoningType]);
	// 当前模型的 thinking 配置（带默认值兜底）
	const reasoningCfg = useMemo(
		() => currentReasoningConfig(),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[currentReasoningConfig, reasoningConfigMap, selection?.providerId, selection?.modelId, currentModel]
	);
	// onlyReasoning 模型不能关闭思考
	const canToggleReasoning = !currentModel?.onlyReasoning;

	// ── 上下文使用量（发送按钮左侧圆环进度条）──────────────────────────
	// 参考 Hermes-Agent 的实时 token 显示设计，分三层估算，确保聊天过程中进度条实时更新：
	//   1) 输入基线：把已有 messages 历史按 char/4 估算（含 thinking + toolCalls），
	//      作为本轮请求送入模型的输入占用 —— 发送前进度条就已反映输入体量。
	//   2) 流式输出增量：phase 活跃时叠加 streamState 的 textBuffer + thinkingBuffer 估算，
	//      使生成过程中进度条随产出逐字增长（解决"只在 done 跳变"的问题）。
	//   3) 真值修正：收到真实 usage（seen=true，通常在流末）后用 input+output 覆盖估算值，
	//      使最终数值精确。done 后该值沉淀到 message.tokenUsage，下一轮成为输入基线的真值来源。
	const streamUsage = useChatStore(s => s.streamState.usage);
	const streamPhase = useChatStore(s => s.streamState.phase);
	const streamTextBuffer = useChatStore(s => s.streamState.textBuffer);
	const streamThinkingBuffer = useChatStore(s => s.streamState.thinkingBuffer);
	const messages = useChatStore(s => s.messages);

	// 输入基线：累加全部历史消息的估算 token。优先用真实 tokenUsage.total（更准），
	// 否则按 content + thinking + toolCalls(JSON) 的字符数估算。
	const inputBaselineTokens = useMemo(() => {
		let total = 0;
		for (const m of messages) {
			if (m.tokenUsage && m.tokenUsage.total > 0) {
				// 带真实用量的消息：直接采信（该消息往返的真实 token）
				total += m.tokenUsage.total;
				continue;
			}
			total += estimateTokens(m.content);
			total += estimateTokens(m.thinking);
			if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
				// 工具调用的 name/arguments/result 也占输入 token
				for (const tc of m.toolCalls) {
					total += estimateTokens(tc.arguments);
					total += estimateTokens(tc.result);
					total += estimateTokens(tc.name);
				}
			}
		}
		return total;
	}, [messages]);

	const contextUsage = useMemo(() => {
		const limit = currentModel?.maxInputTokens || 0;
		if (limit <= 0) {
			return null; // 无上限信息，不显示圆环
		}

		const isStreaming = streamPhase !== 'idle' && streamPhase !== 'error';

		let used: number;
		if (streamUsage?.seen) {
			// 3) 真值优先：已收到真实 usage chunk
			//    流式输出基线(历史输入) + 真实 (input + output)。
			//    注：真实 input 已含本轮发送的历史，但为避免重复计数，这里直接采用
			//    真实 input+output 作为"本轮往返总量"，并与历史基线取较大值兜底。
			const real = (streamUsage.input || 0) + (streamUsage.output || 0);
			used = Math.max(real, inputBaselineTokens);
		} else if (isStreaming) {
			// 2) 流式进行中且尚无真实 usage：输入基线 + 实时输出估算
			const outputEstimate = estimateTokens(streamTextBuffer) + estimateTokens(streamThinkingBuffer);
			used = inputBaselineTokens + outputEstimate;
		} else {
			// 1) 空闲态：纯输入基线（即当前对话历史占用）
			used = inputBaselineTokens;
		}

		const ratio = Math.max(0, Math.min(1, used / limit));
		return {
			used,
			limit,
			ratio,
			percent: Math.round(ratio * 100),
		};
	}, [
		currentModel?.maxInputTokens,
		streamUsage,
		streamPhase,
		streamTextBuffer,
		streamThinkingBuffer,
		inputBaselineTokens,
	]);

	const [showReasoningPopover, setShowReasoningPopover] = useState(false);
	const reasoningPopoverRef = useRef<HTMLDivElement>(null);
	// budget slider 范围（参考 void：1024 ~ 8192）
	const REASONING_BUDGET_MIN = 1024;
	const REASONING_BUDGET_MAX = 8192;
	const REASONING_BUDGET_STEP = 256;

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
			if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
				setShowModeDropdown(false);
			}
			// 命令菜单和技能菜单的点击外部关闭
			if (commandMenuRef.current && !commandMenuRef.current.contains(e.target as Node)) {
				setShowCommandMenu(false);
				setCommandFilter('');
			}
			if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
				setShowSkillMenu(false);
				setSkillFilter('');
			}
			if (reasoningPopoverRef.current && !reasoningPopoverRef.current.contains(e.target as Node)) {
				setShowReasoningPopover(false);
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
			m?.name?.toLowerCase().includes(query) || m?.id?.toLowerCase().includes(query)
		);
	}, [availableModels, modelSearchQuery]);

	const closeAllDropdowns = useCallback(() => {
		setShowProviderDropdown(false);
		setShowAgentDropdown(false);
		setShowModelDropdown(false);
		setShowModeDropdown(false);
		setShowReasoningPopover(false);
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

	// 关闭所有弹出菜单（定义在 handleSend 之前，避免 TDZ 错误）
	const closeAllPopups = useCallback(() => {
		setShowCommandMenu(false);
		setShowSkillMenu(false);
		setShowProviderDropdown(false);
		setShowAgentDropdown(false);
		setShowModelDropdown(false);
		setShowModeDropdown(false);
		setCommandFilter('');
		setSkillFilter('');
		setSelectedCommandIndex(0);
		setSelectedSkillIndex(0);
	}, []);

	const handleSend = useCallback(() => {
		if (!input.trim()) return;
		// Plan 模式下：消息内容即为要编排的任务目标，直接触发任务编排流程
		if (chatMode === 'plan' && onCommand) {
			const goal = input.trim().replace(/^\/plan\s*/, ''); // 去掉可能手动输入的 /plan 前缀
			closeAllPopups();
			onCommand('plan', goal);
			setInput('');
			if (textareaRef.current) {
				const preferred = userResizedHeightRef.current ?? TEXTAREA_DEFAULT_HEIGHT;
				textareaRef.current.style.height = `${preferred}px`;
			}
			return;
		}
		// 发送前关闭所有弹出菜单
		closeAllPopups();
		onSend(input.trim());
		setInput('');
		if (textareaRef.current) {
			// 发送后清空内容：若用户手动调整过则保留其偏好高度，否则回到默认。
			const preferred = userResizedHeightRef.current ?? TEXTAREA_DEFAULT_HEIGHT;
			textareaRef.current.style.height = `${preferred}px`;
		}
	}, [input, onSend, onCommand, closeAllPopups, chatMode]);

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

	// 命令系统：定义可用命令（Plan 模式通过模式选择器触发，不再需要 /plan 命令）
	const commands = useMemo(() => {
		const items = [
			{ id: 'skill', name: '技能', description: '选择并使用技能', icon: '🛠️' },
			{ id: 'help', name: '帮助', description: '显示帮助信息', icon: '❓' },
			{ id: 'clear', name: '清除', description: '清除聊天记录', icon: '🗑️' },
		];
		return items;
	}, []);

	// 过滤命令列表
	const filteredCommands = useMemo(() => {
		if (!commandFilter.trim()) return commands;
		const filter = commandFilter.toLowerCase();
		return commands.filter(cmd => 
			cmd && cmd.id && cmd.name && (cmd.id.toLowerCase().includes(filter) || 
			cmd.name.toLowerCase().includes(filter))
		);
	}, [commands, commandFilter]);

	// 过滤技能列表
	const filteredSkills = useMemo(() => {
		if (!skillFilter.trim()) return skills;
		const filter = skillFilter.toLowerCase();
		return skills.filter(skill => 
			skill && skill.id && skill.name && (skill.id.toLowerCase().includes(filter) || 
			skill.name.toLowerCase().includes(filter))
		);
	}, [skills, skillFilter]);

	// 加载技能列表
	const loadSkills = useCallback(async () => {
		console.error('[ChatComposer] loadSkills() called');
		try {
			const result = await sendRequest<{}, Array<{ id: string; name: string }>>('skills.list', {});
			console.error('[ChatComposer] loadSkills() result:', JSON.stringify(result)?.slice(0, 500));
			if (result && Array.isArray(result)) {
				console.error(`[ChatComposer] loadSkills() setting ${result.length} skills`);
				setSkills(result);
			} else {
				console.error('[ChatComposer] loadSkills() result is not an array or is falsy:', typeof result, result);
				setSkills([]);
			}
		} catch (error) {
			console.error('[ChatComposer] Failed to load skills:', error);
			setSkills([]);
		}
	}, []);

	// 处理输入框变化：检测 '/' 输入以显示命令菜单，并更新过滤条件
	const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value;
		setInput(value);
		
		// 检查是否刚刚输入了 '/'（当前光标位置前一个字符是 '/'）
		const cursorPos = e.target.selectionStart;
		const lastSlashIndex = value.lastIndexOf('/');
		
		if (showCommandMenu) {
			// 命令菜单显示中：更新过滤条件或关闭菜单
			if (lastSlashIndex >= 0) {
				const filterText = value.substring(lastSlashIndex + 1);
				// If the filter contains a space, the user has typed past a command
				// (e.g. "/plan test") — close the menu so Enter will send normally
				if (filterText.includes(' ')) {
					setShowCommandMenu(false);
					setCommandFilter('');
				} else {
					setCommandFilter(filterText);
					setSelectedCommandIndex(0);
				}
			} else {
				// 输入中不再有 '/', 关闭菜单
				setShowCommandMenu(false);
				setCommandFilter('');
			}
		} else if (showSkillMenu) {
			// 技能菜单显示中：更新过滤条件或关闭菜单
			const skillIndex = value.lastIndexOf('/skill ');
			if (skillIndex >= 0) {
				const filterText = value.substring(skillIndex + '/skill '.length);
				setSkillFilter(filterText);
				setSelectedSkillIndex(0);
			} else {
				// 输入中不再有 '/skill ', 关闭菜单
				setShowSkillMenu(false);
				setSkillFilter('');
			}
		} else {
			// 没有菜单显示：检查是否刚刚输入了 '/'
			if (cursorPos > 0 && cursorPos <= value.length && value[cursorPos - 1] === '/') {
				// 显示命令菜单
				setShowCommandMenu(true);
				setCommandFilter('');
				setSelectedCommandIndex(0);
			}
		}
	}, [showCommandMenu, showSkillMenu]);

	// 处理键盘事件：支持命令菜单和技能菜单中的导航
	const handleKeyDownWithCommands = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		// 如果命令菜单显示，处理菜单导航
		if (showCommandMenu) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedCommandIndex(prev => 
					prev < filteredCommands.length - 1 ? prev + 1 : 0
				);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedCommandIndex(prev => 
					prev > 0 ? prev - 1 : filteredCommands.length - 1
				);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				if (filteredCommands.length > 0) {
					const selectedCommand = filteredCommands[selectedCommandIndex];
					if (selectedCommand.id === 'skill') {
						// 选择 /skill 命令：加载技能并显示技能菜单
						setShowCommandMenu(false);
						setShowSkillMenu(true);
						setSkillFilter('');
						setSelectedSkillIndex(0);
						loadSkills();
					} else {
						// 所有其他命令（含 /plan）：插入命令到输入框，用户手动补充内容后发送
						const beforeSlash = input.substring(0, input.lastIndexOf('/'));
						const newValue = beforeSlash + '/' + selectedCommand.id + ' ';
						setInput(newValue);
						setShowCommandMenu(false);
						setCommandFilter('');
					}
				} else {
					// No matching commands: close menu and send as regular message
					setShowCommandMenu(false);
					setCommandFilter('');
					handleSend();
				}
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setShowCommandMenu(false);
				setCommandFilter('');
				return;
			}
			// For other keys, let the default input behavior handle it (handleInputChange will update filter)
			// But if the input no longer looks like a command (has space after command word), close the menu
			return;
		}
		
		// 如果技能菜单显示，处理菜单导航
		if (showSkillMenu) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedSkillIndex(prev => 
					prev < filteredSkills.length - 1 ? prev + 1 : 0
				);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedSkillIndex(prev => 
					prev > 0 ? prev - 1 : filteredSkills.length - 1
				);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				if (filteredSkills.length > 0) {
					const selectedSkill = filteredSkills[selectedSkillIndex];
					// 插入选定的技能到输入框
					const beforeSlash = input.substring(0, input.lastIndexOf('/'));
					const newValue = beforeSlash + '/skill ' + selectedSkill.id + ' ';
					setInput(newValue);
					setShowSkillMenu(false);
					setSkillFilter('');
				}
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setShowSkillMenu(false);
				setSkillFilter('');
				return;
			}
			return;
		}
		
		// 默认处理：Enter 发送，Escape 取消
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (isLoading && !input.trim()) { return; }
			handleSend();
		}
		if (e.key === 'Escape' && isLoading && onCancel) {
			e.preventDefault();
			onCancel();
		}
	}, [showCommandMenu, showSkillMenu, filteredCommands, filteredSkills, selectedCommandIndex, selectedSkillIndex, input, isLoading, onCancel, handleSend, onCommand, loadSkills]);

	return (
		<div className="chat-input-area">
			<div className="chat-composer-box">
				{/* 顶部拖动条：手动调整 textarea 高度（最低 60px / 最高 300px） */}
				<div
					className="chat-composer-resizer"
					title="拖动调整输入框高度"
					role="separator"
					aria-orientation="horizontal"
				>
					<span
						className="chat-composer-resizer-grip"
						onMouseDown={handleResizerMouseDown}
					/>
				</div>

				{/* 上方：文本输入 */}
				<textarea
					ref={textareaRef}
					value={input}
					onChange={handleInputChange}
					onKeyDown={handleKeyDownWithCommands}
					onInput={handleInput}
					placeholder={composerPlaceholder}
					rows={1}
					className="chat-composer-textarea"
				/>
				
				{/* 命令菜单 */}
				{showCommandMenu && filteredCommands.length > 0 && (
					<div className="command-menu" ref={commandMenuRef}>
						<div className="command-menu-header">
							<span>可用命令</span>
						</div>
						{filteredCommands.map((cmd, index) => (
							<div
								key={cmd.id}
								className={`command-menu-item ${index === selectedCommandIndex ? 'selected' : ''}`}
								onClick={() => {
									if (cmd.id === 'skill') {
										setShowCommandMenu(false);
										setShowSkillMenu(true);
										setSkillFilter('');
										setSelectedSkillIndex(0);
										loadSkills();
									} else {
										// 所有其他命令（含 /plan）：插入命令到输入框，用户手动补充内容后发送
										const beforeSlash = input.substring(0, input.lastIndexOf('/'));
										const newValue = beforeSlash + '/' + cmd.id + ' ';
										setInput(newValue);
										setShowCommandMenu(false);
										setCommandFilter('');
									}
								}}
							>
								<span className="command-menu-icon">{cmd.icon}</span>
								<span className="command-menu-name">/{cmd.id}</span>
								<span className="command-menu-desc">{cmd.description}</span>
							</div>
						))}
					</div>
				)}
				
				{/* 技能菜单 */}
				{showSkillMenu && (
					<div className="skill-menu" ref={skillMenuRef}>
						<div className="skill-menu-header">
							<span>选择技能</span>
							<input
								type="text"
								className="skill-menu-search"
								placeholder="输入过滤技能..."
								value={skillFilter}
								readOnly
								onClick={(e) => e.stopPropagation()}
							/>
						</div>
						{filteredSkills.length > 0 ? (
							filteredSkills.map((skill, index) => (
								<div
									key={skill.id}
									className={`skill-menu-item ${index === selectedSkillIndex ? 'selected' : ''}`}
									onClick={() => {
										const beforeSlash = input.substring(0, input.lastIndexOf('/'));
										const newValue = beforeSlash + '/skill ' + skill.id + ' ';
										setInput(newValue);
										setShowSkillMenu(false);
										setSkillFilter('');
									}}
								>
									<span className="skill-menu-name">{skill.name}</span>
									<span className="skill-menu-id">{skill.id}</span>
								</div>
							))
						) : (
							<div className="skill-menu-empty">无可用技能</div>
						)}
					</div>
				)}

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

						{/* Mode 选择器 */}
						<div className="provider-model-chip-wrap mode-chip-wrap" ref={modeDropdownRef}>
							<button
								className="chat-toolbar-btn has-label mode-tag"
								title={modeOptions.find(m => m.id === chatMode)?.description || '选择模式'}
								onClick={() => {
									const wasOpen = showModeDropdown;
									closeAllDropdowns();
									if (!wasOpen) { setShowModeDropdown(true); }
								}}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d={modeOptions.find(m => m.id === chatMode)?.icon || 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'} />
								</svg>
								<span className="toolbar-btn-label">{modeOptions.find(m => m.id === chatMode)?.label || 'Craft'}</span>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
						{showModeDropdown && (
							<div className="provider-dropdown mode-dropdown-composer">
								{modeOptions.map(opt => (
									<button
										key={opt.id}
										className={`provider-dropdown-item mode-item ${chatMode === opt.id ? 'active' : ''}`}
										onClick={() => {
											setChatMode(opt.id);
											setShowModeDropdown(false);
										}}
									>
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mode-item-icon">
											<path d={opt.icon} />
										</svg>
										<div className="mode-item-text">
											<span className="provider-dropdown-name">{opt.label}</span>
										</div>
										{chatMode === opt.id && (
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
										<span className="mode-item-tooltip">{opt.description}</span>
									</button>
								))}
							</div>
						)}
						</div>

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
												title={[
													m.descriptionZh || m.descriptionEn || '',
													m.maxInputTokens ? `最大输入: ${m.maxInputTokens.toLocaleString()} tokens` : '',
													m.maxOutputTokens ? `最大输出: ${m.maxOutputTokens.toLocaleString()} tokens` : '',
													`图片: ${m.supportsImages ? '支持' : '不支持'}`,
													`思考模式: ${m.supportsReasoning ? '支持' : '不支持'}`,
													m.onlyReasoning ? '仅思考模式' : '',
													m.temperature !== undefined ? `温度: ${m.temperature}` : '',
												].filter(Boolean).join('\n')}
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

						{/* Thinking / 思考模式 控件 — 仅当模型支持时显示 */}
						{modelSupportsReasoning && (
							<div className="provider-model-chip-wrap reasoning-chip-wrap" ref={reasoningPopoverRef}>
								<button
									className={`chat-toolbar-btn has-label reasoning-tag ${reasoningCfg?.enabled ? 'reasoning-active' : ''}`}
									title={reasoningCfg?.enabled ? '思考模式已开启 — 点击调整' : '开启思考模式'}
									onClick={() => {
										// 纯开关型：直接 toggle，无需弹层；其余形态打开弹层调整
										if (reasoningUIType === 'switch') {
											if (canToggleReasoning) {
												setReasoningConfig({ enabled: !reasoningCfg?.enabled });
											}
											return;
										}
										const wasOpen = showReasoningPopover;
										closeAllDropdowns();
										if (!wasOpen) { setShowReasoningPopover(true); }
									}}
								>
									{/* 灯泡/思考图标 */}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M9 18h6" />
										<path d="M10 22h4" />
										<path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
									</svg>
									<span className="toolbar-btn-label">
										{reasoningCfg?.enabled
											? (reasoningUIType === 'effort-slider'
												? `思考·${reasoningCfg.effort === 'high' ? '高' : reasoningCfg.effort === 'medium' ? '中' : '低'}`
												: reasoningUIType === 'budget-slider'
													? `思考·${((reasoningCfg.budget ?? 0) / 1024).toFixed(1)}K`
													: '思考')
											: '思考'}
									</span>
									{reasoningUIType !== 'switch' && (
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
											<path d="M6 9l6 6 6-6" />
										</svg>
									)}
								</button>
								{showReasoningPopover && reasoningUIType !== 'switch' && (
									<div className="provider-dropdown reasoning-popover">
										{/* 开关行 */}
										<div className="reasoning-popover-row">
											<span className="reasoning-popover-label">思考模式</span>
											<button
												className={`reasoning-switch ${reasoningCfg?.enabled ? 'on' : ''}`}
												disabled={!canToggleReasoning}
												onClick={() => setReasoningConfig({ enabled: !reasoningCfg?.enabled })}
												title={canToggleReasoning ? '开启/关闭思考' : '该模型仅思考模式，无法关闭'}
											>
												<span className="reasoning-switch-knob" />
											</button>
										</div>

										{/* effort 三档 */}
										{reasoningUIType === 'effort-slider' && reasoningCfg?.enabled && (
											<div className="reasoning-popover-row reasoning-effort-row">
												{(['low', 'medium', 'high'] as const).map(lv => (
													<button
														key={lv}
														className={`reasoning-effort-btn ${reasoningCfg.effort === lv ? 'active' : ''}`}
														onClick={() => setReasoningConfig({ effort: lv })}
													>
														{lv === 'high' ? '高' : lv === 'medium' ? '中' : '低'}
													</button>
												))}
											</div>
										)}

										{/* budget 滑块 */}
										{reasoningUIType === 'budget-slider' && reasoningCfg?.enabled && (
											<div className="reasoning-popover-row reasoning-budget-row">
												<input
													type="range"
													min={REASONING_BUDGET_MIN}
													max={REASONING_BUDGET_MAX}
													step={REASONING_BUDGET_STEP}
													value={reasoningCfg.budget ?? REASONING_BUDGET_MIN}
													onChange={(e) => setReasoningConfig({ budget: Number(e.target.value) })}
													className="reasoning-budget-slider"
												/>
												<span className="reasoning-budget-value">{reasoningCfg.budget ?? REASONING_BUDGET_MIN} tokens</span>
											</div>
										)}
									</div>
								)}
							</div>
						)}
					</div>

					{/* 上下文使用量圆环进度条（发送按钮左侧）*/}
					{contextUsage && (
						<div
							className={`context-usage-ring ${contextUsage.percent >= 90 ? 'danger' : contextUsage.percent >= 70 ? 'warn' : ''}`}
							title={`上下文已使用 ${contextUsage.percent}%（${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.limit)} tokens）`}
						>
							<svg width="20" height="20" viewBox="0 0 20 20">
								{/* 轨道 */}
								<circle
									className="ring-track"
									cx="10"
									cy="10"
									r={RING_RADIUS}
									fill="none"
									strokeWidth="2"
								/>
								{/* 进度（从 12 点方向顺时针）*/}
								<circle
									className="ring-progress"
									cx="10"
									cy="10"
									r={RING_RADIUS}
									fill="none"
									strokeWidth="2"
									strokeLinecap="round"
									strokeDasharray={RING_CIRCUMFERENCE}
									strokeDashoffset={RING_CIRCUMFERENCE * (1 - contextUsage.ratio)}
									transform="rotate(-90 10 10)"
								/>
						</svg>
					</div>
					)}

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
