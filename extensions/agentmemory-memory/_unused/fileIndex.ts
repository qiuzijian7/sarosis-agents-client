/*---------------------------------------------------------------------------------------------
 *  文件索引 — 追踪文件访问模式（读/写/修改）。
 *  参考 agentmemory src/functions/file-index.ts
 *
 *  记录每个文件的访问历史，用于：
 *    - 识别热点文件（频繁修改）
 *    - 追踪文件变更时间线
 *    - 为项目画像提供数据
 *--------------------------------------------------------------------------------------------*/

export interface FileRecord {
	path: string;
	readCount: number;
	writeCount: number;
	modifyCount: number;
	firstAccessed: number;
	lastAccessed: number;
	relatedMemoryIds: string[];
	errorCount: number;
}

export type FileAccessMode = 'read' | 'write' | 'modify';

export class FileIndex {
	private _files = new Map<string, FileRecord>();
	private _agentFiles = new Map<string, Set<string>>();

	/** Record a file access */
	record(agentId: string, filePath: string, mode: FileAccessMode, memoryId?: string, hasError?: boolean): void {
		const normalized = filePath.replace(/\\/g, '/');
		let record = this._files.get(normalized);

		if (!record) {
			record = {
				path: normalized,
				readCount: 0,
				writeCount: 0,
				modifyCount: 0,
				firstAccessed: Date.now(),
				lastAccessed: Date.now(),
				relatedMemoryIds: [],
				errorCount: 0,
			};
			this._files.set(normalized, record);
		}

		record.lastAccessed = Date.now();
		switch (mode) {
			case 'read': record.readCount++; break;
			case 'write': record.writeCount++; break;
			case 'modify': record.modifyCount++; break;
		}
		if (memoryId && !record.relatedMemoryIds.includes(memoryId)) {
			record.relatedMemoryIds.push(memoryId);
		}
		if (hasError) record.errorCount++;

		// Track per-agent
		const agentSet = this._agentFiles.get(agentId) ?? new Set<string>();
		agentSet.add(normalized);
		this._agentFiles.set(agentId, agentSet);
	}

	/** Get file record */
	get(filePath: string): FileRecord | null {
		return this._files.get(filePath.replace(/\\/g, '/')) ?? null;
	}

	/** Get all files for an agent */
	getAgentFiles(agentId: string): FileRecord[] {
		const paths = this._agentFiles.get(agentId);
		if (!paths) return [];
		return Array.from(paths)
			.map(p => this._files.get(p)!)
			.filter(Boolean)
			.sort((a, b) => (b.readCount + b.writeCount + b.modifyCount) - (a.readCount + a.writeCount + a.modifyCount));
	}

	/** Get hot files (most accessed) */
	getHotFiles(agentId: string, limit: number = 10): FileRecord[] {
		return this.getAgentFiles(agentId).slice(0, limit);
	}

	/** Get files with errors */
	getErrorFiles(agentId: string): FileRecord[] {
		return this.getAgentFiles(agentId).filter(f => f.errorCount > 0);
	}

	/** Get recently modified files */
	getRecentFiles(agentId: string, hours: number = 24): FileRecord[] {
		const cutoff = Date.now() - hours * 60 * 60 * 1000;
		return this.getAgentFiles(agentId)
			.filter(f => f.lastAccessed > cutoff)
			.sort((a, b) => b.lastAccessed - a.lastAccessed);
	}

	/** Get statistics */
	getStats(agentId: string): {
		totalFiles: number;
		totalReads: number;
		totalWrites: number;
		totalModifies: number;
		totalErrors: number;
		hotFiles: Array<{ path: string; accesses: number }>;
	} {
		const files = this.getAgentFiles(agentId);
		let totalReads = 0, totalWrites = 0, totalModifies = 0, totalErrors = 0;
		for (const f of files) {
			totalReads += f.readCount;
			totalWrites += f.writeCount;
			totalModifies += f.modifyCount;
			totalErrors += f.errorCount;
		}
		return {
			totalFiles: files.length,
			totalReads,
			totalWrites,
			totalModifies,
			totalErrors,
			hotFiles: files.slice(0, 5).map(f => ({ path: f.path, accesses: f.readCount + f.writeCount + f.modifyCount })),
		};
	}

	clear(agentId: string): void {
		const paths = this._agentFiles.get(agentId);
		if (paths) {
			for (const p of paths) this._files.delete(p);
		}
		this._agentFiles.delete(agentId);
	}
}
