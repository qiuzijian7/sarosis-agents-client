/*---------------------------------------------------------------------------------------------
 *  会话摘要 — 生成会话级别的结构化摘要。
 *  参考 agentmemory src/functions/summarize.ts
 *
 *  与 ConsolidationPipeline（Episodic）的区别：
 *    - Consolidation Episodic：从短期记忆观察中提取事件序列
 *    - Summarize：生成会话级别的叙述性摘要（可读性更强）
 *
 *  核心能力：
 *    1. summarize(session) — 从消息流生成结构化摘要
 *    2. extractDecisions(messages) — 提取决策点
 *    3. extractTopics(messages) — 提取主题
 *    4. compress(summary) — 压缩摘要
 *
 *  摘要结构：
 *    - title: 简短标题
 *    - narrative: 叙述性描述
 *    - keyDecisions: 关键决策列表
 *    - topics: 主题列表
 *    - filesModified: 影响文件
 *    - toolsUsed: 使用的工具
 *    - durationMs: 会话时长
 *--------------------------------------------------------------------------------------------*/

export interface SessionMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	timestamp: number;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: unknown;
}

export interface SessionSummary {
	id: string;
	sessionId: string;
	title: string;
	narrative: string;
	keyDecisions: string[];
	topics: string[];
	filesModified: string[];
	toolsUsed: string[];
	metrics: {
		messageCount: number;
		toolCallCount: number;
		errorCount: number;
		durationMs: number;
	};
	createdAt: string;
}

const DECISION_KEYWORDS = /\b(?:decided|chose|should|must|will use|adopted|prefer|recommend|avoid|deprecated|switched|migrated|refactored)\b/gi;
const TOPIC_KEYWORDS = /\b(?:auth|database|cache|api|middleware|router|component|service|module|config|test|deploy|docker|kubernetes|redis|postgres|graphql|rest|websocket|error|retry|timeout|build|compile|webpack|vite)\b/gi;
const FILE_PATTERN = /(?:src\/|test\/|lib\/|app\/|extensions\/|packages\/)?[\w-]+\/[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|jsx|tsx|vue|css|html|yml|yaml|sh|mjs)/g;

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractDecisions(messages: SessionMessage[]): string[] {
	const decisions: string[] = [];
	const seen = new Set<string>();

	for (const msg of messages) {
		if (msg.role !== 'assistant' && msg.role !== 'user') continue;
		const sentences = msg.content.split(/[.。\n]/);
		for (const s of sentences) {
			if (DECISION_KEYWORDS.test(s) && s.trim().length > 10) {
				const trimmed = s.trim().slice(0, 200);
				const key = trimmed.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					decisions.push(trimmed);
				}
			}
		}
	}

	return decisions.slice(0, 10);
}

function extractTopics(messages: SessionMessage[]): string[] {
	const topics = new Set<string>();
	for (const msg of messages) {
		const matches = msg.content.matchAll(TOPIC_KEYWORDS);
		for (const m of matches) {
			topics.add(m[0].toLowerCase());
		}
	}
	return Array.from(topics).slice(0, 15);
}

function extractFilesModified(messages: SessionMessage[]): string[] {
	const files = new Set<string>();
	for (const msg of messages) {
		// 从消息内容
		const matches = msg.content.matchAll(FILE_PATTERN);
		for (const m of matches) {
			files.add(m[0]);
		}
		// 从工具参数
		if (msg.toolArgs) {
			const path = msg.toolArgs['path'] ?? msg.toolArgs['filePath'] ?? msg.toolArgs['file'];
			if (typeof path === 'string') {
				files.add(path);
			}
		}
	}
	return Array.from(files).slice(0, 30);
}

function extractToolsUsed(messages: SessionMessage[]): string[] {
	const tools = new Map<string, number>();
	for (const msg of messages) {
		if (msg.role === 'tool' && msg.toolName) {
			tools.set(msg.toolName, (tools.get(msg.toolName) ?? 0) + 1);
		}
	}
	return Array.from(tools.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([name]) => name);
}

function buildNarrative(messages: SessionMessage[], metrics: SessionSummary['metrics']): string {
	const lines: string[] = [];

	// 用户意图（第一条 user 消息）
	const firstUser = messages.find(m => m.role === 'user');
	if (firstUser) {
		lines.push(`用户请求: ${firstUser.content.slice(0, 200)}`);
	}

	// 工具使用
	if (metrics.toolCallCount > 0) {
		lines.push(`执行了 ${metrics.toolCallCount} 次工具调用，使用 ${new Set(messages.filter(m => m.toolName).map(m => m.toolName!)).size} 种不同工具。`);
	}

	// 错误
	if (metrics.errorCount > 0) {
		lines.push(`遇到 ${metrics.errorCount} 次错误。`);
	}

	// 最终结果（最后一条 assistant 消息）
	const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
	if (lastAssistant) {
		lines.push(`最终结果: ${lastAssistant.content.slice(0, 300)}`);
	}

	// 时长
	if (metrics.durationMs > 0) {
		const minutes = Math.round(metrics.durationMs / 60000);
		lines.push(`会话时长: ${minutes} 分钟。`);
	}

	return lines.join('\n');
}

