/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Create Agent Modal
 *  A modal dialog for creating a new Agent (Employee) with configuration fields.
 *  Includes: name, role, model, provider, system prompt, temperature, maxTokens.
 *  Also provides a "Quick Create from Preset" section with built-in presets.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

/* ── Built-in Presets ────────────────────────────────────────────────────────── */

interface Preset {
	id: string;
	name: string;
	role: string;
	icon: string;
	description: string;
	model: string;
	customPrompt: string;
}

const AGENT_PRESETS: Preset[] = [
	{
		id: 'coder',
		name: 'Coder',
		role: 'frontend-engineer',
		icon: '💻',
		description: '擅长编写、审查和重构代码',
		model: 'gpt-4o',
		customPrompt: 'You are an expert software engineer. Write clean, well-documented code following best practices.',
	},
	{
		id: 'researcher',
		name: 'Researcher',
		role: 'researcher',
		icon: '🔍',
		description: '擅长信息搜索、分析和总结',
		model: 'gpt-4o',
		customPrompt: 'You are a thorough research analyst. Find, evaluate, and synthesize information from multiple sources.',
	},
	{
		id: 'writer',
		name: 'Writer',
		role: 'technical-writer',
		icon: '✍️',
		description: '擅长撰写技术文档和内容创作',
		model: 'gpt-4o',
		customPrompt: 'You are a skilled technical writer. Create clear, concise, and well-structured documentation.',
	},
	{
		id: 'designer',
		name: 'Designer',
		role: 'ui-designer',
		icon: '🎨',
		description: '擅长 UI/UX 设计和交互原型',
		model: 'gpt-4o',
		customPrompt: 'You are an experienced UI/UX designer. Create intuitive, accessible, and visually appealing designs.',
	},
	{
		id: 'planner',
		name: 'Planner',
		role: 'project-planner',
		icon: '📋',
		description: '擅长项目规划和任务分解',
		model: 'gpt-4o',
		customPrompt: 'You are a strategic project planner. Break down complex goals into actionable tasks with clear dependencies.',
	},
	{
		id: 'tester',
		name: 'Tester',
		role: 'qa-engineer',
		icon: '🧪',
		description: '擅长测试策略和自动化测试',
		model: 'gpt-4o',
		customPrompt: 'You are a meticulous QA engineer. Design comprehensive test plans and identify edge cases.',
	},
	{
		id: 'devops',
		name: 'DevOps',
		role: 'devops-engineer',
		icon: '🚀',
		description: '擅长 CI/CD 和基础设施管理',
		model: 'gpt-4o',
		customPrompt: 'You are an expert DevOps engineer. Automate deployments, manage infrastructure, and optimize CI/CD pipelines.',
	},
	{
		id: 'data-analyst',
		name: 'Data Analyst',
		role: 'data-analyst',
		icon: '📊',
		description: '擅长数据分析和可视化',
		model: 'gpt-4o',
		customPrompt: 'You are a skilled data analyst. Analyze datasets, identify trends, and create insightful visualizations.',
	},
];

const COMMON_ROLES = [
	'frontend-engineer',
	'backend-engineer',
	'fullstack-engineer',
	'devops-engineer',
	'qa-engineer',
	'researcher',
	'technical-writer',
	'ui-designer',
	'project-planner',
	'data-analyst',
	'security-engineer',
	'architect',
];

const COMMON_MODELS = [
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-4-turbo',
	'claude-3.5-sonnet',
	'claude-3-opus',
	'claude-3-haiku',
	'gemini-1.5-pro',
	'gemini-1.5-flash',
	'deepseek-chat',
	'deepseek-coder',
];

/* ── Component ───────────────────────────────────────────────────────────────── */

interface CreateAgentModalProps {
	isOpen: boolean;
	onClose: () => void;
	workspaceId?: string;
}

type Step = 'preset' | 'custom';

