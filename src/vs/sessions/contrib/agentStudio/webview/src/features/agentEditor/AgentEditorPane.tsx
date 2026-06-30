/*---------------------------------------------------------------------------------------------
 *  Agent Editor Pane
 *  Unified configuration editor opened in the left panel.
 *  Tabs: System Prompt | Skills | ConfigMD | Tools | MCP | Rules
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStore, type MemoryConfig, type MemoryEntry, type KnowledgeConfig, type KnowledgeSource } from '../../store/useAgentStore';
import { useConfigMdStore } from '../../store/useConfigMdStore';
import {
	bindIframeChannel,
	fetchState,
	onHtmlRendered,
	onSourceChanged,
	writeSource,
	postSyncToIframe,
} from '../configmd/configMdBridge';
import { HtmlEditor } from '../configmd/HtmlEditor';
import { ConfigHtmlChatBox } from '../configmd/ConfigHtmlChatBox';
import { sendRequest } from '../../bridge/messageClient';

/* ── Perf logging helpers ─────────────────────────────────────── */
const PERF_TAG = '[AgentEditorPane.Perf]';

/** Returns a compact ms-since-epoch string for correlating timestamps. */
function nowLabel(): string {
	return `t=${Date.now()}`;
}

/** Returns a high-resolution ms-since-epoch (truncated to 2 decimal places). */
function nowMs(): number {
	return Math.round(performance.now() * 100) / 100;
}

/* ── Tab definitions ─────────────────────────────────────────── */
type TabId = 'prompt' | 'skills' | 'memory' | 'knowledge' | 'configmd' | 'mcp' | 'rules';

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
	{ id: 'mcp',       label: 'MCP 配置',    icon: '🔌' },
	{ id: 'rules',     label: 'Rule 配置',    icon: '📏' },
	{ id: 'configmd',  label: 'ConfigHtml',  icon: '📝' },
];

/* ── Props ─────────────────────────────────────────────────────── */
interface AgentEditorPaneProps {
	agentId: string;
	onClose: () => void;
}

/* ═════════════════════════════════════════════════════════════════════
 *  SkillsDragDropPanel — left: all skills, right: agent skills
 * ═════════════════════════════════════════════════════════════════════ */

interface SkillsDragDropPanelProps {
	agentId: string;
	agentSkillIds: string[];
	onUpdateSkills: (skillIds: string[]) => void;
	allSkills: Array<{ id: string; name: string; category: string; activation: string; description?: string }>;
}

function SkillsDragDropPanel({ agentId, agentSkillIds, onUpdateSkills, allSkills }: SkillsDragDropPanelProps): React.ReactElement {
	const [leftFilter, setLeftFilter] = useState('');
	const [rightFilter, setRightFilter] = useState('');
	const [dragOverSide, setDragOverSide] = useState<'left' | 'right' | null>(null);

	// Agent skill IDs set for quick lookup
	const agentSkillIdSet = new Set(agentSkillIds);

	// Left: all skills NOT installed on this agent
	const availableSkills = allSkills.filter(
		s => s && s.id && s.name && !agentSkillIdSet.has(s.id) && s.name.toLowerCase().includes(leftFilter.toLowerCase()),
	);

	// Right: agent skills (look up names from allSkills)
	const installedSkills = agentSkillIds
		.map(id => allSkills.find(s => s.id === id))
		.filter((s): s is NonNullable<typeof s> => !!s && !!s.name && s.name.toLowerCase().includes(rightFilter.toLowerCase()));

	const handleDragStart = (e: React.DragEvent, skill: { id: string; name: string; category: string; activation: string; description?: string }, from: 'left' | 'right') => {
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
			if (!agentSkillIdSet.has(skill.id)) {
				onUpdateSkills([...agentSkillIds, skill.id]);
			}
		} else if (from === 'right' && targetSide === 'left') {
			// Uninstall skill
			onUpdateSkills(agentSkillIds.filter(id => id !== skill.id));
		}
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
					<span className="skills-panel-count">{allSkills.length - agentSkillIds.length}</span>
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
					<span className="skills-panel-count">{agentSkillIds.length}</span>
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
								<span className="skill-item-status enabled">已安装</span>
							</div>
							<span className="skill-item-hint">拖拽卸载</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/* ═════════════════════════════════════════════════════════════════════
 *  MemoryConfigPanel — memory settings + Persona Memory (永久事实) CRUD
 * ═════════════════════════════════════════════════════════════════════ */

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	enabled: true,
	maxEntries: 100,
	strategy: 'full',
	scope: 'agent',
	entries: [],
};

/**
 * 对旧 agent 配置中的 'sliding_window' 进行加载时迁移：统一视为 'full'。
 * 只在展示 / 下拉选择时用；只要用户一旦修改并 onUpdate，便会在下次落盘时覆盖为 'full' / 'summary'。
 */
function normalizeStrategy(s: MemoryConfig['strategy'] | undefined): 'summary' | 'full' {
	return s === 'summary' ? 'summary' : 'full';
}

/* ── TdbamMemorySection ──────────────────────────────────────────────
 *
 * "自动召回" 分区：根据当前 memory 策略（summary→L1 / full→L0）从 TDB-AM
 * gateway 拉取属于本 agent 的记忆条目，每条带删除按钮。
 *
 * 数据通路：
 *   webview --(sendRequest)--> host AgentStudioWebviewController
 *          --(IRequestService)--> http://127.0.0.1:8420/list/conversations|memories
 *          --SQLite WHERE session_key='agent:<agentId>'
 *
 * sessionKey 推导规则与 host._deriveSessionKey() 完全一致，由 host 统一处理；
 * 此处只传 agentId 即可。
 *
 * 删除是硬删除，不可撤销（与现有 Tdbam ViewPane 行为一致）。
 * ─────────────────────────────────────────────────────────────────── */

