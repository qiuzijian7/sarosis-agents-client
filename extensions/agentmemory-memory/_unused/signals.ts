/*---------------------------------------------------------------------------------------------
 *  Agent 间信号 — 跨 Agent 消息传递系统。
 *  参考 agentmemory src/functions/signals.ts
 *
 *  用途：当多个 Agent 在同一 IDE 中运行时，
 *  通过信号进行异步通信（通知、请求、响应、交接）。
 *--------------------------------------------------------------------------------------------*/

export type SignalType = 'info' | 'request' | 'response' | 'alert' | 'handoff';

export interface Signal {
	id: string;
	from: string;          // sender agentId
	to?: string;            // recipient agentId (undefined = broadcast)
	threadId?: string;      // conversation thread
	replyTo?: string;       // signal ID being replied to
	type: SignalType;
	content: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
	readAt?: string;
	expiresAt?: string;
}

const MAX_SIGNALS = 200;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SignalHub {
	private _signals: Signal[] = [];
	private _byRecipient = new Map<string, Signal[]>();

	/** Send a signal */
	send(from: string, type: SignalType, content: string, opts?: {
		to?: string;
		threadId?: string;
		replyTo?: string;
		metadata?: Record<string, unknown>;
		ttlMs?: number;
	}): string {
		const id = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const now = new Date().toISOString();
		const signal: Signal = {
			id,
			from,
			to: opts?.to,
			threadId: opts?.threadId,
			replyTo: opts?.replyTo,
			type,
			content,
			metadata: opts?.metadata,
			createdAt: now,
			expiresAt: opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
		};

		this._signals.push(signal);

		// Index by recipient
		const recipient = opts?.to ?? 'broadcast';
		const arr = this._byRecipient.get(recipient) ?? [];
		arr.push(signal);
		this._byRecipient.set(recipient, arr);

		// Cap
		while (this._signals.length > MAX_SIGNALS) {
			const removed = this._signals.shift()!;
			const recipientArr = this._byRecipient.get(removed.to ?? 'broadcast');
			if (recipientArr) {
				const idx = recipientArr.indexOf(removed);
				if (idx >= 0) recipientArr.splice(idx, 1);
			}
		}

		return id;
	}

	/** Read signals for an agent (marks as read) */
	read(agentId: string, opts?: { type?: SignalType; threadId?: string; limit?: number }): Signal[] {
		const now = new Date().toISOString();
		let signals = [
			...(this._byRecipient.get(agentId) ?? []),
			...(this._byRecipient.get('broadcast') ?? []),
		];

		// Filter expired
		signals = signals.filter(s => !s.expiresAt || s.expiresAt > now);

		// Filter by type/thread
		if (opts?.type) signals = signals.filter(s => s.type === opts.type);
		if (opts?.threadId) signals = signals.filter(s => s.threadId === opts.threadId);

		// Sort by time (newest first)
		signals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

		// Limit
		const result = opts?.limit ? signals.slice(0, opts.limit) : signals;

		// Mark as read
		for (const signal of result) {
			if (!signal.readAt) {
				signal.readAt = now;
			}
		}

		return result;
	}

	/** Get unread signals count */
	getUnreadCount(agentId: string): number {
		const signals = this.read(agentId);
		return signals.filter(s => !s.readAt).length;
	}

	/** Get a signal by ID */
	get(signalId: string): Signal | null {
		return this._signals.find(s => s.id === signalId) ?? null;
	}

	/** Reply to a signal */
	reply(originalId: string, from: string, content: string, type: SignalType = 'response'): string {
		const original = this.get(originalId);
		if (!original) return '';
		return this.send(from, type, content, {
			to: original.from,
			threadId: original.threadId,
			replyTo: originalId,
		});
	}

	/** Get signal thread */
	getThread(threadId: string): Signal[] {
		return this._signals
			.filter(s => s.threadId === threadId)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	/** Clear expired signals */
	prune(): number {
		const now = new Date().toISOString();
		const before = this._signals.length;
		this._signals = this._signals.filter(s => !s.expiresAt || s.expiresAt > now);
		const pruned = before - this._signals.length;
		if (pruned > 0) {
			// Rebuild recipient index
			this._byRecipient.clear();
			for (const signal of this._signals) {
				const recipient = signal.to ?? 'broadcast';
				const arr = this._byRecipient.get(recipient) ?? [];
				arr.push(signal);
				this._byRecipient.set(recipient, arr);
			}
		}
		return pruned;
	}

	get count(): number { return this._signals.length; }

	clear(): void {
		this._signals = [];
		this._byRecipient.clear();
	}
}
