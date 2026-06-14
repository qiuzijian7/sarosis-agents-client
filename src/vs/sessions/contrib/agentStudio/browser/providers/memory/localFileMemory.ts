/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IMemoryProvider, IMemoryContext, IMemoryEntry } from '../../../common/providers.js';

const MEMORY_DIR = '.saros/agents';
const SHORT_TERM_FILE = 'short-term.jsonl';
const LONG_TERM_FILE = 'long-term.jsonl';

/**
 * 本地文件 Memory 后端
 *
 * 每个 agent 的记忆存储在：
 * - `.saros/agents/{agentId}/memory/short-term.jsonl` - 短期记忆
 * - `.saros/agents/{agentId}/memory/long-term.jsonl` - 长期记忆
 */
export class LocalFileMemory implements IMemoryProvider, IDisposable {

	readonly id: string;
	readonly name: string;

	private readonly _fileService: IFileService;
	private readonly _logService: ILogService;

	constructor(
		id: string,
		name: string,
		fileService: IFileService,
		logService: ILogService,
	) {
		this.id = id;
		this.name = name;
		this._fileService = fileService;
		this._logService = logService;
	}

	async loadContext(agentId: string, _sessionId: string): Promise<IMemoryContext> {
		const shortTerm = await this._loadEntries(agentId, SHORT_TERM_FILE);
		const longTerm = await this._loadEntries(agentId, LONG_TERM_FILE);

		return {
			shortTermMemories: shortTerm,
			longTermMemories: longTerm,
			systemPrompt: this._buildSystemPrompt(shortTerm, longTerm),
		};
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		const fileName = entry.type === 'short_term' ? SHORT_TERM_FILE : LONG_TERM_FILE;
		const filePath = this._getMemoryFilePath(agentId, fileName);

		try {
			// 确保目录存在
			const dirPath = URI.joinPath(filePath, '..');
			await this._fileService.createFolder(dirPath);

			// 追加写入（JSONL 格式）
			const line = JSON.stringify(entry) + '\n';
			const content = new TextEncoder().encode(line);
			const contentBuffer = VSBuffer.wrap(content);

			try {
				// 尝试读取现有文件
				const existing = await this._fileService.readFile(filePath);
				const existingBuffer = existing.value;
				const concatenated = VSBuffer.concat([existingBuffer, contentBuffer]);
				await this._fileService.writeFile(filePath, concatenated);
			} catch {
				// 文件不存在，创建新文件
				await this._fileService.writeFile(filePath, contentBuffer);
			}

			this._logService.debug('[LocalFileMemory] Wrote memory entry to ' + filePath.toString());
		} catch (error) {
			this._logService.error('[LocalFileMemory] Failed to write memory for agent ' + agentId, error);
			throw error;
		}
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		const shortTerm = await this._loadEntries(agentId, SHORT_TERM_FILE);
		const longTerm = await this._loadEntries(agentId, LONG_TERM_FILE);

		const allEntries = [...shortTerm, ...longTerm];
		const lowerQuery = query.toLowerCase();

		// 简单文本匹配搜索
		const results = allEntries.filter(entry =>
			entry.content.toLowerCase().includes(lowerQuery)
		);

		// 按时间戳排序（新的在前）
		results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

		return results;
	}

	private async _loadEntries(agentId: string, fileName: string): Promise<IMemoryEntry[]> {
		const filePath = this._getMemoryFilePath(agentId, fileName);

		try {
			const content = await this._fileService.readFile(filePath);
			const text = new TextDecoder().decode(content.value.buffer);
			const lines = text.trim().split('\n').filter(line => line.trim());
			return lines.map(line => {
				try {
					return JSON.parse(line) as IMemoryEntry;
				} catch {
					return null;
				}
			}).filter((entry): entry is IMemoryEntry => entry !== null);
		} catch {
			// 文件不存在，返回空数组
			this._logService.debug('[LocalFileMemory] No memory file found at ' + filePath.toString());
			return [];
		}
	}

	private _getMemoryFilePath(agentId: string, fileName: string): URI {
		const pathStr = MEMORY_DIR + '/' + agentId + '/memory/' + fileName;
		return URI.from({
			scheme: 'file',
			path: pathStr,
		});
	}

	private _buildSystemPrompt(shortTerm: IMemoryEntry[], longTerm: IMemoryEntry[]): string {
		const parts: string[] = [];

		if (longTerm.length > 0) {
			parts.push('## Long-term Memory');
			longTerm.slice(-10).forEach(entry => {
				parts.push('- ' + entry.content);
			});
		}

		if (shortTerm.length > 0) {
			parts.push('\n## Recent Context');
			shortTerm.slice(-20).forEach(entry => {
				parts.push('- ' + entry.content);
			});
		}

		return parts.join('\n');
	}

	dispose(): void {
		// 清理资源
	}
}