export function CreateAgentModal({ isOpen, onClose, workspaceId }: CreateAgentModalProps): React.ReactElement | null {
	const { createEmployee } = useEmployeeStore();
	const [step, setStep] = useState<Step>('preset');
	const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const modalRef = useRef<HTMLDivElement>(null);

	// Custom form state
	const [name, setName] = useState('');
	const [role, setRole] = useState('frontend-engineer');
	const [model, setModel] = useState('gpt-4o');
	const [provider, setProvider] = useState('');
	const [customPrompt, setCustomPrompt] = useState('');
	const [temperature, setTemperature] = useState(0.7);
	const [maxTokens, setMaxTokens] = useState(4096);

	// Reset on open
	useEffect(() => {
		if (isOpen) {
			setStep('preset');
			setSelectedPreset(null);
			setSearchQuery('');
			setName('');
			setRole('frontend-engineer');
			setModel('gpt-4o');
			setProvider('');
			setCustomPrompt('');
			setTemperature(0.7);
			setMaxTokens(4096);
			setIsSubmitting(false);
		}
	}, [isOpen]);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isOpen) {
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, onClose]);

	// Click outside to close
	const handleOverlayClick = useCallback((e: React.MouseEvent) => {
		if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
			onClose();
		}
	}, [onClose]);

	// Apply preset to form fields
	const handleSelectPreset = useCallback((preset: Preset) => {
		setSelectedPreset(preset);
		setName(preset.name);
		setRole(preset.role);
		setModel(preset.model);
		setCustomPrompt(preset.customPrompt);
		setStep('custom');
	}, []);

	// Submit creation
	const handleSubmit = useCallback(async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !role.trim() || isSubmitting) { return; }

		setIsSubmitting(true);
		try {
			const data: Partial<Employee> = {
				name: name.trim(),
				role: role.trim(),
				model,
				provider: provider.trim() || undefined,
				customPrompt: customPrompt.trim() || undefined,
				temperature,
				maxTokens,
				workspaceId,
				status: 'idle',
			};
			await createEmployee(data);
			onClose();
		} catch (err) {
			console.error('[CreateAgentModal] Failed to create employee:', err);
		} finally {
			setIsSubmitting(false);
		}
	}, [name, role, model, provider, customPrompt, temperature, maxTokens, workspaceId, isSubmitting, createEmployee, onClose]);

	// Filter presets by search
	const filteredPresets = AGENT_PRESETS.filter(p => {
		if (!searchQuery) { return true; }
		const q = searchQuery.toLowerCase();
		return p.name.toLowerCase().includes(q)
			|| p.role.toLowerCase().includes(q)
			|| p.description.toLowerCase().includes(q);
	});

	if (!isOpen) { return null; }

	return (
		<div className="create-agent-overlay" onClick={handleOverlayClick}>
			<div className="create-agent-modal" ref={modalRef}>
				{/* Header */}
				<div className="create-agent-header">
					<h3 className="create-agent-title">
						{step === 'preset' ? '创建 Agent' : '配置 Agent'}
					</h3>
					<button className="create-agent-close" onClick={onClose} title="关闭">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Step indicator */}
				<div className="create-agent-steps">
					<div className={`create-agent-step ${step === 'preset' ? 'active' : 'done'}`}>
						<span className="step-dot">1</span>
						<span className="step-label">选择模板</span>
					</div>
					<div className="step-line" />
					<div className={`create-agent-step ${step === 'custom' ? 'active' : ''}`}>
						<span className="step-dot">2</span>
						<span className="step-label">配置参数</span>
					</div>
				</div>

				{/* Step 1: Preset Selection */}
				{step === 'preset' && (
					<div className="create-agent-preset-section">
						<div className="preset-search">
							<svg className="preset-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
							</svg>
							<input
								type="text"
								className="preset-search-input"
								placeholder="搜索预设模板..."
								value={searchQuery}
								onChange={e => setSearchQuery(e.target.value)}
								autoFocus
							/>
						</div>

						<div className="preset-grid">
							{filteredPresets.map(preset => (
								<div
									key={preset.id}
									className="preset-card"
									onClick={() => handleSelectPreset(preset)}
								>
									<div className="preset-card-icon">{preset.icon}</div>
									<div className="preset-card-info">
										<div className="preset-card-name">{preset.name}</div>
										<div className="preset-card-desc">{preset.description}</div>
									</div>
								</div>
							))}
						</div>

						<div className="preset-custom-entry">
							<button
								className="preset-custom-btn"
								onClick={() => {
									setName('');
									setRole('frontend-engineer');
									setModel('gpt-4o');
									setCustomPrompt('');
									setStep('custom');
								}}
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
								</svg>
								<span>自定义创建</span>
							</button>
						</div>
					</div>
				)}

				{/* Step 2: Custom Configuration */}
				{step === 'custom' && (
					<form className="create-agent-form" onSubmit={handleSubmit}>
						<div className="form-scroll-area">
							{/* Preset badge if came from preset */}
							{selectedPreset && (
								<div className="form-preset-badge">
									<span className="preset-badge-icon">{selectedPreset.icon}</span>
									<span className="preset-badge-name">{selectedPreset.name}</span>
									<button
										type="button"
										className="preset-badge-change"
										onClick={() => setStep('preset')}
									>
										更换
									</button>
								</div>
							)}

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>名称 <span className="required">*</span></label>
									<input
										type="text"
										value={name}
										onChange={e => setName(e.target.value)}
										placeholder="输入 Agent 名称"
										required
										autoFocus
									/>
								</div>
								<div className="form-field form-field-flex">
									<label>角色 <span className="required">*</span></label>
									<select value={role} onChange={e => setRole(e.target.value)}>
										{COMMON_ROLES.map(r => (
											<option key={r} value={r}>{r}</option>
										))}
									</select>
								</div>
							</div>

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>模型</label>
									<select value={model} onChange={e => setModel(e.target.value)}>
										{COMMON_MODELS.map(m => (
											<option key={m} value={m}>{m}</option>
										))}
									</select>
								</div>
								<div className="form-field form-field-flex">
									<label>Provider</label>
									<input
										type="text"
										value={provider}
										onChange={e => setProvider(e.target.value)}
										placeholder="e.g. openai"
									/>
								</div>
							</div>

							<div className="form-field">
								<label>系统提示词</label>
								<textarea
									value={customPrompt}
									onChange={e => setCustomPrompt(e.target.value)}
									rows={4}
									placeholder="自定义 Agent 的系统提示词..."
								/>
							</div>

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>Temperature: {temperature}</label>
									<input
										type="range"
										min={0}
										max={2}
										step={0.1}
										value={temperature}
										onChange={e => setTemperature(parseFloat(e.target.value))}
									/>
								</div>
								<div className="form-field form-field-flex">
									<label>Max Tokens</label>
									<input
										type="number"
										min={256}
										max={128000}
										step={256}
										value={maxTokens}
										onChange={e => setMaxTokens(parseInt(e.target.value, 10) || 4096)}
									/>
								</div>
							</div>
						</div>

						<div className="form-actions">
							<button
								type="button"
								className="btn-secondary"
								onClick={() => setStep('preset')}
							>
								上一步
							</button>
							<button
								type="submit"
								className="btn-primary"
								disabled={isSubmitting || !name.trim() || !role.trim()}
							>
								{isSubmitting ? '创建中...' : '创建 Agent'}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
