/*---------------------------------------------------------------------------------------------
 *  图片引用 — 多模态记忆中的图片引用计数管理。
 *  参考 agentmemory src/functions/image-refs.ts
 *
 *  当记忆包含图片时，需要追踪图片的引用计数。
 *  当引用计数归零时，可以安全删除图片文件。
 *
 *  核心能力：
 *    1. increment(filePath) — 引用计数 +1
 *    2. decrement(filePath) — 引用计数 -1（归零时标记可删除）
 *    3. getRefCount(filePath) — 获取引用计数
 *    4. getOrphanedImages() — 获取无引用的图片
 *    5. cleanupOrphaned() — 清理无引用图片
 *--------------------------------------------------------------------------------------------*/

export interface ImageRef {
	filePath: string;
	refCount: number;
	firstReferencedAt: string;
	lastReferencedAt: string;
	referencingMemoryIds: string[];
	totalBytes?: number;
}

export interface ImageRefStats {
	totalImages: number;
	totalRefs: number;
	orphanedCount: number;
	totalBytes: number;
	avgRefsPerImage: number;
}

export class ImageRefManager {
	private _refs = new Map<string, ImageRef>();
	private _orphanedImages: string[] = [];
	private _maxOrphanedAge = 7 * 24 * 60 * 60 * 1000;  // 7 天

	/**
	 * 增加引用计数
	 */
	increment(filePath: string, memoryId?: string, sizeBytes?: number): ImageRef {
		let ref = this._refs.get(filePath);
		const now = new Date().toISOString();

		if (!ref) {
			ref = {
				filePath,
				refCount: 0,
				firstReferencedAt: now,
				lastReferencedAt: now,
				referencingMemoryIds: [],
				totalBytes: sizeBytes,
			};
			this._refs.set(filePath, ref);
		}

		ref.refCount++;
		ref.lastReferencedAt = now;
		if (memoryId && !ref.referencingMemoryIds.includes(memoryId)) {
			ref.referencingMemoryIds.push(memoryId);
		}
		if (sizeBytes !== undefined) {
			ref.totalBytes = sizeBytes;
		}

		// Remove from orphaned list if it was there
		const orphanIdx = this._orphanedImages.indexOf(filePath);
		if (orphanIdx >= 0) {
			this._orphanedImages.splice(orphanIdx, 1);
		}

		return ref;
	}

	/**
	 * 减少引用计数
	 */
	decrement(filePath: string, memoryId?: string): { refCount: number; orphaned: boolean } {
		const ref = this._refs.get(filePath);
		if (!ref) {
			return { refCount: 0, orphaned: false };
		}

		ref.refCount = Math.max(0, ref.refCount - 1);
		if (memoryId) {
			const idx = ref.referencingMemoryIds.indexOf(memoryId);
			if (idx >= 0) {
				ref.referencingMemoryIds.splice(idx, 1);
			}
		}

		if (ref.refCount === 0) {
			this._orphanedImages.push(filePath);
			return { refCount: 0, orphaned: true };
		}

		return { refCount: ref.refCount, orphaned: false };
	}

	/**
	 * 获取引用计数
	 */
	getRefCount(filePath: string): number {
		return this._refs.get(filePath)?.refCount ?? 0;
	}

	/**
	 * 获取图片引用信息
	 */
	getRef(filePath: string): ImageRef | null {
		return this._refs.get(filePath) ?? null;
	}

	/**
	 * 获取所有引用
	 */
	getAll(): ImageRef[] {
		return Array.from(this._refs.values());
	}

	/**
	 * 获取无引用的图片
	 */
	getOrphanedImages(): string[] {
		return [...this._orphanedImages];
	}

	/**
	 * 清理无引用图片
	 */
	cleanupOrphaned(maxAgeMs?: number): { cleaned: number; freedBytes: number } {
		const maxAge = maxAgeMs ?? this._maxOrphanedAge;
		const now = Date.now();
		let cleaned = 0;
		let freedBytes = 0;

		const remaining: string[] = [];
		for (const filePath of this._orphanedImages) {
			const ref = this._refs.get(filePath);
			if (!ref) {
				remaining.push(filePath);
				continue;
			}

			const age = now - new Date(ref.lastReferencedAt).getTime();
			if (age > maxAge) {
				if (ref.totalBytes) {
					freedBytes += ref.totalBytes;
				}
				this._refs.delete(filePath);
				cleaned++;
			} else {
				remaining.push(filePath);
			}
		}

		this._orphanedImages = remaining;
		return { cleaned, freedBytes };
	}

	/**
	 * 获取某记忆引用的所有图片
	 */
	getImagesByMemory(memoryId: string): string[] {
		const result: string[] = [];
		for (const ref of this._refs.values()) {
			if (ref.referencingMemoryIds.includes(memoryId)) {
				result.push(ref.filePath);
			}
		}
		return result;
	}

	/**
	 * 删除记忆时清理图片引用
	 */
	onMemoryDeleted(memoryId: string): { orphaned: string[] } {
		const orphaned: string[] = [];
		for (const [filePath, ref] of this._refs) {
			if (ref.referencingMemoryIds.includes(memoryId)) {
				const result = this.decrement(filePath, memoryId);
				if (result.orphaned) {
					orphaned.push(filePath);
				}
			}
		}
		return { orphaned };
	}

	/**
	 * 获取统计
	 */
	getStats(): ImageRefStats {
		const refs = Array.from(this._refs.values());
		const totalRefs = refs.reduce((s, r) => s + r.refCount, 0);
		const totalBytes = refs.reduce((s, r) => s + (r.totalBytes ?? 0), 0);
		return {
			totalImages: refs.length,
			totalRefs,
			orphanedCount: this._orphanedImages.length,
			totalBytes,
			avgRefsPerImage: refs.length > 0 ? Math.round(totalRefs / refs.length * 10) / 10 : 0,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._refs.clear();
		this._orphanedImages = [];
	}
}