function generateTitle(messages: SessionMessage[]): string {
	const firstUser = messages.find(m => m.role === 'user');
	if (firstUser) {
		const content = firstUser.content.slice(0, 80);
		// 取第一行或前 80 字符
		const firstLine = content.split('\n')[0];
		return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
	}
	return `Session ${new Date().toISOString().slice(0, 10)}`;
}

export class SessionSummarizer {
	private _summaries = new Map<string, SessionSummary[]>();
	private _maxPerSession = 50;

	/**
	 * 生成会话摘要
	 */
	summarize(sessionId: string, messages: SessionMessage[]): SessionSummary | null {
		if (!messages || messages.length === 0) {
			return null;
		}

		const timestamps = messages.map(m => m.timestamp).filter(t => t > 0);
		const firstTs = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
		const lastTs = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
		const durationMs = lastTs - firstTs;

		const toolCallCount = messages.filter(m => m.role === 'tool').length;
		const errorCount = messages.filter(m =>
			m.role === 'tool' && typeof m.toolResult === 'string' && /error|fail|exception/i.test(m.toolResult),
		).length;

		const summary: SessionSummary = {
			id: generateId('sum'),
			sessionId,
			title: generateTitle(messages),
			narrative: buildNarrative(messages, {
				messageCount: messages.length,
				toolCallCount,
				errorCount,
				durationMs,
			}),
			keyDecisions: extractDecisions(messages),
			topics: extractTopics(messages),
			filesModified: extractFilesModified(messages),
			toolsUsed: extractToolsUsed(messages),
			metrics: {
				messageCount: messages.length,
				toolCallCount,
				errorCount,
				durationMs,
			},
			createdAt: new Date().toISOString(),
		};

		// 存储
		let list = this._summaries.get(sessionId);
		if (!list) {
			list = [];
			this._summaries.set(sessionId, list);
		}
		list.push(summary);
		if (list.length > this._maxPerSession) {
			list.shift();
		}

		return summary;
	}

	/**
	 * 获取会话摘要列表
	 */
	getBySession(sessionId: string): SessionSummary[] {
		return this._summaries.get(sessionId) ?? [];
	}

	/**
	 * 获取最新摘要
	 */
	getLatest(sessionId: string): SessionSummary | null {
		const list = this._summaries.get(sessionId);
		if (!list || list.length === 0) return null;
		return list[list.length - 1];
	}

	/**
	 * 搜索摘要
	 */
	search(query: string, limit: number = 10): SessionSummary[] {
		const lower = query.toLowerCase();
		const results: Array<{ summary: SessionSummary; score: number }> = [];

		for (const list of this._summaries.values()) {
			for (const summary of list) {
				let score = 0;
				if (summary.title.toLowerCase().includes(lower)) score += 3;
				if (summary.narrative.toLowerCase().includes(lower)) score += 2;
				for (const topic of summary.topics) {
					if (topic.includes(lower)) score += 2;
				}
				for (const decision of summary.keyDecisions) {
					if (decision.toLowerCase().includes(lower)) score += 1;
				}
				if (score > 0) {
					results.push({ summary, score });
				}
			}
		}

		return results
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(r => r.summary);
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalSessions: number; totalSummaries: number; avgMessagesPerSummary: number } {
		let totalSummaries = 0;
		let totalMessages = 0;
		for (const list of this._summaries.values()) {
			totalSummaries += list.length;
			totalMessages += list.reduce((sum, s) => sum + s.metrics.messageCount, 0);
		}
		return {
			totalSessions: this._summaries.size,
			totalSummaries,
			avgMessagesPerSummary: totalSummaries > 0 ? Math.round(totalMessages / totalSummaries) : 0,
		};
	}

	/**
	 * 清除会话摘要
	 */
	clearSession(sessionId: string): boolean {
		return this._summaries.delete(sessionId);
	}

	/**
	 * 获取最近 N 条会话摘要（跨 session，按 createdAt 降序）
	 * 对齐 agentmemory context.ts 中注入最近 10 个 session summary 的行为。
	 */
	getRecent(limit: number = 10): SessionSummary[] {
		const all: SessionSummary[] = [];
		for (const list of this._summaries.values()) {
			all.push(...list);
		}
		return all
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._summaries.clear();
	}
}
