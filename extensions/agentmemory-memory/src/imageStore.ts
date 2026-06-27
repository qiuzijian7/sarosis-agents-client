/*---------------------------------------------------------------------------------------------
 *  图片存储 — 图片文件的管理工具。
 *  1:1 复刻 agentmemory src/utils/image-store.ts
 *
 *  在进程内方案中，图片存储路径由调用方提供（扩展宿主）。
 *  本模块提供路径管理 + 配额计算 + 文件操作接口。
 *--------------------------------------------------------------------------------------------*/

export interface ImageStoreConfig {
	imagesDir: string;
	maxBytes: number;
	allowedExtensions: string[];
}

const DEFAULT_CONFIG: ImageStoreConfig = {
	imagesDir: '.agentmemory/images',
	maxBytes: 100 * 1024 * 1024,  // 100MB
	allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
};

export class ImageStore {
	private _config: ImageStoreConfig;
	private _stats = new Map<string, { size: number; mtimeMs: number }>();
	private _totalBytes = 0;

	constructor(config?: Partial<ImageStoreConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * 检查文件路径是否在受管理的图片存储目录下
	 */
	isManagedImagePath(filePath: string): boolean {
		const normalized = filePath.replace(/\\/g, '/');
		return normalized.startsWith(this._config.imagesDir.replace(/\\/g, '/'));
	}

	/**
	 * 检查文件扩展名是否允许
	 */
	isAllowedExtension(filePath: string): boolean {
		const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
		return this._config.allowedExtensions.includes(ext);
	}

	/**
	 * 获取图片存储路径
	 */
	getImagePath(filename: string): string {
		return `${this._config.imagesDir}/${filename}`;
	}

	/**
	 * 注册图片文件
	 */
	registerImage(filePath: string, size: number, mtimeMs: number = Date.now()): void {
		const existing = this._stats.get(filePath);
		if (existing) {
			this._totalBytes -= existing.size;
		}
		this._stats.set(filePath, { size, mtimeMs });
		this._totalBytes += size;
	}

	/**
	 * 获取图片文件统计
	 */
	getImageStat(filePath: string): { size: number; mtimeMs: number } | null {
		return this._stats.get(filePath) ?? null;
	}

	/**
	 * 删除图片文件记录
	 */
	unregisterImage(filePath: string): number {
		const stat = this._stats.get(filePath);
		if (!stat) return 0;
		this._stats.delete(filePath);
		this._totalBytes -= stat.size;
		return stat.size;
	}

	/**
	 * 触摸图片（更新修改时间）
	 */
	touchImage(filePath: string): void {
		const stat = this._stats.get(filePath);
		if (stat) {
			stat.mtimeMs = Date.now();
		}
	}

	/**
	 * 检查是否超过配额
	 */
	isOverQuota(): boolean {
		return this._totalBytes > this._config.maxBytes;
	}

	/**
	 * 获取存储统计
	 */
	getStats(): {
		totalImages: number;
		totalBytes: number;
		maxBytes: number;
		usageRatio: number;
		overQuota: boolean;
	} {
		return {
			totalImages: this._stats.size,
			totalBytes: this._totalBytes,
			maxBytes: this._config.maxBytes,
			usageRatio: this._totalBytes / this._config.maxBytes,
			overQuota: this.isOverQuota(),
		};
	}

	/**
	 * 获取最大存储字节数
	 */
	getMaxBytes(): number {
		return this._config.maxBytes;
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<ImageStoreConfig>): void {
		this._config = { ...this._config, ...config };
	}

	/**
	 * 获取配置
	 */
	getConfig(): ImageStoreConfig {
		return { ...this._config };
	}

	/**
	 * 清除所有记录
	 */
	clear(): void {
		this._stats.clear();
		this._totalBytes = 0;
	}
}

export function getMaxBytes(config?: ImageStoreConfig): number {
	return config?.maxBytes ?? DEFAULT_CONFIG.maxBytes;
}
