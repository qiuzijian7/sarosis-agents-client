/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session Memory Provider —— 基于 Agent 的全局记忆系统。
 *
 * 设计原则：
 *   - 记忆完全基于 agentId 管理，不依赖工作区。同一个 agent 在不同工作区
 *     中共享同一份记忆，实现跨工作区的记忆延续。
 *   - 以 `IEnvironmentService.userRoamingDataHome` 为根，确保跨平台、跨
 *     web/desktop 都可用。
 *   - 短期记忆环形容量上限（默认 200 条），超出按 FIFO 丢弃；长期记忆无限。
 *   - 原子写入：使用临时文件 + 原子重命名（参考 Hermes memory_tool.py），
 *     确保写入安全性和一致性。
 *   - 文件锁：使用锁定文件机制（.lock），防止并发写入冲突。
 *   - 会话级缓存：同一会话内缓存记忆数据，避免重复读取。
 *   - searchMemory 在文本匹配基础上额外按 type、metadata.tag 过滤（通过 query 前缀）。
 *
 * 文件布局（全局，基于 agentId，跨工作区共享）：
 *   <userRoamingDataHome>/.saros/memory/<agentId>/short-term.jsonl
 *   <userRoamingDataHome>/.saros/memory/<agentId>/long-term.jsonl
 *
 * 其中 <root> 是 `userRoamingDataHome`，对桌面端等价 `%APPDATA%/Code-OSS-Dev/User`，
 * 对 web 端是 indexedDB-backed 路径，IFileService 都能直接读写。
 *
 * 原子写入流程（参考 Hermes）：
 *   1. 在同一目录创建临时文件（.tmp 后缀）
 *   2. 写入数据
 *   3. 原子重命名（move）到目标文件
 *   4. 如果失败，清理临时文件
 */

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IMemoryProvider, IMemoryContext, IMemoryEntry } from '../../../common/providers.js';

const SHORT_TERM_FILE = 'short-term.jsonl';
const LONG_TERM_FILE = 'long-term.jsonl';
const SHORT_TERM_LIMIT = 200;            // 短期记忆条数上限
const CACHE_TTL = 5 * 60 * 1000;       // 会话缓存 TTL（5 分钟）

export class SessionMemoryProvider implements IMemoryProvider, IDisposable {

	readonly id: string = 'saros.session-memory';
	readonly name: string = 'Saros Session Memory';

	/** 会话级缓存：agentId:sessionId → { shortTerm, longTerm, timestamp } */
	private readonly _cache = new Map<string, { shortTerm: IMemoryEntry[]; longTerm: IMemoryEntry[]; timestamp: number }>();

	/** 正在进行的锁获取 Promise，防止重复获取同一把锁 */
	private readonly _lockPromises = new Map<string, Promise<void>>();

	constructor(
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly logService: ILogService,
	) { }

	// ─── public API ────────────────────────────────────────

	async loadContext(agentId: string, sessionId: string): Promise<IMemoryContext> {
		const cacheKey = `${agentId}:${sessionId}`;
		const cached = this._cache.get(cacheKey);
		if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
			this.logService.debug(`[SessionMemoryProvider] cache hit: ${cacheKey}`);
			return {
				shortTermMemories: cached.shortTerm,
				longTermMemories: cached.longTerm,
				systemPrompt: this._buildSystemPrompt(cached.shortTerm, cached.longTerm),
			};
		}

		const [shortTerm, longTerm] = await Promise.all([
			this._readJsonl(this._memFile(agentId, SHORT_TERM_FILE)),
			this._readJsonl(this._memFile(agentId, LONG_TERM_FILE)),
		]);

		this._cache.set(cacheKey, { shortTerm, longTerm, timestamp: Date.now() });

		return {
			shortTermMemories: shortTerm,
			longTermMemories: longTerm,
			systemPrompt: this._buildSystemPrompt(shortTerm, longTerm),
		};
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		const file = this._memFile(agentId, entry.type === 'short_term' ? SHORT_TERM_FILE : LONG_TERM_FILE);
		const stamped: IMemoryEntry = { ...entry, timestamp: entry.timestamp ?? Date.now() };

		try {
			await this.fileService.createFolder(URI.joinPath(file, '..'));
		} catch { /* may already exist */ }

