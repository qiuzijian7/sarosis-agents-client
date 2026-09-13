/*---------------------------------------------------------------------------------------------
 *  会话回放 + Diff — 记录会话事件序列并支持回放对比。
 *
 *  与现有 ReplayRecorder 的区别：
 *    - ReplayRecorder：记录工具调用事件（user_prompt/tool_call/tool_result/error）
 *    - SessionReplay：完整会话回放 + 两个会话之间的 diff 对比
 *
 *  核心能力：
 *    1. record(sessionId, event) — 记录事件
 *    2. replay(sessionId) — 获取完整回放序列
 *    3. compare(sessionA, sessionB) — 对比两个会话
 *    4. getTimeline(sessionId) — 时间线视图
 *    5. exportReplay(sessionId) — 导出回放数据
 *--------------------------------------------------------------------------------------------*/

export interface ReplayEvent {
	id: string;
	sessionId: string;
	type: 'user_prompt' | 'assistant_response' | 'tool_call' | 'tool_result' | 'tool_error' | 'memory_write' | 'memory_search' | 'session_start' | 'session_end' | 'custom';
	timestamp: number;
	content: string;
	toolName?: string;
	metadata?: Record<string, unknown>;
}

export interface SessionDiff {
	sessionA: string;
	sessionB: string;
	sharedEvents: number;
	uniqueToA: number;
	uniqueToB: number;
	commonToolSequence: string[];
	divergencePoint?: { sessionA: ReplayEvent; sessionB: ReplayEvent };
	similarity: number;
}

export interface SessionTimeline {
	sessionId: string;
	totalEvents: number;
	startTime: number;
	endTime: number;
	durationMs: number;
	byType: Record<string, number>;
	events: Array<{ event: ReplayEvent; relativeTime: number }>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_EVENTS_PER_SESSION = 1000;
const MAX_SESSIONS = 50;

export class SessionReplayManager {
	private _events = new Map<string, ReplayEvent[]>();
	private _sessions = new Map<string, { startTime: number; endTime: number }>();

	/**
	 * 记录事件
	 */
	record(event: Omit<ReplayEvent, 'id'>): ReplayEvent {
		let events = this._events.get(event.sessionId);
		if (!events) {
			events = [];
			this._events.set(event.sessionId, events);
			this._sessions.set(event.sessionId, { startTime: event.timestamp, endTime: event.timestamp });
		}

		const fullEvent: ReplayEvent = { ...event, id: generateId('replay') };
		events.push(fullEvent);

		// 更新会话时间范围
		const session = this._sessions.get(event.sessionId)!;
		if (event.timestamp < session.startTime) session.startTime = event.timestamp;
		if (event.timestamp > session.endTime) session.endTime = event.timestamp;

		// 限制事件数
		if (events.length > MAX_EVENTS_PER_SESSION) {
			events.shift();
		}

		// 限制会话数
		if (this._events.size > MAX_SESSIONS) {
			const oldest = Array.from(this._sessions.entries())
				.sort((a, b) => a[1].startTime - b[1].startTime)[0];
			if (oldest) {
				this._events.delete(oldest[0]);
				this._sessions.delete(oldest[0]);
			}
		}

		return fullEvent;
	}

	/**
	 * 回放会话
	 */
	replay(sessionId: string): ReplayEvent[] {
		return this._events.get(sessionId) ?? [];
	}

	/**
	 * 获取时间线
	 */
	getTimeline(sessionId: string): SessionTimeline | null {
		const events = this._events.get(sessionId);
		const session = this._sessions.get(sessionId);
		if (!events || !session) return null;

		const byType: Record<string, number> = {};
		for (const e of events) {
			byType[e.type] = (byType[e.type] ?? 0) + 1;
		}

		const durationMs = session.endTime - session.startTime;

		return {
			sessionId,
			totalEvents: events.length,
			startTime: session.startTime,
			endTime: session.endTime,
			durationMs,
			byType,
			events: events.map(e => ({
				event: e,
				relativeTime: durationMs > 0 ? (e.timestamp - session.startTime) / durationMs : 0,
			})),
		};
	}

	/**
	 * 对比两个会话
	 */
	compare(sessionA: string, sessionB: string): SessionDiff | null {
		const eventsA = this._events.get(sessionA);
		const eventsB = this._events.get(sessionB);
		if (!eventsA || !eventsB) return null;

		// 提取工具调用序列
		const toolsA = eventsA.filter(e => e.type === 'tool_call').map(e => e.toolName ?? 'unknown');
		const toolsB = eventsB.filter(e => e.type === 'tool_call').map(e => e.toolName ?? 'unknown');

		// 计算公共子序列
		const commonSequence = this._longestCommonSubsequence(toolsA, toolsB);

		// 找到分歧点
		let divergencePoint: SessionDiff['divergencePoint'] | undefined;
		const minLen = Math.min(eventsA.length, eventsB.length);
		for (let i = 0; i < minLen; i++) {
			if (eventsA[i].type !== eventsB[i].type || eventsA[i].content !== eventsB[i].content) {
				divergencePoint = { sessionA: eventsA[i], sessionB: eventsB[i] };
				break;
			}
		}

		const similarity = (eventsA.length + eventsB.length) > 0
			? (2 * commonSequence.length) / (toolsA.length + toolsB.length || 1)
			: 1;

		return {
			sessionA,
			sessionB,
			sharedEvents: commonSequence.length,
			uniqueToA: toolsA.length - commonSequence.length,
			uniqueToB: toolsB.length - commonSequence.length,
			commonToolSequence: commonSequence,
			divergencePoint,
			similarity: Math.round(similarity * 100) / 100,
		};
	}

	/**
	 * 导出回放数据
	 */
	exportReplay(sessionId: string): string {
		const events = this._events.get(sessionId) ?? [];
		const session = this._sessions.get(sessionId);
		return JSON.stringify({
			sessionId,
			startTime: session?.startTime,
			endTime: session?.endTime,
			eventCount: events.length,
			events,
		}, null, 2);
	}

	/**
	 * 获取所有会话列表
	 */
	listSessions(): Array<{ sessionId: string; eventCount: number; startTime: number; endTime: number }> {
		return Array.from(this._sessions.entries())
			.map(([sessionId, times]) => ({
				sessionId,
				eventCount: this._events.get(sessionId)?.length ?? 0,
				startTime: times.startTime,
				endTime: times.endTime,
			}))
			.sort((a, b) => b.startTime - a.startTime);
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalSessions: number; totalEvents: number; avgEventsPerSession: number } {
		let totalEvents = 0;
		for (const events of this._events.values()) {
			totalEvents += events.length;
		}
		return {
			totalSessions: this._events.size,
			totalEvents,
			avgEventsPerSession: this._events.size > 0 ? Math.round(totalEvents / this._events.size) : 0,
		};
	}

	/**
	 * 清除会话
	 */
	clearSession(sessionId: string): boolean {
		return this._events.delete(sessionId) || this._sessions.delete(sessionId);
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._events.clear();
		this._sessions.clear();
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private _longestCommonSubsequence(a: string[], b: string[]): string[] {
		const m = a.length;
		const n = b.length;
		const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (a[i - 1] === b[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		// 回溯
		const result: string[] = [];
		let i = m, j = n;
		while (i > 0 && j > 0) {
			if (a[i - 1] === b[j - 1]) {
				result.unshift(a[i - 1]);
				i--;
				j--;
			} else if (dp[i - 1][j] >= dp[i][j - 1]) {
				i--;
			} else {
				j--;
			}
		}

		return result;
	}
}
