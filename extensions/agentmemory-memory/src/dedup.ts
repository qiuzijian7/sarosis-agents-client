/*---------------------------------------------------------------------------------------------
 *  去重管理器 — SHA-256 内容哈希去重，5 分钟窗口。
 *  参考 agentmemory src/functions/dedup.ts
 *
 *  规则：
 *    - 对 content 计算 SHA-256 哈希
 *    - 5 分钟内相同哈希的观察直接跳过（返回 true = 重复）
 *    - 超过 5 分钟的哈希自动清理
 *--------------------------------------------------------------------------------------------*/

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Simple SHA-256 using Web Crypto API (available in renderer) */
async function sha256(text: string): Promise<string> {
	if (typeof crypto !== 'undefined' && crypto.subtle) {
		const data = new TextEncoder().encode(text);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		return Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	}
	// Fallback: simple string hash (less collision-resistant but works without Web Crypto)
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return `fallback_${Math.abs(hash).toString(16)}`;
}

interface DedupEntry {
	hash: string;
	timestamp: number;
}

export class DedupManager {
	private _entries: DedupEntry[] = [];
	private readonly _windowMs: number;

	constructor(windowMs: number = DEDUP_WINDOW_MS) {
		this._windowMs = windowMs;
	}

	/** Check if content is a duplicate within the window. Returns true if duplicate. */
	async isDuplicate(content: string): Promise<boolean> {
		const hash = await sha256(content);
		const now = Date.now();

		// Clean expired entries
		this._entries = this._entries.filter(e => now - e.timestamp < this._windowMs);

		// Check for duplicate
		const found = this._entries.find(e => e.hash === hash);
		if (found) {
			return true; // duplicate
		}

		// Add new entry
		this._entries.push({ hash, timestamp: now });
		return false;
	}

	/** Clear all entries (e.g., on session end) */
	clear(): void {
		this._entries = [];
	}

	get size(): number {
		return this._entries.length;
	}
}