		const lockKey = this._lockKey(agentId);
		await this._acquireLock(lockKey);
		try {
			if (stamped.type === 'short_term') {
				await this._writeCappedAtomic(file, stamped, SHORT_TERM_LIMIT);
			} else {
				await this._atomicWrite(file, stamped);
			}
			this._invalidateCache(agentId);
		} catch (err) {
			this.logService.warn(`[SessionMemoryProvider] write failed for ${agentId}: ${err}`);
			throw err;
		} finally {
			await this._releaseLock(lockKey);
		}
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		let typeFilter: 'short_term' | 'long_term' | undefined;
		let tagFilter: string | undefined;
		let timeAfter: number | undefined;
		let timeBefore: number | undefined;
		let textQuery = query;
		const tokens = query.split(/\s+/);
		const remaining: string[] = [];
		for (const tok of tokens) {
			if (tok.startsWith('type:')) {
				const v = tok.slice(5);
				typeFilter = v === 'short' ? 'short_term' : v === 'long' ? 'long_term' : undefined;
			} else if (tok.startsWith('tag:')) {
				tagFilter = tok.slice(4);
			} else if (tok.startsWith('after:')) {
				const dateStr = tok.slice(6);
				const ts = this._parseDate(dateStr);
				if (ts) { timeAfter = ts; }
			} else if (tok.startsWith('before:')) {
				const dateStr = tok.slice(7);
				const ts = this._parseDate(dateStr);
				if (ts) { timeBefore = ts; }
			} else if (tok.startsWith('recent:')) {
				const val = tok.slice(7);
				const match = val.match(/^(\d+)([dh])$/);  // e.g., 7d, 24h
				if (match) {
					const num = parseInt(match[1], 10);
					const unit = match[2];
					const ms = unit === 'd' ? num * 24 * 60 * 60 * 1000 : num * 60 * 60 * 1000;
					timeAfter = Date.now() - ms;
				}
			} else {
				remaining.push(tok);
			}
		}
		textQuery = remaining.join(' ').trim().toLowerCase();

