/*---------------------------------------------------------------------------------------------
 *  Agent Editor Pane
 *  Unified configuration editor opened in the left panel.
 *  Tabs: System Prompt | Skills | ConfigMD | Tools | MCP | Rules
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEmployeeStore, type Employee, type MemoryConfig, type MemoryEntry, type KnowledgeConfig, type KnowledgeSource } from '../../store/useEmployeeStore';
import { useConfigMdStore } from '../../store/useConfigMdStore';
import {
	bindIframeChannel,
	fetchState,
	onHtmlRendered,
	onSourceChanged,
	writeSource,
	postSyncToIframe,
	renderHtml,
	previewToFile,
} from '../configmd/configMdBridge';
import { openHtmlPreview, openUntitledText } from '../../bridge/fileBridge';
import { MarkdownEditor } from '../configmd/MarkdownEditor';
import { ConfigMdSettings } from '../configmd/ConfigMdSettings';
import { CONFIG_MD_DEMO } from '../configmd/configMdDemo';
import { sendRequest } from '../../bridge/messageClient';

/* ── Tab definitions ─────────────────────────────────────────── */
type TabId = 'prompt' | 'skills' | 'memory' | 'knowledge' | 'configmd' | 'tools' | 'mcp' | 'rules';

interface TabDef {
	id: TabId;
	label: string;
	icon: string;
}

const TABS: TabDef[] = [
	{ id: 'prompt',    label: 'System Prompt', icon: '💬' },
	{ id: 'skills',    label: '技能配置',     icon: '🛠' },
	{ id: 'memory',    label: 'Memory',       icon: '🧠' },
	{ id: 'knowledge', label: '知识库',       icon: '📚' },
	{ id: 'tools',     label: 'Tool 配置',    icon: '🔧' },
	{ id: 'mcp',       label: 'MCP 配置',    icon: '🔌' },
	{ id: 'rules',     label: 'Rule 配置',    icon: '📏' },
	{ id: 'configmd',  label: 'ConfigMD',    icon: '📝' },
];

/* ── Props ─────────────────────────────────────────────────────── */
interface AgentEditorPaneProps {
	employeeId: string;
	onClose: () => void;
}

/* ═════════════════════════════════════════════════════════════════════
 *  SkillsDragDropPanel — left: all skills, right: agent skills
 * ═════════════════════════════════════════════════════════════════════ */

interface SkillsDragDropPanelProps {
	employeeId: string;
	agentSkills: { id: string; name: string; enabled: boolean }[];
	onUpdateSkills: (skills: { id: string; name: string; enabled: boolean }[]) => void;
	allSkills: Array<{ id: string; name: string; category: string; activation: string; description?: string }>;
}