interface L0Item {
	recordId: string;
	sessionKey?: string;
	sessionId?: string;
	role: string;
	messageText: string;
	recordedAt: string;
	timestamp: number;
}
interface L1Item {
	recordId: string;
	content: string;
	updatedTime: string;
}

/**
 * 一对 Q + A 的配对单元（与 TdbamViewPane.TurnItem 对齐，便于两处视觉一致）。
 *
 * 配对规则（拷贝自 host 端 _pairConversationTurns）：
 *  1. 按 sessionKey 分桶 — turn 永不跨 session
 *  2. 桶内按 timestamp ASC 排序，相同 ts 时 user 排在 assistant 前（同源 /capture）
 *  3. 一条 user 开启一个 turn，后续连续的 assistant 都归属该 turn 的 answer
 *  4. 连续两条 user 各自开 turn，前一个 turn 即使没收到 assistant 也立刻关闭
 *  5. 没有前置 user 的 assistant 形成 answer-only turn（question 为空）
 *  6. 输出按 timestamp DESC（最新在前）
 */
interface Turn {
	id: string;
	question: string;
	answer: string;
	timestamp: string;
	sessionKey?: string;
	unanswered: boolean;
	answerOnly: boolean;
	recordIds: string[];
}

function pairTurns(rows: readonly L0Item[]): Turn[] {
	// 按 sessionKey 分桶；缺失 key 的归到空桶（兼容 legacy 数据）。
	const buckets = new Map<string, L0Item[]>();
	for (const row of rows) {
		const key = row.sessionKey ?? '';
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = [];
			buckets.set(key, bucket);
		}
		bucket.push(row);
	}

	const turns: Turn[] = [];
	const roleOrder = (role: string | undefined): number =>
		role === 'user' ? 0 : role === 'assistant' ? 1 : 2;

	for (const [sessionKey, bucket] of buckets) {
		// ASC 扫描：相同时间戳 user 先于 assistant
		bucket.sort((a, b) => {
			const tsDiff = (a.timestamp ?? 0) - (b.timestamp ?? 0);
			if (tsDiff !== 0) return tsDiff;
			return roleOrder(a.role) - roleOrder(b.role);
		});

		let openUser: L0Item | undefined;
		let answerParts: string[] = [];
		let answerFirstTs: string | undefined;
		let recordIds: string[] = [];

		const closeOpenTurn = (): void => {
			if (!openUser && answerParts.length === 0) return;
			const question = openUser?.messageText ?? '';
			const answer = answerParts.join('\n\n');
			const ts = openUser?.recordedAt || answerFirstTs || '';
			turns.push({
				id: openUser?.recordId ?? `answer_${ts}_${turns.length}`,
				question,
				answer,
				timestamp: ts,
				sessionKey: sessionKey || undefined,
				unanswered: !!openUser && answerParts.length === 0,
				answerOnly: !openUser && answerParts.length > 0,
				recordIds: recordIds.slice(),
			});
			openUser = undefined;
			answerParts = [];
			answerFirstTs = undefined;
			recordIds = [];
		};

		for (const row of bucket) {
			const role = row.role ?? '';
			if (role === 'user') {
				closeOpenTurn();
				openUser = row;
				if (row.recordId) recordIds.push(row.recordId);
			} else if (role === 'assistant') {
				if (!openUser && answerParts.length === 0) {
					answerFirstTs = row.recordedAt;
				}
				answerParts.push(row.messageText ?? '');
				if (row.recordId) recordIds.push(row.recordId);
			} else {
				// system / tool / 其他角色：折进当前 open turn 的 answer，否则丢弃
				if (openUser || answerParts.length > 0) {
					answerParts.push(`[${role || 'note'}] ${row.messageText ?? ''}`);
					if (row.recordId) recordIds.push(row.recordId);
				}
			}
		}
		closeOpenTurn();
	}

	// DESC by timestamp — 最新对话在最上面
	turns.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
	return turns;
}

/**
 * 把多行文本压成单行预览：合并空白、保留首段，超长截断。
 * 用于折叠态 Q / A 的一行展示。
 */
function toPreview(text: string, maxLen: number = 200): string {
	if (!text) return '';
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= maxLen) return collapsed;
	return collapsed.slice(0, maxLen) + '…';
}

const FETCH_LIMIT = 200;

interface TdbamMemorySectionProps {
	agentId: string;
	strategy: 'summary' | 'full';
	enabled: boolean;
}

