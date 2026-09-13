/*---------------------------------------------------------------------------------------------
 *  会话回放 — 录制工具调用事件，支持时间线回放。
 *  参考 agentmemory src/functions/replay.ts
 *
 *  记录每个会话的工具调用序列，支持：
 *    - 按时间顺序浏览
 *    - 跳转到特定步骤
 *    - 过滤工具类型
 *--------------------------------------------------------------------------------------------*/

export interface ReplayEvent {
	id: string;
	timestamp: number;
	type: 'user_prompt' | 'tool_call' | 'tool_result' | 'assistant_response' | 'error' | 'session_start' | 'session_end';
	toolName?: string;
	toolArgs?: string;
	content: string;
	durationMs?: number;
	success?: boolean;
}

export interface ReplaySession {
	sessionId: string;
	agentId: string;
	startedAt: number;
	endedAt?: number;
	events: ReplayEvent[];
	totalDurationMs?: number;
}

const MAX_EVENTS_PER_SESSION = 500;

export class ReplayRecorder {
	private _sessions = new Map<string, ReplaySession>();

	/** Start recording a new session */
	startSession(agentId: string, sessionId: string): void {
		this._sessions.set(sessionId, {
			sessionId,
			agentId,
			startedAt: Date.now(),
			events: [],
		});
	}

	/** Record an event in a session */
	recordEvent(sessionId: string, event: Omit<ReplayEvent, 'id' | 'timestamp'>): void {
		const session = this._sessions.get(sessionId);
		if (!session) return;

		const fullEvent: ReplayEvent = {
			...event,
			id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timestamp: Date.now(),
		};
		session.events.push(fullEvent);

		// Cap to prevent unbounded growth
		while (session.events.length > MAX_EVENTS_PER_SESSION) {
			session.events.shift();
		}
	}

	/** End a session */
	endSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) return;
		session.endedAt = Date.now();
		session.totalDurationMs = session.endedAt - session.startedAt;
	}

	/** Get a session for replay */
	getSession(sessionId: string): ReplaySession | null {
		return this._sessions.get(sessionId) ?? null;
	}

	/** Get all sessions for an agent */
	getSessions(agentId: string): ReplaySession[] {
		return Array.from(this._sessions.values())
			.filter(s => s.agentId === agentId)
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Replay events filtered by type */
	filterEvents(sessionId: string, type?: ReplayEvent['type']): ReplayEvent[] {
		const session = this._sessions.get(sessionId);
		if (!session) return [];
		if (!type) return session.events;
		return session.events.filter(e => e.type === type);
	}

	/** Get a summary of tool usage in a session */
	getToolSummary(sessionId: string): Array<{ toolName: string; count: number; avgDurationMs: number; successRate: number }> {
		const session = this._sessions.get(sessionId);
		if (!session) return [];
		const toolStats = new Map<string, { count: number; totalMs: number; successes: number }>();

		for (const event of session.events) {
			if (event.type !== 'tool_call' || !event.toolName) continue;
			const stat = toolStats.get(event.toolName) ?? { count: 0, totalMs: 0, successes: 0 };
			stat.count++;
			if (event.durationMs) stat.totalMs += event.durationMs;
			if (event.success !== false) stat.successes++;
			toolStats.set(event.toolName, stat);
		}

		return Array.from(toolStats.entries())
			.map(([toolName, stat]) => ({
				toolName,
				count: stat.count,
				avgDurationMs: stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,
				successRate: stat.count > 0 ? stat.successes / stat.count : 0,
			}))
			.sort((a, b) => b.count - a.count);
	}

	/** Clear sessions for an agent */
	clearAgent(agentId: string): void {
		for (const [id, session] of this._sessions) {
			if (session.agentId === agentId) {
				this._sessions.delete(id);
			}
		}
	}

	get sessionCount(): number { return this._sessions.size; }
}