function SkillsDragDropPanel({ employeeId, agentSkills, onUpdateSkills, allSkills }: SkillsDragDropPanelProps): React.ReactElement {
	const [leftFilter, setLeftFilter] = useState('');
	const [rightFilter, setRightFilter] = useState('');
	const [dragOverSide, setDragOverSide] = useState<'left' | 'right' | null>(null);

	// Agent skill IDs set for quick lookup
	const agentSkillIds = new Set(agentSkills.map(s => s.id));

	// Left: all skills NOT installed on this agent
	const availableSkills = allSkills.filter(
		s => !agentSkillIds.has(s.id) && s.name.toLowerCase().includes(leftFilter.toLowerCase()),
	);

	// Right: agent skills
	const installedSkills = agentSkills.filter(
		s => s.name.toLowerCase().includes(rightFilter.toLowerCase()),
	);

	const handleDragStart = (e: React.DragEvent, skill: { id: string; name: string; category: string; activation: string; description?: string } | { id: string; name: string; enabled: boolean }, from: 'left' | 'right') => {
		e.dataTransfer.setData('application/json', JSON.stringify({ skill, from }));
		e.dataTransfer.effectAllowed = 'move';
	};

	const handleDragOver = (e: React.DragEvent, side: 'left' | 'right') => {
		e.preventDefault();
		setDragOverSide(side);
	};

	const handleDragLeave = () => {
		setDragOverSide(null);
	};

	const handleDrop = (e: React.DragEvent, targetSide: 'left' | 'right') => {
		e.preventDefault();
		setDragOverSide(null);
		const data = e.dataTransfer.getData('application/json');
		if (!data) return;
		const { skill, from } = JSON.parse(data) as { skill: { id: string; name: string; category: string; activation: string }; from: 'left' | 'right' };

		if (from === 'left' && targetSide === 'right') {
			// Install skill
			if (!agentSkillIds.has(skill.id)) {
				onUpdateSkills([...agentSkills, { id: skill.id, name: skill.name, enabled: true }]);
			}
		} else if (from === 'right' && targetSide === 'left') {
			// Uninstall skill
			onUpdateSkills(agentSkills.filter(s => s.id !== skill.id));
		}
	};

	const handleToggleEnabled = (skillId: string) => {
		onUpdateSkills(
			agentSkills.map(s => s.id === skillId ? { ...s, enabled: !s.enabled } : s),
		);
	};

	return (
		<div className="skills-drag-drop-panel">
			{/* Left: Available Skills */}
			<div
				className={`skills-panel skills-panel-left ${dragOverSide === 'left' ? 'drag-over' : ''}`}
				onDragOver={(e) => handleDragOver(e, 'left')}
				onDragLeave={handleDragLeave}
				onDrop={(e) => handleDrop(e, 'left')}
			>
				<div className="skills-panel-header">
					<h4>所有技能</h4>
					<span className="skills-panel-count">{allSkills.length - agentSkills.length}</span>
				</div>
				<input
					type="text"
					className="skills-search-input"
					placeholder="搜索技能..."
					value={leftFilter}
					onChange={(e) => setLeftFilter(e.target.value)}
				/>
				<div className="skills-panel-list">
					{availableSkills.length === 0 && (
						<div className="skills-panel-empty">
							{leftFilter ? '未找到匹配的技能' : '所有技能已安装'}
						</div>
					)}
					{availableSkills.map(skill => (
						<div
							key={skill.id}
							className="skill-item skill-item-draggable"
							draggable
							onDragStart={(e) => handleDragStart(e, skill, 'left')}
							title={`${skill.name} (${skill.category})`}
						>
							<span className="skill-item-icon">🛠</span>
							<div className="skill-item-info">
								<span className="skill-item-name">{skill.name}</span>
								<span className="skill-item-category">{skill.category}</span>
							</div>
							<span className="skill-item-hint">拖拽安装</span>
						</div>
					))}
				</div>
			</div>

			{/* Divider with arrows */}
			<div className="skills-panel-divider">
				<div className="skills-divider-arrow">→</div>
				<div className="skills-divider-hint">拖拽</div>
				<div className="skills-divider-arrow">←</div>
			</div>

			{/* Right: Installed Skills */}
			<div
				className={`skills-panel skills-panel-right ${dragOverSide === 'right' ? 'drag-over' : ''}`}
				onDragOver={(e) => handleDragOver(e, 'right')}
				onDragLeave={handleDragLeave}
				onDrop={(e) => handleDrop(e, 'right')}
			>
				<div className="skills-panel-header">
					<h4>已安装技能</h4>
					<span className="skills-panel-count">{agentSkills.length}</span>
				</div>
				<input
					type="text"
					className="skills-search-input"
					placeholder="搜索已安装..."
					value={rightFilter}
					onChange={(e) => setRightFilter(e.target.value)}
				/>
				<div className="skills-panel-list">
					{installedSkills.length === 0 && (
						<div className="skills-panel-empty">
							{rightFilter ? '未找到匹配的技能' : '暂无已安装技能，从左侧拖拽添加'}
						</div>
					)}
					{installedSkills.map(skill => (
						<div
							key={skill.id}
							className="skill-item skill-item-draggable"
							draggable
							onDragStart={(e) => handleDragStart(e, skill, 'right')}
						>
							<span className="skill-item-icon">🛠</span>
							<div className="skill-item-info">
								<span className="skill-item-name">{skill.name}</span>
								<span className={`skill-item-status ${skill.enabled ? 'enabled' : 'disabled'}`}>
									{skill.enabled ? '已启用' : '已禁用'}
								</span>
							</div>
							<label className="skill-toggle-switch" title={skill.enabled ? '点击禁用' : '点击启用'}>
								<input
									type="checkbox"
									checked={skill.enabled}
									onChange={() => handleToggleEnabled(skill.id)}
								/>
								<span className="skill-toggle-slider" />
							</label>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/* ═════════════════════════════════════════════════════════════════════
 *  MemoryConfigPanel — memory settings + entries CRUD
 * ═════════════════════════════════════════════════════════════════════ */

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	enabled: true,
	maxEntries: 100,
	strategy: 'sliding_window',
	windowSize: 20,
	entries: [],
};

interface MemoryConfigPanelProps {
	employeeId: string;
	config: MemoryConfig | undefined;
	onUpdate: (config: MemoryConfig) => void;
}

function MemoryConfigPanel({ employeeId, config, onUpdate }: MemoryConfigPanelProps): React.ReactElement {
	const cfg = config || DEFAULT_MEMORY_CONFIG;
	const [newEntryKey, setNewEntryKey] = useState('');
	const [newEntryValue, setNewEntryValue] = useState('');
	const [newEntryCategory, setNewEntryCategory] = useState('');
	const [filterCategory, setFilterCategory] = useState('');

	const handleAddEntry = useCallback(() => {
		if (!newEntryKey.trim() || !newEntryValue.trim()) return;
		const entry: MemoryEntry = {
			id: `mem_${Date.now().toString(36)}`,
			key: newEntryKey.trim(),
			value: newEntryValue.trim(),
			category: newEntryCategory.trim() || undefined,
			createdAt: new Date().toISOString(),
		};
		onUpdate({ ...cfg, entries: [...cfg.entries, entry] });
		setNewEntryKey('');
		setNewEntryValue('');
		setNewEntryCategory('');
	}, [cfg, newEntryKey, newEntryValue, newEntryCategory, onUpdate]);

	const handleDeleteEntry = useCallback((id: string) => {
		onUpdate({ ...cfg, entries: cfg.entries.filter(e => e.id !== id) });
	}, [cfg, onUpdate]);

	const handleUpdateEntry = useCallback((id: string, field: keyof MemoryEntry, value: string) => {
		onUpdate({ ...cfg, entries: cfg.entries.map(e => e.id === id ? { ...e, [field]: value } : e) });
	}, [cfg, onUpdate]);

	// Extract categories
	const categories = Array.from(new Set(cfg.entries.map(e => e.category).filter(Boolean) as string[]));
	const filteredEntries = filterCategory
		? cfg.entries.filter(e => e.category === filterCategory)
		: cfg.entries;

	return (
		<div className="memory-config-panel">
			<div className="config-section">
				<div className="config-section-header">
					<h4>基础设置</h4>
				</div>
				<div className="config-section-body">
					<div className="config-row">
						<label className="config-row-label">启用 Memory</label>
						<label className="skill-toggle-switch">
							<input
								type="checkbox"
								checked={cfg.enabled}
								onChange={() => onUpdate({ ...cfg, enabled: !cfg.enabled })}
							/>
							<span className="skill-toggle-slider" />
						</label>
					</div>
					<div className="config-row">
						<label className="config-row-label">记忆策略</label>
						<select
							className="config-row-select"
							value={cfg.strategy}
							onChange={(e) => onUpdate({ ...cfg, strategy: e.target.value as MemoryConfig['strategy'] })}
						>
							<option value="sliding_window">滑动窗口</option>
							<option value="summary">摘要压缩</option>
							<option value="full">完整保留</option>
						</select>
					</div>
					<div className="config-row">
						<label className="config-row-label">最大条目数</label>
						<input
							type="number"
							className="config-row-input"
							value={cfg.maxEntries}
							min={1}
							max={10000}
							onChange={(e) => onUpdate({ ...cfg, maxEntries: Math.max(1, parseInt(e.target.value) || 100) })}
						/>
					</div>
					{cfg.strategy === 'sliding_window' && (
						<div className="config-row">
							<label className="config-row-label">窗口大小</label>
							<input
								type="number"
								className="config-row-input"
								value={cfg.windowSize || 20}
								min={1}
								max={1000}
								onChange={(e) => onUpdate({ ...cfg, windowSize: Math.max(1, parseInt(e.target.value) || 20) })}
							/>
						</div>
					)}
				</div>
			</div>

			<div className="config-section">
				<div className="config-section-header">
					<h4>记忆条目 ({cfg.entries.length})</h4>
					{categories.length > 0 && (
						<select
							className="config-row-select config-filter-select"
							value={filterCategory}
							onChange={(e) => setFilterCategory(e.target.value)}
						>
							<option value="">全部类别</option>
							{categories.map(c => <option key={c} value={c}>{c}</option>)}
						</select>
					)}
				</div>
				<div className="config-section-body">
					<div className="memory-entry-add">
						<input
							type="text"
							className="config-row-input"
							placeholder="分类"
							value={newEntryCategory}
							onChange={(e) => setNewEntryCategory(e.target.value)}
							style={{ width: 80, flexShrink: 0 }}
						/>
						<input
							type="text"
							className="config-row-input"
							placeholder="键名"
							value={newEntryKey}
							onChange={(e) => setNewEntryKey(e.target.value)}
						/>
						<input
							type="text"
							className="config-row-input"
							placeholder="值"
							value={newEntryValue}
							onChange={(e) => setNewEntryValue(e.target.value)}
						/>
						<button
							className="btn-primary btn-sm"
							onClick={handleAddEntry}
							disabled={!newEntryKey.trim() || !newEntryValue.trim()}
						>添加</button>
					</div>
					<div className="memory-entry-list">
						{filteredEntries.length === 0 && (
							<div className="config-empty-hint">
								{filterCategory ? '该类别下暂无条目' : '暂无记忆条目，请在上方添加'}
							</div>
						)}
						{filteredEntries.map(entry => (
							<div key={entry.id} className="memory-entry-row">
								{entry.category && <span className="memory-entry-category">{entry.category}</span>}
								<input
									type="text"
									className="memory-entry-key"
									value={entry.key}
									onChange={(e) => handleUpdateEntry(entry.id, 'key', e.target.value)}
									placeholder="键"
								/>
								<input
									type="text"
									className="memory-entry-value"
									value={entry.value}
									onChange={(e) => handleUpdateEntry(entry.id, 'value', e.target.value)}
									placeholder="值"
								/>
								<button className="btn-icon btn-delete" onClick={() => handleDeleteEntry(entry.id)} title="删除">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="14" height="14">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ═════════════════════════════════════════════════════════════════════
 *  KnowledgeConfigPanel — knowledge base settings + sources CRUD
 * ═════════════════════════════════════════════════════════════════════ */

const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
	enabled: true,
	retrievalStrategy: 'hybrid',
	maxResults: 5,
	sources: [],
};

interface KnowledgeConfigPanelProps {
	employeeId: string;
	config: KnowledgeConfig | undefined;
	onUpdate: (config: KnowledgeConfig) => void;
}

function KnowledgeConfigPanel({ employeeId, config, onUpdate }: KnowledgeConfigPanelProps): React.ReactElement {
	const cfg = config || DEFAULT_KNOWLEDGE_CONFIG;
	const [newSourceType, setNewSourceType] = useState<KnowledgeSource['type']>('text');
	const [newSourceName, setNewSourceName] = useState('');
	const [newSourcePath, setNewSourcePath] = useState('');
	const [newSourceDesc, setNewSourceDesc] = useState('');

	const handleAddSource = useCallback(() => {
		if (!newSourceName.trim() || !newSourcePath.trim()) return;
		const source: KnowledgeSource = {
			id: `ks_${Date.now().toString(36)}`,
			name: newSourceName.trim(),
			type: newSourceType,
			source: newSourcePath.trim(),
			enabled: true,
			description: newSourceDesc.trim() || undefined,
		};
		onUpdate({ ...cfg, sources: [...cfg.sources, source] });
		setNewSourceName('');
		setNewSourcePath('');
		setNewSourceDesc('');
	}, [cfg, newSourceType, newSourceName, newSourcePath, newSourceDesc, onUpdate]);

	const handleDeleteSource = useCallback((id: string) => {
		onUpdate({ ...cfg, sources: cfg.sources.filter(s => s.id !== id) });
	}, [cfg, onUpdate]);

	const handleToggleSource = useCallback((id: string) => {
		onUpdate({ ...cfg, sources: cfg.sources.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s) });
	}, [cfg, onUpdate]);

	const sourceTypeIcon = (type: KnowledgeSource['type']) => {
		switch (type) {
			case 'file': return '📄';
			case 'url': return '🔗';
			case 'text': return '📝';
			case 'vector_store': return '🗄';
		}
	};

	return (
		<div className="knowledge-config-panel">
			<div className="config-section">
				<div className="config-section-header">
					<h4>基础设置</h4>
				</div>
				<div className="config-section-body">
					<div className="config-row">
						<label className="config-row-label">启用知识库</label>
						<label className="skill-toggle-switch">
							<input
								type="checkbox"
								checked={cfg.enabled}
								onChange={() => onUpdate({ ...cfg, enabled: !cfg.enabled })}
							/>
							<span className="skill-toggle-slider" />
						</label>
					</div>
					<div className="config-row">
						<label className="config-row-label">检索策略</label>
						<select
							className="config-row-select"
							value={cfg.retrievalStrategy}
							onChange={(e) => onUpdate({ ...cfg, retrievalStrategy: e.target.value as KnowledgeConfig['retrievalStrategy'] })}
						>
							<option value="keyword">关键词匹配</option>
							<option value="semantic">语义检索</option>
							<option value="hybrid">混合检索</option>
						</select>
					</div>
					<div className="config-row">
						<label className="config-row-label">最大结果数</label>
						<input
							type="number"
							className="config-row-input"
							value={cfg.maxResults}
							min={1}
							max={50}
							onChange={(e) => onUpdate({ ...cfg, maxResults: Math.max(1, parseInt(e.target.value) || 5) })}
						/>
					</div>
				</div>
			</div>

			<div className="config-section">
				<div className="config-section-header">
					<h4>知识源 ({cfg.sources.length})</h4>
				</div>
				<div className="config-section-body">
					<div className="knowledge-source-add">
						<select
							className="config-row-select"
							value={newSourceType}
							onChange={(e) => setNewSourceType(e.target.value as KnowledgeSource['type'])}
							style={{ width: 90, flexShrink: 0 }}
						>
							<option value="text">文本</option>
							<option value="file">文件</option>
							<option value="url">URL</option>
							<option value="vector_store">向量库</option>
						</select>
						<input
							type="text"
							className="config-row-input"
							placeholder="名称"
							value={newSourceName}
							onChange={(e) => setNewSourceName(e.target.value)}
						/>
						<input
							type="text"
							className="config-row-input"
							placeholder={newSourceType === 'file' ? '文件路径' : newSourceType === 'url' ? 'URL 地址' : newSourceType === 'vector_store' ? '向量库 ID' : '文本内容'}
							value={newSourcePath}
							onChange={(e) => setNewSourcePath(e.target.value)}
							style={{ flex: 2 }}
						/>
						<button
							className="btn-primary btn-sm"
							onClick={handleAddSource}
							disabled={!newSourceName.trim() || !newSourcePath.trim()}
						>添加</button>
					</div>
					{newSourceType === 'text' && (
						<textarea
							className="knowledge-source-textarea"
							placeholder="输入文本内容..."
							value={newSourcePath}
							onChange={(e) => setNewSourcePath(e.target.value)}
							rows={3}
						/>
					)}
					<input
						type="text"
						className="config-row-input"
						placeholder="描述（可选）"
						value={newSourceDesc}
						onChange={(e) => setNewSourceDesc(e.target.value)}
						style={{ marginTop: 4 }}
					/>
					<div className="knowledge-source-list">
						{cfg.sources.length === 0 && (
							<div className="config-empty-hint">暂无知识源，请在上方添加</div>
						)}
						{cfg.sources.map(source => (
							<div key={source.id} className={`knowledge-source-row ${source.enabled ? '' : 'disabled'}`}>
								<span className="knowledge-source-type-icon">{sourceTypeIcon(source.type)}</span>
								<div className="knowledge-source-info">
									<span className="knowledge-source-name">{source.name}</span>
									<span className="knowledge-source-path">{source.type === 'text' ? '(文本)' : source.source}</span>
									{source.description && <span className="knowledge-source-desc">{source.description}</span>}
								</div>
								<label className="skill-toggle-switch" title={source.enabled ? '点击禁用' : '点击启用'}>
									<input
										type="checkbox"
										checked={source.enabled}
										onChange={() => handleToggleSource(source.id)}
									/>
									<span className="skill-toggle-slider" />
								</label>
								<button className="btn-icon btn-delete" onClick={() => handleDeleteSource(source.id)} title="删除">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="14" height="14">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ═════════════════════════════════════════════════════════════════════
 *  TabErrorBoundary
 *
 *  A minimal class-component error boundary used to prevent a single
 *  misbehaving tab body from taking down the entire AgentEditorPane.
 *  Without this, a render-time exception inside ConfigMD's editor would
 *  freeze the surrounding chat/settings panel, since React unmounts the
 *  whole subtree and any subsequent setState attempts throw.
 * ═════════════════════════════════════════════════════════════════════ */
interface TabErrorBoundaryProps {
	label: string;
	children: React.ReactNode;
}
interface TabErrorBoundaryState {
	error: Error | null;
}
class TabErrorBoundary extends React.Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
	constructor(props: TabErrorBoundaryProps) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
		return { error };
	}
	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		// eslint-disable-next-line no-console
		console.error(`[AgentEditorPane] Render error in tab '${this.props.label}':`, error, info?.componentStack);
	}
	render(): React.ReactNode {
		if (this.state.error) {
			return (
				<div style={{ padding: 16, color: 'var(--vscode-errorForeground, #f48771)' }}>
					<div style={{ fontWeight: 600, marginBottom: 8 }}>
						⚠ {this.props.label} 渲染失败
					</div>
					<div style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
						{this.state.error.message}
					</div>
					<button
						type="button"
						style={{
							marginTop: 12,
							padding: '4px 12px',
							background: 'var(--vscode-button-background)',
							color: 'var(--vscode-button-foreground)',
							border: 'none',
							borderRadius: 2,
							cursor: 'pointer',
						}}
						onClick={() => this.setState({ error: null })}
					>
						重试
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

/* ═════════════════════════════════════════════════════════════════════
 *  AgentEditorPane Component
 * ═════════════════════════════════════════════════════════════════════ */
export function AgentEditorPane({ employeeId, onClose }: AgentEditorPaneProps): React.ReactElement {
	const { employees, updateEmployee } = useEmployeeStore();
	const employee = employees.find(e => e.id === employeeId) ?? null;

	const [activeTab, setActiveTab] = useState<TabId>('prompt');

	// ── System Prompt state ──────────────────────────────────────────
	const [prompt, setPrompt] = useState(employee?.customPrompt || '');
	const [promptDirty, setPromptDirty] = useState(false);

	// ── Skills state (from employee.skills[]) ───────────────────────
	// Skills may be strings or objects {id, name, enabled, description}
	const normalizeSkills = (skills: any[]): string[] =>
		(skills || []).map(s => typeof s === 'string' ? s : s.id).filter(Boolean);
	const [skills, setSkills] = useState<string[]>(
		normalizeSkills(employee?.skills || []),
	);

	// ── Memory state ──────────────────────────────────────────────────
	const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(
		employee?.memoryConfig || { enabled: true, maxEntries: 100, strategy: 'sliding_window', windowSize: 20, entries: [] },
	);

	// ── Knowledge state ───────────────────────────────────────────────
	const [knowledgeConfig, setKnowledgeConfig] = useState<KnowledgeConfig>(
		employee?.knowledgeConfig || { enabled: true, retrievalStrategy: 'hybrid', maxResults: 5, sources: [] },
	);

	// ── All Skills state (loaded dynamically from host) ───────────────────────
	const [allSkills, setAllSkills] = useState<Array<{ id: string; name: string; category: string; activation: string; description?: string }>>([]);
	const [skillsLoading, setSkillsLoading] = useState(true);
	const [skillsError, setSkillsError] = useState<string | null>(null);

	// ── ConfigMD state (reuse configMdStore) ──────────────────────
	const configMdState = useConfigMdStore((s) => s.byAgent[employeeId]);
	const setMdState = useConfigMdStore((s) => s.setState);
	const updateMdLocal = useConfigMdStore((s) => s.updateMarkdownLocal);
	const [showMdConfig, setShowMdConfig] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const debounceRef = useRef<number | null>(null);

	// Sync employee changes
	useEffect(() => {
		if (employee) {
			setPrompt(employee.customPrompt || '');
			setPromptDirty(false);
			setSkills(normalizeSkills(employee.skills || []));
			setMemoryConfig(employee.memoryConfig || { enabled: true, maxEntries: 100, strategy: 'sliding_window', windowSize: 20, entries: [] });
			setKnowledgeConfig(employee.knowledgeConfig || { enabled: true, retrievalStrategy: 'hybrid', maxResults: 5, sources: [] });
		}
	}, [employeeId, employee?.customPrompt, employee?.skills, employee?.memoryConfig, employee?.knowledgeConfig]);

	// ── Skills: load all skills from host ─────────────────────────────
	useEffect(() => {
		let cancelled = false;
		setSkillsLoading(true);
		setSkillsError(null);

		sendRequest<unknown, Array<{ id: string; name: string; category: string; activation: string; description?: string }>>('skills.list', {})
			.then((skills) => {
				if (cancelled) return;
				setAllSkills(skills);
				setSkillsLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				console.error('[AgentEditorPane] Failed to load skills:', err);
				setSkillsError(err instanceof Error ? err.message : String(err));
				setSkillsLoading(false);
			});

		return () => { cancelled = true; };
	}, []);

	// ── ConfigMD: load on mount / employeeId / configMd-enabled change ─
	useEffect(() => {
		if (!employee?.configMd) {
			// Not configured yet — clear any stale loaded flag
			return;
		}
		let cancelled = false;
		let done = false;
		const t0 = Date.now();
		console.log(`[AgentEditorPane] fetchState start: employeeId=${employeeId}`);
		// 8s safety timeout — if the host hangs we still surface a clear error
		// instead of leaving the user with a frozen-looking blank panel.
		// Note: we track `done` separately from `cancelled` so a successful
		// fetchState that completes before 8s suppresses the timeout warning
		// even when the effect is still mounted.
		const timeoutPromise = new Promise<null>((resolve) => {
			window.setTimeout(() => {
				if (cancelled || done) { return; }
				console.warn(`[AgentEditorPane] fetchState timeout after 8s for ${employeeId}`);
				resolve(null);
			}, 8000);
		});
		Promise.race([fetchState(employeeId), timeoutPromise]).then((s) => {
			done = true;
			if (cancelled) return;
			console.log(`[AgentEditorPane] fetchState done: employeeId=${employeeId}, hasState=${!!s}, took=${Date.now() - t0}ms`);
			if (s) {
				setMdState(employeeId, {
					markdown: s.markdown,
					html: s.html,
					stylesContent: s.stylesContent,
					version: s.version,
					loaded: true,
					dirty: false,
				});
			}
		}).catch((err) => {
			done = true;
			console.error(`[AgentEditorPane] fetchState failed for ${employeeId}:`, err);
		});
		return () => { cancelled = true; };
	}, [employeeId, !!employee?.configMd, setMdState]);

	// ── ConfigMD: subscribe to host pushes ─────────────────────────
	useEffect(() => {
		const offSrc = onSourceChanged(employeeId, (evt) => {
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (cur && evt.markdown === cur.markdown && evt.version === cur.version) return;
			// Mark as loaded — receiving a source push proves the host has resolved state.
			setMdState(employeeId, { markdown: evt.markdown, version: evt.version, dirty: false, loaded: true });
			postSyncToIframe(iframeRef.current, { markdown: evt.markdown, version: evt.version, origin: evt.origin });
		});
		const offHtml = onHtmlRendered(employeeId, (evt) => {
			// Mark as loaded — receiving HTML render means the panel is ready.
			setMdState(employeeId, {
				html: evt.html,
				version: evt.version,
				stylesContent: evt.stylesContent,
				loaded: true,
			});
		});
		return () => { offSrc(); offHtml(); };
	}, [employeeId, setMdState]);

	// ── ConfigMD: iframe channel bind ─────────────────────────────
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) return;
		const unbind = bindIframeChannel(iframe, employeeId);
		return () => unbind();
	}, [employeeId, configMdState?.loaded]);

	// ── Handlers ───────────────────────────────────────────────────
	const handleSavePrompt = useCallback(() => {
		if (!employeeId) return;
		updateEmployee(employeeId, { customPrompt: prompt });
		setPromptDirty(false);
	}, [employeeId, prompt, updateEmployee]);



	const handleConfigMdChange = useCallback((value: string) => {
		updateMdLocal(employeeId, value);
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current);
		}
		debounceRef.current = window.setTimeout(() => {
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (!cur) return;
			// Only pass baseVersion when state is actually loaded — otherwise the
			// host will reject with "Stale write" because its initial version is 1.
			const opts: { origin: 'editor'; baseVersion?: number } = { origin: 'editor' };
			if (cur.loaded && cur.version > 0) {
				opts.baseVersion = cur.version;
			}
			writeSource(employeeId, cur.markdown, opts)
				.then((r) => {
					setMdState(employeeId, { version: r.version, dirty: false, loaded: true });
				})
				.catch((err) => {
					console.error('[ConfigMD] writeSource failed:', err);
				});
		}, 300);
	}, [employeeId, setMdState, updateMdLocal]);

	// ── ConfigMD preview doc ───────────────────────────────────────
	// Show the preview as soon as html exists, regardless of the explicit
	// `loaded` flag — this avoids a chicken-and-egg state where the agent
	// has just been enabled and html arrives via a renderHtml RPC before
	// the initial fetchState resolves.
	// (Preview iframe was removed; preview is now opened to the host editor
	//  via the toolbar button using `previewToFile`.)

	const agentName = employee?.name || 'Unknown';

	return (
		<div className="agent-editor-pane">
			{/* ── Header ─────────────────────────────────────────── */}
			<div className="agent-editor-header">
				<div className="agent-editor-title">
					<span className="agent-editor-icon">⚙</span>
					<span>{agentName} · 配置</span>
				</div>
				<button className="agent-editor-close" onClick={onClose} title="关闭配置面板">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="16" height="16">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			{/* ── Tab Bar ────────────────────────────────────────── */}
			<div className="agent-editor-tabs">
				{TABS.map(tab => (
					<button
						key={tab.id}
						className={`agent-editor-tab ${activeTab === tab.id ? 'active' : ''}`}
						onClick={() => {
							console.log(`[AgentEditorPane] tab click: ${activeTab} → ${tab.id} (employeeId=${employeeId}, hasConfigMd=${!!employee?.configMd})`);
							setActiveTab(tab.id);
						}}
					>
						<span className="tab-icon">{tab.icon}</span>
						<span className="tab-label">{tab.label}</span>
					</button>
				))}
			</div>

			{/* ── Tab Content ───────────────────────────────────── */}
			<div className="agent-editor-content">

				{/* ── Tab: System Prompt ──────────────────────── */}
				{activeTab === 'prompt' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							编辑 Agent 的系统提示词（System Prompt），这将直接影响 Agent 的行为和回复风格。
						</div>
						<textarea
							className="agent-prompt-editor"
							value={prompt}
							onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
							placeholder="输入系统提示词..."
							spellCheck={false}
						/>
						<div className="editor-tab-actions">
							<button
								className="btn-primary"
								disabled={!promptDirty}
								onClick={handleSavePrompt}
							>
								保存 Prompt
							</button>
							{promptDirty && <span className="dirty-hint">有未保存的修改</span>}
						</div>
					</div>
				)}

			{/* ── Tab: Skills (drag & drop) ─────────────── */}
			{activeTab === 'skills' && (
				<SkillsDragDropPanel
					employeeId={employeeId}
					agentSkills={skills}
					allSkills={allSkills}
					onUpdateSkills={(next) => {
						setSkills(next);
						updateEmployee(employeeId, { skills: next });
					}}
				/>
			)}

				{/* ── Tab: Memory ─────────────────────────────── */}
				{activeTab === 'memory' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							管理 Agent 的记忆配置。Memory 使 Agent 能够跨会话保留和检索信息，提升上下文连续性。
						</div>
						<MemoryConfigPanel
							employeeId={employeeId}
							config={memoryConfig}
							onUpdate={(next) => {
								setMemoryConfig(next);
								updateEmployee(employeeId, { memoryConfig: next });
							}}
						/>
					</div>
				)}

				{/* ── Tab: Knowledge ──────────────────────────── */}
				{activeTab === 'knowledge' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							配置 Agent 的知识库。知识库为 Agent 提供外部知识来源，支持文件、URL、文本和向量库等多种知识源。
						</div>
						<KnowledgeConfigPanel
							employeeId={employeeId}
							config={knowledgeConfig}
							onUpdate={(next) => {
								setKnowledgeConfig(next);
								updateEmployee(employeeId, { knowledgeConfig: next });
							}}
						/>
					</div>
				)}

				{/* ── Tab: ConfigMD ───────────────────────────── */}
				{activeTab === 'configmd' && (
					<TabErrorBoundary label="ConfigMD">
					<div className="editor-tab-body configmd-tab-body">
						{!employee?.configMd ? (
							<div className="configmd-empty-state">
								<div className="configmd-empty-icon">📝</div>
								<div className="configmd-empty-title">ConfigMD 未启用</div>
								<div className="configmd-empty-desc">
									启用后，Agent 将拥有一个 Markdown 配置文件，
									可在右侧实时渲染为 HTML 面板，  
									支持双向同步、自定义解析器与样式。
								</div>
								<button
									type="button"
									className="configmd-empty-btn"
									onClick={() => {
										void updateEmployee(employeeId, {
											configMd: {
												mdPath: 'config.md',
												displayMode: 'side',
												defaultView: 'split',
												editable: true,
												sandboxLevel: 'standard',
												autoShow: true,
												syncDebounceMs: 300,
												capabilities: [
													'md.read',
													'md.write',
													'chat.send',
													'chat.history',
													'agent.status',
													'notification',
												],
											},
										}).catch((err) => {
											console.error('[ConfigMD] enable failed:', err);
										});
									}}
								>
									✨ 启用 ConfigMD
								</button>
								<div className="configmd-empty-hint">
									启用后将在 Agent 目录下创建 <code>config.md</code> 文件
								</div>
							</div>
						) : (
						<>
						<div className="configmd-toolbar">
							<div className="configmd-toolbar-left">
								<button
									className={`configmd-icon-btn ${showMdConfig ? 'active' : ''}`}
									onClick={() => setShowMdConfig(true)}
									title="配置：上传自定义解析器 / 样式"
									aria-label="设置"
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
										<circle cx="12" cy="12" r="3" />
										<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
									</svg>
								</button>
								<button
									className="configmd-icon-btn"
									onClick={() => {
										// Open the demo source in an untitled markdown editor
										// in the host's center editor area, so the user can
										// inspect / copy from it without overwriting the
										// agent's real ConfigMD. This was previously a
										// destructive "load into agent" action gated by a
										// two-step confirm; now it's purely read-only.
										void openUntitledText(CONFIG_MD_DEMO, {
											languageId: 'markdown',
											title: 'ConfigMD Demo',
											preserveFocus: false,
											pinned: true,
										}).catch((err) => {
											console.error('[ConfigMD] open demo failed:', err);
										});
									}}
									title="打开内置示例 Markdown（独立的只读编辑器，不会覆盖当前 Agent 的 ConfigMD）"
									aria-label="示例"
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
										<path d="M14 2v6h6" />
										<path d="M16 13H8M16 17H8M10 9H8" />
									</svg>
									<span className="configmd-icon-btn-text">Demo</span>
								</button>
							</div>
							<div className="configmd-toolbar-right">
								<button
									className="configmd-icon-btn"
									onClick={() => {
										// 1) Flush any pending debounced edit immediately so the
										//    preview reflects the current editor contents.
										if (debounceRef.current) {
											window.clearTimeout(debounceRef.current);
											debounceRef.current = null;
										}
										const cur = useConfigMdStore.getState().byAgent[employeeId];
										const flushed = cur
											? writeSource(employeeId, cur.markdown, {
												origin: 'editor',
												// only pass baseVersion when loaded
												...(cur.loaded && cur.version > 0 ? { baseVersion: cur.version } : {}),
											})
												.then((r) => {
													setMdState(employeeId, { version: r.version, dirty: false, loaded: true });
												})
												.catch(() => undefined)
											: Promise.resolve();
										// 2) After the source is on disk, render & write the
										//    standalone .preview.html, then open it in the host editor.
										void flushed
											.then(() => previewToFile(employeeId))
											.then((r) => openHtmlPreview(r.path, { preserveFocus: false, pinned: true }))
											.catch((err) => {
												console.error('[ConfigMD] open preview failed:', err);
											});
									}}
									title="渲染预览并在左侧编辑器中打开 .preview.html"
									aria-label="预览"
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
										<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
										<circle cx="12" cy="12" r="3" />
									</svg>
									<span className="configmd-icon-btn-text">预览</span>
								</button>
							</div>
						</div>

						{/* MD-only editor — full width, no split. Preview is delegated
						    to the host editor via the toolbar's preview button. */}
						<div className="configmd-editor-body view-source">
							<div className="configmd-source">
								<MarkdownEditor
									value={configMdState?.markdown ?? ''}
									onChange={handleConfigMdChange}
									placeholder="# Markdown 配置..."
								/>
							</div>
						</div>

						{showMdConfig && (
							<ConfigMdSettings
								employeeId={employeeId}
								onClose={() => setShowMdConfig(false)}
								onChanged={() => {
									void renderHtml(employeeId).catch(() => undefined);
								}}
							/>
						)}
						</>
						)}
					</div>
					</TabErrorBoundary>
				)}

				{/* ── Tab: Tools (placeholder) ─────────────────── */}
				{activeTab === 'tools' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							Tool 配置：管理 Agent 可调用的工具列表。
						</div>
						<div className="placeholder-panel">
							<div className="placeholder-icon">🔧</div>
							<div className="placeholder-text">Tool 配置功能即将上线</div>
							<div className="placeholder-hint">
								将通过 Agent 目录下的 <code>tools.md</code> 文件进行配置。
							</div>
						</div>
					</div>
				)}

				{/* ── Tab: MCP (placeholder) ──────────────────── */}
				{activeTab === 'mcp' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							MCP（Model Context Protocol）配置：连接外部工具和数据源。
						</div>
						<div className="placeholder-panel">
							<div className="placeholder-icon">🔌</div>
							<div className="placeholder-text">MCP 配置功能即将上线</div>
							<div className="placeholder-hint">
								将通过 Agent 目录下的 <code>mcp.json</code> 文件进行配置。
							</div>
						</div>
					</div>
				)}

				{/* ── Tab: Rules (placeholder) ─────────────────── */}
				{activeTab === 'rules' && (
					<div className="editor-tab-body">
						<div className="editor-tab-desc">
							Rule 配置：定义 Agent 的行为规则和约束条件。
						</div>
						<div className="placeholder-panel">
							<div className="placeholder-icon">📏</div>
							<div className="placeholder-text">Rule 配置功能即将上线</div>
							<div className="placeholder-hint">
								将通过 Agent 目录下的 <code>rules.md</code> 文件进行配置。
							</div>
						</div>
					</div>
				)}

			</div>
		</div>
	);
}