function TdbamMemorySection({ agentId, strategy, enabled }: TdbamMemorySectionProps): React.ReactElement {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [l1Items, setL1Items] = useState<L1Item[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 总数：L0 = 原始消息数（非 turn 数），L1 = 摘要条数。与 TdbAm 网关返回的 total 字段对齐 */
	const [total, setTotal] = useState(0);
	/** 已展开的 turn id 集合 */
	const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());

	const layer: 'L0' | 'L1' = strategy === 'summary' ? 'L1' : 'L0';

	const refresh = useCallback(async () => {
		if (!agentId) return;
		setLoading(true);
		setError(null);
		try {
			if (layer === 'L0') {
				const resp = await sendRequest<{ agentId: string; limit: number }, { items: L0Item[]; total: number }>(
					'memory.listL0',
					{ agentId, limit: FETCH_LIMIT },
				);
				const items = resp?.items ?? [];
				setTurns(pairTurns(items));
				setTotal(resp?.total ?? items.length);
				// 切换 agent 时清空展开状态，避免不同 agent 之间残留
				setExpandedTurns(new Set());
			} else {
				const resp = await sendRequest<{ agentId: string; limit: number }, { items: L1Item[]; total: number }>(
					'memory.listL1',
					{ agentId, limit: FETCH_LIMIT },
				);
				setL1Items(resp?.items ?? []);
				setTotal(resp?.total ?? 0);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [agentId, layer]);

	// 切换 agent / 切换策略 / 切到 Memory tab 时自动刷新一次
	useEffect(() => {
		void refresh();
	}, [refresh]);

	/**
	 * 删除一个 turn（L0）= 删除其底层所有 recordIds（user + 全部 assistant 折叠行）；
	 * 或删除一条 L1 摘要。
	 */
	const handleDelete = useCallback(async (recordIds: string[]) => {
		if (recordIds.length === 0) return;
		const label = layer === 'L0' ? '该轮对话（含 user + assistant）' : '该条 L1 摘要';
		const ok = window.confirm(`删除${label}？此操作不可撤销。`);
		if (!ok) return;

		const channel = layer === 'L0' ? 'memory.deleteL0' : 'memory.deleteL1';
		try {
			const resp = await sendRequest<{ agentId: string; recordIds: string[] }, { deleted: number; failed: string[] }>(
				channel,
				{ agentId, recordIds },
			);
			if (!resp || resp.deleted === 0) {
				const detail = resp?.failed?.length ? `失败：${resp.failed.join(', ')}` : '网关未确认删除';
				setError(detail);
				return;
			}
			// 本地乐观更新
			if (layer === 'L0') {
				const removeSet = new Set(recordIds);
				setTurns(prev => prev.filter(t => !t.recordIds.some(id => removeSet.has(id))));
			} else {
				const removeSet = new Set(recordIds);
				setL1Items(prev => prev.filter(it => !removeSet.has(it.recordId)));
			}
			setTotal(t => Math.max(0, t - resp.deleted));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [agentId, layer]);

	const toggleExpand = useCallback((id: string) => {
		setExpandedTurns(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		});
	}, []);

	const renderRows = (): React.ReactNode => {
		if (loading) {
			return <div className="config-empty-hint">加载中…</div>;
		}
		if (error) {
			return <div className="config-empty-hint" style={{ color: 'var(--vscode-errorForeground, #c00)' }}>{error}</div>;
		}
		if (layer === 'L0') {
			if (turns.length === 0) {
				return <div className="config-empty-hint">暂无 L0 对话记录</div>;
			}
			return turns.map(turn => {
				const isExpanded = expandedTurns.has(turn.id);
				const qPreview = turn.answerOnly ? '(无 user 消息)' : toPreview(turn.question);
				const aPreview = turn.unanswered ? '(等待回复)' : toPreview(turn.answer);
				return (
					<div key={turn.id} className="memory-entry-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
						{/* ── 折叠态：标题行（点击切换展开） ───────────── */}
						<div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}
							onClick={() => toggleExpand(turn.id)}
							title={isExpanded ? '点击折叠' : '点击展开查看完整 user / assistant 内容'}>
							<span style={{ flexShrink: 0, fontSize: 10, opacity: 0.7, width: 14, textAlign: 'center', userSelect: 'none' }}>
								{isExpanded ? '▼' : '▶'}
							</span>
							<div style={{ flex: 1, minWidth: 0 }}>
								<div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
									{turn.timestamp}
									{turn.unanswered && <span style={{ marginLeft: 8, color: 'var(--vscode-editorWarning-foreground, #b8860b)' }}>· 未回复</span>}
									{turn.answerOnly && <span style={{ marginLeft: 8, opacity: 0.6 }}>· 仅 assistant</span>}
									{turn.recordIds.length > 2 && <span style={{ marginLeft: 8, opacity: 0.6 }}>· {turn.recordIds.length} 条</span>}
								</div>
								<div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
									<span className="memory-entry-category" style={{ marginRight: 6 }}>Q</span>
									<span>{qPreview || '(empty)'}</span>
								</div>
								<div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85 }}>
									<span className="memory-entry-category" style={{ marginRight: 6 }}>A</span>
									<span>{aPreview || '(empty)'}</span>
								</div>
							</div>
							<button
								className="btn-icon btn-delete"
								onClick={(e) => { e.stopPropagation(); void handleDelete(turn.recordIds); }}
								title={`删除整轮对话（${turn.recordIds.length} 条 L0 记录，不可撤销）`}
								style={{ flexShrink: 0 }}
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="14" height="14">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
						{/* ── 展开态：完整 user / assistant 文本 ───────── */}
						{isExpanded && (
							<div style={{ marginLeft: 20, paddingLeft: 8, borderLeft: '2px solid var(--vscode-panel-border, #444)', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
								{!turn.answerOnly && (
									<div>
										<div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
											<span className="memory-entry-category">user</span>
										</div>
										<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
											{turn.question || '(empty)'}
										</div>
									</div>
								)}
								{!turn.unanswered && (
									<div>
										<div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
											<span className="memory-entry-category">assistant</span>
										</div>
										<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
											{turn.answer || '(empty)'}
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				);
			});
		}
		if (l1Items.length === 0) {
			return <div className="config-empty-hint">暂无 L1 摘要记忆</div>;
		}
		return l1Items.map(it => (
			<div key={it.recordId} className="memory-entry-row" style={{ alignItems: 'flex-start' }}>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>{it.updatedTime}</div>
					<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
						{it.content}
					</div>
				</div>
				<button
					className="btn-icon btn-delete"
					onClick={() => void handleDelete([it.recordId])}
					title="删除该条 L1 记忆（不可撤销）"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="14" height="14">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		));
	};

	return (
		<div className="config-section">
			<div className="config-section-header">
				<h4>
					自动召回 · {layer}
					<span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6, fontWeight: 'normal' }}>
						{layer === 'L0' ? '原始对话（来自 TDB-AM）' : '摘要记忆（来自 TDB-AM）'} · 共 {total} 条
					</span>
				</h4>
				<button className="btn-secondary btn-sm" onClick={() => void refresh()} disabled={loading}>
					{loading ? '刷新中…' : '刷新'}
				</button>
			</div>
			<div className="config-section-body">
				{!enabled && (
					<div className="config-empty-hint" style={{ marginBottom: 8 }}>
						Memory 已关闭：仅作展示，运行时不会被注入到 Prompt
					</div>
				)}
				<div className="memory-entry-list">
					{renderRows()}
				</div>
			</div>
		</div>
	);
}

interface MemoryConfigPanelProps {
	agentId: string;
	config: MemoryConfig | undefined;
	onUpdate: (config: MemoryConfig) => void;
}

function MemoryConfigPanel({ agentId, config, onUpdate }: MemoryConfigPanelProps): React.ReactElement {
	const rawCfg = config || DEFAULT_MEMORY_CONFIG;
	// 迁移展示：旧值 sliding_window 统一视为 full。
	const cfg: MemoryConfig = { ...rawCfg, strategy: normalizeStrategy(rawCfg.strategy) };
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
							<option value="summary">摘要压缩（仅 L1）</option>
							<option value="full">完整保留（L1 + L0）</option>
						</select>
					</div>
					<div className="config-row">
						<label
							className="config-row-label"
							title="决定本 Agent 在每轮对话开始时召回 L1 时能看到哪些 agent 的记忆。L2/L3 长期画像始终全局共享，不受此选项影响。"
						>
							记忆作用域
						</label>
						<select
							className="config-row-select"
							value={cfg.scope ?? 'agent'}
							onChange={(e) => onUpdate({ ...cfg, scope: e.target.value as 'agent' | 'workspace' | 'global' })}
							title="agent: 仅本 Agent 自己的记忆\nworkspace: 当前 workspace 下所有 agent 共享\nglobal: 全库（兼容旧行为）"
						>
							<option value="agent">仅本 Agent（默认 / 严格隔离）</option>
							<option value="workspace">本 Workspace 共享</option>
							<option value="global">全局（兼容旧行为）</option>
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
					{/* sliding_window 策略已下线；windowSize 仅作为序列化兼容字段保留 */}
				</div>
			</div>

			<TdbamMemorySection
				agentId={agentId}
				strategy={cfg.strategy as 'summary' | 'full'}
				enabled={cfg.enabled}
			/>

			<div className="config-section">
				<div className="config-section-header">
					<h4>
						Persona Memory ({cfg.entries.length})
						<span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6, fontWeight: 'normal' }}>
							永久事实 · 每轮注入 system prompt 顶部 · 永不衰减
						</span>
					</h4>
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
							placeholder="事实标签（如：老板）"
							value={newEntryKey}
							onChange={(e) => setNewEntryKey(e.target.value)}
						/>
						<input
							type="text"
							className="config-row-input"
							placeholder="事实内容（如：张三）"
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
								{filterCategory ? '该类别下暂无条目' : '暂无 Persona Memory。在上方添加你希望模型永远记住的硬性事实/规则。'}
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
									placeholder="事实标签"
								/>
								<input
									type="text"
									className="memory-entry-value"
									value={entry.value}
									onChange={(e) => handleUpdateEntry(entry.id, 'value', e.target.value)}
									placeholder="事实内容"
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
	agentId: string;
	config: KnowledgeConfig | undefined;
	onUpdate: (config: KnowledgeConfig) => void;
}

function KnowledgeConfigPanel({ agentId, config, onUpdate }: KnowledgeConfigPanelProps): React.ReactElement {
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
export function AgentEditorPane({ agentId, onClose }: AgentEditorPaneProps): React.ReactElement {
	/* ── Perf: render‑count & timing refs (don't trigger re‑renders) ── */
	const perfRef = useRef({
		renderCount: 0,
		lastRenderMs: nowMs(),
		mountMs: nowMs(),
		loggedStoreState: false,
	});

	perfRef.current.renderCount++;
	const renderStartMs = nowMs();
	const sinceLastRender = renderStartMs - perfRef.current.lastRenderMs;

	console.log(
		`${PERF_TAG} RENDER #${perfRef.current.renderCount} | ${nowLabel()} | ` +
		`Δ${sinceLastRender.toFixed(1)}ms since last render | agentId=${agentId}`
	);

	const { agents, updateAgent } = useAgentStore();

	const t0Resolve = nowMs();
	// Agent (from useAgentStore) carries systemPrompt & skills for builtin/custom agents
	const agent = agents.find(a => a.id === agentId);
	const resolveMs = nowMs() - t0Resolve;

	// Log store resolution on first render where data is available
	if (!perfRef.current.loggedStoreState && agents.length > 0) {
		perfRef.current.loggedStoreState = true;
		console.log(
			`${PERF_TAG} STORE_RESOLVE | ${nowLabel()} | ` +
			`agents.length=${agents.length}, ` +
			`found agent=${!!agent}, ` +
			`resolve took=${resolveMs.toFixed(1)}ms`
		);
	}
	// Log store empty state (data hasn't arrived yet)
	if (!perfRef.current.loggedStoreState && agents.length === 0 && perfRef.current.renderCount === 1) {
		console.log(
			`${PERF_TAG} STORE_EMPTY | ${nowLabel()} | ` +
			`Agent store is empty on first render — data has not arrived from host yet`
		);
	}

	// DEBUG: Log actual data values for this agent on every render (not just first)
	console.log(
		`${PERF_TAG} AGENT_DATA | ${nowLabel()} | agentId=${agentId} | ` +
		`foundAgent=${!!agent} | ` +
		`agent.systemPromptLen=${agent?.systemPrompt?.length || 0} ` +
		`agent.skillsLen=${agent?.skills?.length || 0}`
	);

	const [activeTab, setActiveTab] = useState<TabId>('prompt');

	// ── Rename state ───────────────────────────────────────────────────
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [renameError, setRenameError] = useState('');
	const [renameSaving, setRenameSaving] = useState(false);
	const renameInputRef = useRef<HTMLInputElement>(null);

	// Start rename: populate input with current name and focus
	const handleStartRename = useCallback(() => {
		if (!agent) return;
		setRenameValue(agent.name);
		setRenameError('');
		setIsRenaming(true);
		// Focus after render
		setTimeout(() => {
			renameInputRef.current?.focus();
			renameInputRef.current?.select();
		}, 0);
	}, [agent]);

	const handleCancelRename = useCallback(() => {
		setIsRenaming(false);
		setRenameError('');
		setRenameValue('');
	}, []);

	const handleConfirmRename = useCallback(async () => {
		if (!agent || !agentId) return;
		const newName = renameValue.trim();
		if (!newName) {
			setRenameError('名称不能为空');
			return;
		}
		if (newName === agent.name) {
			// No change — just exit
			setIsRenaming(false);
			setRenameError('');
			return;
		}
		setRenameSaving(true);
		setRenameError('');
		try {
			// Check for duplicate name (excluding self)
			const allAgents = await sendRequest<unknown, Array<{ id: string; name: string }>>(
				'agents.list', {}
			);
			const duplicate = allAgents?.find(
				a => a.id !== agentId && a.name.toLowerCase() === newName.toLowerCase()
			);
			if (duplicate) {
				setRenameError(`已存在名为 "${newName}" 的 Agent`);
				setRenameSaving(false);
				return;
			}
			// Perform the rename
			await updateAgent(agentId, { name: newName });
			// Notify host to update editor tab label
			window.postMessage({
				type: 'agentStudio:agent-renamed',
				agentId,
				newName,
			}, '*');
			setIsRenaming(false);
			setRenameError('');
			setRenameSaving(false);
		} catch (err) {
			setRenameError(`重命名失败: ${err instanceof Error ? err.message : String(err)}`);
			setRenameSaving(false);
		}
	}, [agent, agentId, renameValue, updateAgent]);

	const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleConfirmRename();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			handleCancelRename();
		}
	}, [handleConfirmRename, handleCancelRename]);


	// ── System Prompt state ──────────────────────────────────────────
	// Prefer agent.customPrompt (user override), fallback to agent.systemPrompt (builtin default)
	const initialPrompt = agent?.customPrompt || agent?.systemPrompt || '';
	const [prompt, setPrompt] = useState(initialPrompt);
	const [promptDirty, setPromptDirty] = useState(false);

	// ── Skills state (from agent.skills) ──────────
	// Skills may be strings or objects {id, name, enabled, description}
	const normalizeSkills = (skills: any[]): string[] =>
		(skills || []).map(s => typeof s === 'string' ? s : s.id).filter(Boolean);
	const [skills, setSkills] = useState<string[]>(
		normalizeSkills(agent?.skills || []),
	);

	// ── Memory state ──────────────────────────────────────────────────
	const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(
		agent?.memoryConfig || { enabled: true, maxEntries: 100, strategy: 'full', entries: [] },
	);

	// ── Knowledge state ───────────────────────────────────────────────
	const [knowledgeConfig, setKnowledgeConfig] = useState<KnowledgeConfig>(
		agent?.knowledgeConfig || { enabled: true, retrievalStrategy: 'hybrid', maxResults: 5, sources: [] },
	);

	// ── All Skills state (loaded dynamically from host) ───────────────────────
	const [allSkills, setAllSkills] = useState<Array<{ id: string; name: string; category: string; activation: string; description?: string }>>([]);
	const [skillsLoading, setSkillsLoading] = useState(true);
	const [skillsError, setSkillsError] = useState<string | null>(null);

	// ── ConfigMD state (reuse configMdStore) ──────────────────────
	const configMdState = useConfigMdStore((s) => s.byAgent[agentId]);
	const setMdState = useConfigMdStore((s) => s.setState);
	const updateMdLocal = useConfigMdStore((s) => s.updateMarkdownLocal);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const debounceRef = useRef<number | null>(null);

	// Sync agent changes — updates form when data loads
	useEffect(() => {
		const t0 = nowMs();
		console.log(
			`${PERF_TAG} EFFECT:sync | ${nowLabel()} | ` +
			`agentId=${agentId}, hasAgent=${!!agent}`
		);
		if (agent) {
			const newPrompt = agent?.customPrompt || agent?.systemPrompt || '';
			const promptSource = agent?.customPrompt ? 'agent.customPrompt' : agent?.systemPrompt ? 'agent.systemPrompt' : 'none';
			setPrompt(newPrompt);
			setPromptDirty(false);
			setSkills(normalizeSkills(agent?.skills || []));
			setMemoryConfig(agent?.memoryConfig || { enabled: true, maxEntries: 100, strategy: 'full', entries: [] });
			setKnowledgeConfig(agent?.knowledgeConfig || { enabled: true, retrievalStrategy: 'hybrid', maxResults: 5, sources: [] });
			console.log(
				`${PERF_TAG} EFFECT:sync DONE | ${nowLabel()} | ` +
				`took=${(nowMs() - t0).toFixed(1)}ms ` +
				`promptLen=${newPrompt.length} promptSource=${promptSource} ` +
				`skills=${JSON.stringify(normalizeSkills(agent?.skills || []))}`
			);
		} else {
			console.log(
				`${PERF_TAG} EFFECT:sync SKIP | ${nowLabel()} | ` +
				`No agent data yet, took=${(nowMs() - t0).toFixed(1)}ms`
			);
		}
	}, [agentId, agent?.systemPrompt, agent?.customPrompt, agent?.skills, agent?.memoryConfig, agent?.knowledgeConfig]);

	// ── Skills: load all skills from host ─────────────────────────────
	useEffect(() => {
		let cancelled = false;
		const t0 = nowMs();
		console.log(
			`${PERF_TAG} EFFECT:skills:start | ${nowLabel()} | ` +
			`Loading skills from host via sendRequest('skills.list')`
		);
		setSkillsLoading(true);
		setSkillsError(null);

		sendRequest<unknown, Array<{ id: string; name: string; category: string; activation: string; description?: string }>>('skills.list', {})
			.then((skills) => {
				if (cancelled) return;
				const elapsed = nowMs() - t0;
				console.log(
					`${PERF_TAG} EFFECT:skills:done | ${nowLabel()} | ` +
					`Received ${skills.length} skills, took=${elapsed.toFixed(1)}ms`
				);
				setAllSkills(skills);
				setSkillsLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				const elapsed = nowMs() - t0;
				console.error(
					`${PERF_TAG} EFFECT:skills:fail | ${nowLabel()} | ` +
					`Failed after ${elapsed.toFixed(1)}ms:`, err
				);
				setSkillsError(err instanceof Error ? err.message : String(err));
				setSkillsLoading(false);
			});

		return () => { cancelled = true; };
	}, []);

	// ── ConfigMD: load on mount / agentId / configMd-enabled change ─
	useEffect(() => {
		if (!agent?.configMd) {
			// Not configured yet — clear any stale loaded flag
			console.log(
				`${PERF_TAG} EFFECT:fetchState:skip | ${nowLabel()} | ` +
				`agent.configMd not configured for agentId=${agentId}`
			);
			return;
		}
		let cancelled = false;
		let done = false;
		const t0 = Date.now();
		console.log(
			`${PERF_TAG} EFFECT:fetchState:start | ${nowLabel()} | ` +
			`agentId=${agentId}, mdPath=${agent.configMd.mdPath}, timeout=8000ms`
		);
		// 8s safety timeout — if the host hangs we still surface a clear error
		// instead of leaving the user with a frozen-looking blank panel.
		// Note: we track `done` separately from `cancelled` so a successful
		// fetchState that completes before 8s suppresses the timeout warning
		// even when the effect is still mounted.
		const timeoutPromise = new Promise<null>((resolve) => {
			window.setTimeout(() => {
				if (cancelled || done) { return; }
				console.warn(
					`${PERF_TAG} EFFECT:fetchState:timeout | ${nowLabel()} | ` +
					`fetchState timed out after 8s for agentId=${agentId}`
				);
				resolve(null);
			}, 8000);
		});
		Promise.race([fetchState(agentId), timeoutPromise]).then((s) => {
			done = true;
			if (cancelled) return;
			const elapsed = Date.now() - t0;
			console.log(
				`${PERF_TAG} EFFECT:fetchState:done | ${nowLabel()} | ` +
				`agentId=${agentId}, hasState=${!!s}, markdownLen=${s?.markdown?.length ?? 0}, ` +
				`htmlLen=${s?.html?.length ?? 0}, version=${s?.version ?? 'N/A'}, took=${elapsed}ms`
			);
			if (s) {
				setMdState(agentId, {
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
			const elapsed = Date.now() - t0;
			console.error(
				`${PERF_TAG} EFFECT:fetchState:fail | ${nowLabel()} | ` +
				`agentId=${agentId}, took=${elapsed}ms:`, err
			);
		});
		return () => { cancelled = true; };
	}, [agentId, !!agent?.configMd, setMdState]);

	// ── ConfigMD: subscribe to host pushes ─────────────────────────
	useEffect(() => {
		const offSrc = onSourceChanged(agentId, (evt) => {
			const cur = useConfigMdStore.getState().byAgent[agentId];
			if (cur && evt.markdown === cur.markdown && evt.version === cur.version) return;
			// Mark as loaded — receiving a source push proves the host has resolved state.
			setMdState(agentId, { markdown: evt.markdown, version: evt.version, dirty: false, loaded: true });
			postSyncToIframe(iframeRef.current, { markdown: evt.markdown, version: evt.version, origin: evt.origin });
		});
		const offHtml = onHtmlRendered(agentId, (evt) => {
			// Mark as loaded — receiving HTML render means the panel is ready.
			setMdState(agentId, {
				html: evt.html,
				version: evt.version,
				stylesContent: evt.stylesContent,
				loaded: true,
			});
		});
		return () => { offSrc(); offHtml(); };
	}, [agentId, setMdState]);

	// ── ConfigMD: iframe channel bind ─────────────────────────────
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) return;
		const unbind = bindIframeChannel(iframe, agentId);
		return () => unbind();
	}, [agentId, configMdState?.loaded]);

	// ── Handlers ───────────────────────────────────────────────────
	const handleSavePrompt = useCallback(() => {
		if (!agentId) return;
		updateAgent(agentId, { customPrompt: prompt });
		setPromptDirty(false);
	}, [agentId, prompt, updateAgent]);

	// ── Header button handlers ──
	const handleChat = useCallback(() => {
		window.postMessage({ type: 'agentStudio:close-self' }, '*');
		// Trigger agent selection to open chat
		window.postMessage({ type: 'agentStudio:select-agent', agentId }, '*');
	}, [agentId]);

	const handleExport = useCallback(async () => {
		if (!agentId) return;
		try {
			const result = await sendRequest<{ agentId: string }, { version: number; exportedAt: string; agent: Record<string, unknown>; files: Record<string, unknown> }>(
				'agents.export', { agentId }
			);
			const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${agentId}-export.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error('[AgentEditorPane] Export failed:', err);
		}
	}, [agentId]);



	const handleConfigMdChange = useCallback((value: string) => {
		updateMdLocal(agentId, value);
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current);
		}
		debounceRef.current = window.setTimeout(() => {
			const cur = useConfigMdStore.getState().byAgent[agentId];
			if (!cur) return;
			// Only pass baseVersion when state is actually loaded — otherwise the
			// host will reject with "Stale write" because its initial version is 1.
			const opts: { origin: 'editor'; baseVersion?: number } = { origin: 'editor' };
			if (cur.loaded && cur.version > 0) {
				opts.baseVersion = cur.version;
			}
			writeSource(agentId, cur.markdown, opts)
				.then((r) => {
					setMdState(agentId, { version: r.version, dirty: false, loaded: true });
				})
				.catch((err) => {
					console.error('[ConfigMD] writeSource failed:', err);
				});
		}, 300);
	}, [agentId, setMdState, updateMdLocal]);

	// ── ConfigHtml AI box → editor write-back ──────────────────────
	// The AI chat box returns a complete HTML document; write it into the
	// editor (local store) and immediately persist it to disk, reusing the
	// same debounced write path semantics as manual edits (but flushing now).
	const handleHtmlGenerated = useCallback((html: string) => {
		updateMdLocal(agentId, html);
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		const cur = useConfigMdStore.getState().byAgent[agentId];
		const opts: { origin: 'editor'; baseVersion?: number } = { origin: 'editor' };
		if (cur && cur.loaded && cur.version > 0) {
			opts.baseVersion = cur.version;
		}
		writeSource(agentId, html, opts)
			.then((r) => {
				setMdState(agentId, { version: r.version, dirty: false, loaded: true });
			})
			.catch((err) => {
				console.error('[ConfigHtml] write generated HTML failed:', err);
			});
	}, [agentId, setMdState, updateMdLocal]);
	// Show the preview as soon as html exists, regardless of the explicit
	// `loaded` flag — this avoids a chicken-and-egg state where the agent
	// has just been enabled and html arrives via a renderHtml RPC before
	// the initial fetchState resolves.
	// (Preview iframe was removed; preview is now opened to the host editor
	//  via the toolbar button using `previewToFile`.)

	// ── Perf: record render completion ──────────────────────────────
	const renderEndMs = nowMs();
	const renderDuration = renderEndMs - renderStartMs;
	if (perfRef.current.renderCount <= 5 || renderDuration > 8) {
		// Log first few renders and any slow render (>8ms) for visibility
		console.log(
			`${PERF_TAG} RENDER_DONE #${perfRef.current.renderCount} | ${nowLabel()} | ` +
			`duration=${renderDuration.toFixed(1)}ms, activeTab=${activeTab}, ` +
			`skillsLoading=${skillsLoading}, hasMdState=${!!configMdState?.loaded}`
		);
	}
	perfRef.current.lastRenderMs = renderStartMs;

	return (
		<div className="agent-editor-pane">
			{/* ── Header: Agent Summary Card ────────────────────── */}
			{agent && (
				<div className="agent-editor-header">
					<div className="agent-header-avatar">{agent.icon || '🤖'}</div>
					<div className="agent-header-meta">
						<div className="agent-header-title-line">
							{isRenaming ? (
								<div className="agent-header-rename">
									<input
										ref={renameInputRef}
										className="agent-rename-input"
										type="text"
										value={renameValue}
										onChange={(e) => { setRenameValue(e.target.value); setRenameError(''); }}
										onKeyDown={handleRenameKeyDown}
										disabled={renameSaving}
										placeholder="输入新名称"
									/>
									<button
										className="agent-rename-btn confirm"
										onClick={handleConfirmRename}
										disabled={renameSaving}
										title="确认重命名"
									>
										{renameSaving ? '⏳' : '✓'}
									</button>
									<button
										className="agent-rename-btn cancel"
										onClick={handleCancelRename}
										disabled={renameSaving}
										title="取消"
									>
										✕
									</button>
								</div>
							) : (
								<>
									<span
										className="agent-header-title editable"
										onDoubleClick={handleStartRename}
										title="双击重命名"
									>
										{agent.name}
									</span>
									<button
										className="agent-rename-trigger"
										onClick={handleStartRename}
										title="重命名 Agent"
									>
										✏️
									</button>
									{agent.version && (
										<span className="agent-header-version">✓ v{agent.version}</span>
									)}
								</>
							)}
						</div>
						{renameError && (
							<div className="agent-header-rename-error">{renameError}</div>
						)}
						<div className="agent-header-desc">{agent.description || agent.role}</div>
						<div className="agent-header-stats">
							<span className="stat-item"><span className="stat-icon">🛠</span> <span className="stat-value">{agent.skills?.length || 0}</span> skills</span>
							<span className="stat-item"><span className="stat-icon">🤖</span> <span className="stat-value">{agent.model || 'default'}</span></span>
							{agent.category && (
								<span className="stat-item"><span className="stat-icon">📂</span> {agent.category}</span>
							)}
						</div>
					</div>
					<div className="agent-header-actions">
						<button className="header-btn" onClick={handleExport} title="导出 Agent">
							📦 导出
						</button>
						<button className="header-btn primary" onClick={handleChat} title={`与 ${agent.name} 对话`}>
							💬 对话
						</button>
					</div>
				</div>
			)}

			{/* ── Tab Bar ────────────────────────────────────────── */}
			<div className="agent-editor-tabs">
				{TABS.map(tab => {
					// Badge counts per tab
					let badge: number | undefined;
					if (tab.id === 'skills' && agent?.skills) { badge = agent.skills.length; }
					if (tab.id === 'mcp') { /* MCP count TBD */ }
					return (
						<button
							key={tab.id}
							className={`agent-editor-tab ${activeTab === tab.id ? 'active' : ''}`}
							onClick={() => { setActiveTab(tab.id); }}
						>
							<span className="tab-icon">{tab.icon}</span>
							<span className="tab-label">{tab.label}</span>
							{badge !== undefined && badge > 0 && (
								<span className="tab-badge">{badge}</span>
							)}
						</button>
					);
				})}
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
					agentId={agentId}
					agentSkillIds={skills}
					allSkills={allSkills}
					onUpdateSkills={(next) => {
						setSkills(next);
						updateAgent(agentId, { skills: next });
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
							agentId={agentId}
							config={memoryConfig}
							onUpdate={(next) => {
								setMemoryConfig(next);
								updateAgent(agentId, { memoryConfig: next });
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
							agentId={agentId}
							config={knowledgeConfig}
							onUpdate={(next) => {
								setKnowledgeConfig(next);
								updateAgent(agentId, { knowledgeConfig: next });
							}}
						/>
					</div>
				)}

				{/* ── Tab: ConfigMD ───────────────────────────── */}
				{activeTab === 'configmd' && (
					<TabErrorBoundary label="ConfigMD">
					<div className="editor-tab-body configmd-tab-body">
						{!agent?.configMd ? (
							<div className="configmd-empty-state">
								<div className="configmd-empty-icon">📝</div>
								<div className="configmd-empty-title">ConfigHtml 未启用</div>
								<div className="configmd-empty-desc">
									启用后，Agent 将拥有一个 HTML 配置文件，
									可用 AI 直接生成页面，在 Canvas 中预览，
									并支持浏览器内可视化编辑。
								</div>
								<button
									type="button"
									className="configmd-empty-btn"
									onClick={() => {
										void updateAgent(agentId, {
											configMd: {
												mdPath: 'config.html',
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
											console.error('[ConfigHtml] enable failed:', err);
										});
									}}
								>
									✨ 启用 ConfigHtml
								</button>
								<div className="configmd-empty-hint">
									启用后将在 Agent 目录下创建 <code>config.html</code> 文件
								</div>
							</div>
						) : (
						<>
						<div className="configmd-toolbar">
							<div className="configmd-toolbar-left">
								<span className="configmd-toolbar-label">config.html</span>
							</div>
						</div>

						{/* AI chat box ABOVE the editor: generates a full HTML
						    document via the `confightml` skill and writes it into
						    the editor below. */}
						<ConfigHtmlChatBox
							agentId={agentId}
							getCurrentHtml={() => useConfigMdStore.getState().byAgent[agentId]?.markdown ?? ''}
							onHtmlGenerated={handleHtmlGenerated}
						/>

						{/* HTML source editor — full width, no split. Preview is
						    delegated to the Canvas via the toolbar's preview button. */}
						<div className="configmd-editor-body view-source">
							<div className="configmd-source">
								<HtmlEditor
									value={configMdState?.markdown ?? ''}
									onChange={handleConfigMdChange}
									placeholder="<!DOCTYPE html> ... 在上方用 AI 生成，或直接编辑 HTML"
								/>
							</div>
						</div>
						</>
						)}
					</div>
					</TabErrorBoundary>
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
