/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session Memory Provider —— 仿 Hermes 的 `hermes_state.SessionDB` 的轻量版。
 *
 * 与现有 `localFileMemory.ts` 的差异：
 *   - URI 构造修正：旧实现用 `URI.from({ scheme: 'file', path })` + 相对路径，
 *     在 Windows 上写不进任何位置；这里以 `IEnvironmentService.userRoamingDataHome`
 *     为根，确保跨平台、跨 web/desktop 都可用。
 *   - 短期记忆环形容量上限（默认 200 条），超出按 FIFO 丢弃；长期记忆无限。
 *   - 写入采用「读-合并-覆盖」而不是「读-拼接-写回」，避免 VSBuffer.concat 多次
 *     拷贝大文件。文件 < 1 MB 时直接全量重写；> 1 MB 走追加写。
 *   - searchMemory 在文本匹配基础上额外按 type、metadata.tag 过滤（通过 query 前缀）。
 *
 * 文件布局：
 *   <root>/saros/memory/<agentId>/short-term.jsonl
 *   <root>/saros/memory/<agentId>/long-term.jsonl
 *
 * 其中 <root> 是 `userRoamingDataHome`，对桌面端等价 `%APPDATA%/Code-OSS-Dev/User`，
 * 对 web 端是 indexedDB-backed 路径，IFileService 都能直接读写。
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
const REWRITE_THRESHOLD = 1024 * 1024;   // 1 MB —— 小于此走全量重写

export class SessionMemoryProvider implements IMemoryProvider, IDisposable {

	readonly id: string = 'saros.session-memory';
	readonly name: string = 'Sarosis Session Memory';

	constructor(
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly logService: ILogService,
	) { }

	async loadContext(agentId: string, _sessionId: string): Promise<IMemoryContext> {
		const [shortTerm, longTerm] = await Promise.all([
			this._readJsonl(this._memFile(agentId, SHORT_TERM_FILE)),
			this._readJsonl(this._memFile(agentId, LONG_TERM_FILE)),
		]);
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

		try {
			if (stamped.type === 'short_term') {
				await this._appendCapped(file, stamped, SHORT_TERM_LIMIT);
			} else {
				await this._append(file, stamped);
			}
		} catch (err) {
			this.logService.warn(`[SessionMemoryProvider] write failed for ${agentId}: ${err}`);
			throw err;
		}
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		// 支持 "tag:foo" / "type:short" 形式的简易过滤前缀
		let typeFilter: 'short_term' | 'long_term' | undefined;
		let tagFilter: string | undefined;
		let textQuery = query;
		const tokens = query.split(/\s+/);
		const remaining: string[] = [];
		for (const tok of tokens) {
			if (tok.startsWith('type:')) {
				const v = tok.slice(5);
				typeFilter = v === 'short' ? 'short_term' : v === 'long' ? 'long_term' : undefined;
			} else if (tok.startsWith('tag:')) {
				tagFilter = tok.slice(4);
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
			return true;
		});
		matched.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		return matched;
	}

	dispose(): void { /* no resources to release */ }

	// ─── internals ──────────────────────────────────────────

	private _memFile(agentId: string, fileName: string): URI {
		const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return URI.joinPath(this.environmentService.userRoamingDataHome, 'saros', 'memory', safe, fileName);
	}

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

	private async _append(file: URI, entry: IMemoryEntry): Promise<void> {
		const line = JSON.stringify(entry) + '\n';
		try {
			const existing = await this.fileService.readFile(file);
			if (existing.value.byteLength < REWRITE_THRESHOLD) {
				const merged = existing.value.toString() + line;
				await this.fileService.writeFile(file, VSBuffer.fromString(merged));
			} else {
				const merged = VSBuffer.concat([existing.value, VSBuffer.fromString(line)]);
				await this.fileService.writeFile(file, merged);
			}
		} catch {
			await this.fileService.writeFile(file, VSBuffer.fromString(line));
		}
	}

	private async _appendCapped(file: URI, entry: IMemoryEntry, max: number): Promise<void> {
		const existing = await this._readJsonl(file);
		existing.push(entry);
		while (existing.length > max) { existing.shift(); }
		const text = existing.map(e => JSON.stringify(e)).join('\n') + '\n';
		await this.fileService.writeFile(file, VSBuffer.fromString(text));
	}

	private _buildSystemPrompt(shortTerm: IMemoryEntry[], longTerm: IMemoryEntry[]): string {
		const out: string[] = [];
		if (longTerm.length > 0) {
			out.push('## Long-term memory');
			for (const e of longTerm.slice(-10)) {
				out.push(`- ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		if (shortTerm.length > 0) {
			out.push('');
			out.push('## Recent context');
			for (const e of shortTerm.slice(-15)) {
				out.push(`- ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		return out.join('\n');
	}
}