		const [shortTerm, longTerm] = await Promise.all([
			typeFilter === 'long_term' ? Promise.resolve([] as IMemoryEntry[]) : this._readJsonl(this._memFile(agentId, SHORT_TERM_FILE)),
			typeFilter === 'short_term' ? Promise.resolve([] as IMemoryEntry[]) : this._readJsonl(this._memFile(agentId, LONG_TERM_FILE)),
		]);
		const all = [...shortTerm, ...longTerm];
		const matched = all.filter(e => {
			if (textQuery && !e.content.toLowerCase().includes(textQuery)) { return false; }
			if (tagFilter) {
				const tags = (e.metadata?.['tags'] as string[] | undefined) ?? [];
				if (!Array.isArray(tags) || !tags.includes(tagFilter)) { return false; }
			}
			if (timeAfter && (e.timestamp ?? 0) < timeAfter) { return false; }
			if (timeBefore && (e.timestamp ?? 0) > timeBefore) { return false; }
			return true;
		});
		matched.sort((a, b) => {
			// 先按重要性降序（无重要性字段的默认5）
			const impA = a.importance ?? 5;
			const impB = b.importance ?? 5;
			if (impB !== impA) {
				return impB - impA;
			}
			// 重要性相同时按时间降序（更新的在前）
			return (b.timestamp ?? 0) - (a.timestamp ?? 0);
		});
		return matched;
	}

	/** 解析日期字符串，支持 YYYY-MM-DD 或时间戳数字（毫秒） */
	private _parseDate(str: string): number | undefined {
		// 尝试直接解析为时间戳数字
		if (/^\d+$/.test(str)) {
			const ts = parseInt(str, 10);
			return ts;
		}
		// 尝试解析为日期字符串
		const date = new Date(str);
		if (!isNaN(date.getTime())) {
			return date.getTime();
		}
		return undefined;
	}

	dispose(): void {
		this._cache.clear();
		this._lockPromises.clear();
	}

	// ─── internals ──────────────────────────────────────────

	private _memFile(agentId: string, fileName: string): URI {
		const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return URI.joinPath(this.environmentService.userRoamingDataHome, '.saros', 'memory', safe, fileName);
	}

	private _lockKey(agentId: string): string {
		const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return URI.joinPath(this.environmentService.userRoamingDataHome, '.saros', 'memory', safe, '.lock').toString();
	}

	/** 使指定 agentId 的所有会话缓存失效 */
	private _invalidateCache(agentId: string): void {
		for (const key of this._cache.keys()) {
			if (key.startsWith(`${agentId}:`)) {
				this._cache.delete(key);
			}
		}
	}

	// ── 文件锁（基于 .lock 文件，参考 Hermes memory_tool.py）───

	private async _acquireLock(lockKey: string): Promise<void> {
		if (this._lockPromises.has(lockKey)) {
			await this._lockPromises.get(lockKey);
			return;
		}

		const promise = this._doAcquireLock(lockKey);
		this._lockPromises.set(lockKey, promise);
		try {
			await promise;
		} finally {
			this._lockPromises.delete(lockKey);
		}
	}

	private async _doAcquireLock(lockKey: string, retries = 50): Promise<void> {
		const lockUri = URI.parse(lockKey);
		for (let i = 0; i < retries; i++) {
			try {
				await this.fileService.createFile(lockUri, VSBuffer.fromString(String(Date.now())), { overwrite: false });
				return;
			} catch {
				// 锁文件已存在，等待后重试
				await new Promise(r => setTimeout(r, 100));
			}
		}
		this.logService.warn(`[SessionMemoryProvider] lock timeout: ${lockKey}`);
		throw new Error(`Failed to acquire lock: ${lockKey}`);
	}

	private async _releaseLock(lockKey: string): Promise<void> {
		try {
			const lockUri = URI.parse(lockKey);
			await this.fileService.del(lockUri);
		} catch {
			// 锁文件可能已被清理，忽略错误
		}
	}

	// ── 原子写入（参考 Hermes memory_tool.py 的原子重命名机制）───

	/** 原子追加写入（文件不存在时创建，存在时追加） */
	private async _atomicWrite(file: URI, entry: IMemoryEntry): Promise<void> {
		const line = JSON.stringify(entry) + '\n';
		let existingContent = '';
		try {
			const buf = await this.fileService.readFile(file);
			existingContent = buf.value.toString();
		} catch { /* 文件不存在 */ }

		const newContent = existingContent + line;
		await this._writeAtomicCore(file, VSBuffer.fromString(newContent));
	}

	/** 原子写入并限制条数（短期记忆环形缓冲） */
	private async _writeCappedAtomic(file: URI, entry: IMemoryEntry, max: number): Promise<void> {
		const existing = await this._readJsonl(file);
		existing.push(entry);
		while (existing.length > max) { existing.shift(); }
		const text = existing.map(e => JSON.stringify(e)).join('\n') + '\n';
		await this._writeAtomicCore(file, VSBuffer.fromString(text));
	}

	/** 原子写入核心：临时文件 + move 原子重命名 */
	private async _writeAtomicCore(target: URI, content: VSBuffer): Promise<void> {
		const tmpFile = URI.joinPath(target, '..', `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			await this.fileService.writeFile(tmpFile, content);
			await this.fileService.move(tmpFile, target, true);
		} catch (err) {
			try { await this.fileService.del(tmpFile); } catch { /* ignore cleanup failure */ }
			throw err;
		}
	}

	// ── 读取 ────────────────────────────────────────────────

	private async _readJsonl(file: URI): Promise<IMemoryEntry[]> {
		try {
			const buf = await this.fileService.readFile(file);
			const text = buf.value.toString();
			const out: IMemoryEntry[] = [];
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line) { continue; }
				try { out.push(JSON.parse(line) as IMemoryEntry); } catch { /* skip malformed */ }
			}
			return out;
		} catch {
			return [];
		}
	}

	// ── 系统提示构建 ────────────────────────────────────────

	private _buildSystemPrompt(shortTerm: IMemoryEntry[], longTerm: IMemoryEntry[]): string {
		const out: string[] = [];
		if (longTerm.length > 0) {
			out.push('## Long-term memory');
			for (const e of longTerm.slice(-10)) {
				const importanceStr = e.importance ? ` [重要性:${e.importance}/10]` : '';
				out.push(`- ${importanceStr} ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		if (shortTerm.length > 0) {
			out.push('');
			out.push('## Recent context');
			for (const e of shortTerm.slice(-15)) {
				const importanceStr = e.importance ? ` [重要性:${e.importance}/10]` : '';
				out.push(`- ${importanceStr} ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		return out.join('\n');
	}
}
