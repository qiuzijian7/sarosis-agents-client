/*---------------------------------------------------------------------------------------------
 *  UrlIngestCache — URL 导入内容去重（对齐 llm_wiki ingest-cache.ts）
 *
 *  以 URL + Content-Hash 为 key，缓存已处理的 URL 内容。
 *  同一 URL 内容未变 → 跳过重复处理，直接返回已生成的库文件路径。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

export interface UrlIngestCacheEntry {
	/** 原始 URL */
	url: string;
	/** 下载内容的 SHA256 hash */
	contentHash: string;
	/** 库文件路径（由 importFromUrl 写入） */
	savedPath: string;
	/** 处理时间戳 */
	processedAt: number;
}

type CacheMap = Record<string, UrlIngestCacheEntry>;

/** 缓存文件名 */
const CACHE_FILENAME = '.kb-url-cache.json';

/** 简单 hash（不依赖 Node crypto，兼容浏览器端测试） */
function simpleHash(content: string): string {
	let h = 0;
	for (let i = 0; i < content.length; i++) {
		h = ((h << 5) - h + content.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36);
}

/**
 * URL ingest 缓存服务。
 * 缓存文件存储在 vault 根目录下：<vault>/.kb-url-cache.json
 */
export class UrlIngestCache {
	constructor(private readonly vaultRoot: URI) { }

	/** url+contentHash → 缓存 key */
	private cacheKey(url: string, contentHash: string): string {
		return `${url}::${contentHash}`;
	}

	/**
	 * 检查 URL+content 是否已有缓存的导入结果。
	 * @returns 缓存的库文件路径，或 null（需要重新处理）。
	 */
	async check(fileService: IFileService, url: string, content: string): Promise<string | null> {
		const cacheMap = await this.readCache(fileService);
		const hash = simpleHash(content);
		const key = this.cacheKey(url, hash);
		const entry = cacheMap[key];
		if (!entry) { return null; }
		// 验证缓存的库文件仍然存在
		try {
			await fileService.readFile(URI.file(entry.savedPath));
			return entry.savedPath;
		} catch {
			// 文件已删除，失效缓存
			delete cacheMap[key];
			await this.writeCache(fileService, cacheMap);
			return null;
		}
	}

	/** 保存缓存条目。 */
	async save(fileService: IFileService, url: string, content: string, savedPath: string): Promise<void> {
		const cacheMap = await this.readCache(fileService);
		const hash = simpleHash(content);
		const key = this.cacheKey(url, hash);
		cacheMap[key] = { url, contentHash: hash, savedPath, processedAt: Date.now() };
		await this.writeCache(fileService, cacheMap);
	}

	/** 手动失效某 URL 的缓存（强制重新处理）。 */
	async invalidate(fileService: IFileService, url: string): Promise<void> {
		const cacheMap = await this.readCache(fileService);
		const toDelete: string[] = [];
		for (const [key, entry] of Object.entries(cacheMap)) {
			if (entry.url === url) { toDelete.push(key); }
		}
		for (const k of toDelete) { delete cacheMap[k]; }
		await this.writeCache(fileService, cacheMap);
	}

	private async readCache(fileService: IFileService): Promise<CacheMap> {
		try {
			const uri = URI.joinPath(this.vaultRoot, CACHE_FILENAME);
			return JSON.parse((await fileService.readFile(uri)).value.toString());
		} catch {
			return {};
		}
	}

	private async writeCache(fileService: IFileService, cache: CacheMap): Promise<void> {
		try {
			const uri = URI.joinPath(this.vaultRoot, CACHE_FILENAME);
			await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(cache, null, 2)));
		} catch { /* best-effort */ }
	}
}
