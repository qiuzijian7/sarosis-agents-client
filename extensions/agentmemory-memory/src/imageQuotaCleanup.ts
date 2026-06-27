/*---------------------------------------------------------------------------------------------
 *  图片配额清理 — 强制图片存储不超过配额限制。
 *  1:1 复刻 agentmemory src/functions/image-quota-cleanup.ts
 *
 *  当图片存储超过配额时，按 LRU 策略驱逐最旧的无引用图片。
 *--------------------------------------------------------------------------------------------*/

import type { ImageRefManager, ImageRef } from './imageRefs.js';

const GRACE_PERIOD_MS = 30_000;  // 新写入图片 30 秒内不驱逐

export interface ImageQuotaConfig {
	maxBytes: number;
	gracePeriodMs: number;
}

export interface ImageQuotaResult {
	totalSize: number;
	limit: number;
	evicted: number;
	freedBytes: number;
	underQuota: boolean;
}

const DEFAULT_CONFIG: ImageQuotaConfig = {
	maxBytes: 100 * 1024 * 1024,  // 100MB
	gracePeriodMs: GRACE_PERIOD_MS,
};

interface FileStat {
	filePath: string;
	size: number;
	mtimeMs: number;
}

export class ImageQuotaCleanup {
	private _config: ImageQuotaConfig;
	private _fileStats: Map<string, FileStat> = new Map();

	constructor(config?: Partial<ImageQuotaConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * 注册文件统计
	 */
	registerFile(filePath: string, size: number, mtimeMs: number = Date.now()): void {
		this._fileStats.set(filePath, { filePath, size, mtimeMs });
	}

	/**
	 * 执行配额清理
	 */
	cleanup(imageRefManager: ImageRefManager): ImageQuotaResult {
		const now = Date.now();
		let totalSize = 0;
		const fileStats: FileStat[] = [];

		for (const [filePath, stat] of this._fileStats) {
			fileStats.push(stat);
			totalSize += stat.size;
		}

		if (totalSize <= this._config.maxBytes) {
			return { totalSize, limit: this._config.maxBytes, evicted: 0, freedBytes: 0, underQuota: true };
		}

		// 按修改时间排序（最旧的在前）
		fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

		let totalToFree = totalSize - this._config.maxBytes;
		let evicted = 0;
		let freedBytes = 0;

		for (const file of fileStats) {
			if (totalToFree <= 0) break;

			// 宽限期内不驱逐
			if (now - file.mtimeMs < this._config.gracePeriodMs) continue;

			// 检查引用计数
			const refCount = imageRefManager.getRefCount(file.filePath);
			if (refCount > 0) continue;  // 仍被引用，不驱逐

			// 驱逐
			this._fileStats.delete(file.filePath);
			totalToFree -= file.size;
			freedBytes += file.size;
			evicted++;
		}

		return { totalSize: totalSize - freedBytes, limit: this._config.maxBytes, evicted, freedBytes, underQuota: totalToFree <= 0 };
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<ImageQuotaConfig>): void {
		this._config = { ...this._config, ...config };
	}

	getConfig(): ImageQuotaConfig { return { ...this._config }; }

	/**
	 * 获取统计
	 */
	getStats(): { totalFiles: number; totalSize: number; limit: number; usageRatio: number } {
		const totalSize = Array.from(this._fileStats.values()).reduce((s, f) => s + f.size, 0);
		return {
			totalFiles: this._fileStats.size,
			totalSize,
			limit: this._config.maxBytes,
			usageRatio: totalSize / this._config.maxBytes,
		};
	}

	/**
	 * 清除文件统计
	 */
	clear(): void {
		this._fileStats.clear();
	}
}
