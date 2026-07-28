/*---------------------------------------------------------------------------------------------
 *  UrlIngestQueue — URL 导入持久化队列 + 重试（对齐 llm_wiki ingest-queue.ts）
 *
 *  队列文件：<vault>/.kb-url-queue.json
 *  每个 URL 失败最多重试 3 次，成功或最终失败后从队列移除。
 *  调用方先 enqueue，再 run(handler) 消费所有 pending 项。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

export interface QueueItem {
	/** 唯一任务 ID */
	id: string;
	/** 原始 URL */
	url: string;
	/** 目标库分区 fsPath */
	targetFsPath: string;
	/** 入队时间戳 */
	enqueuedAt: number;
	/** 当前重试次数 */
	retryCount: number;
	/** 最大重试次数（默认 3） */
	maxRetries: number;
	/** 上次错误信息 */
	lastError?: string;
	/** 状态 */
	status: 'pending' | 'processing' | 'failed';
}

type QueueMap = Record<string, QueueItem>;

const QUEUE_FILENAME = '.kb-url-queue.json';
const DEFAULT_MAX_RETRIES = 3;

/**
 * URL Ingest 持久化队列。
 *
 * 生命周期：
 * 1. enqueue()  → 入队 + 持久化（不入队重复 URL）
 * 2. run(handler) → 循环消费所有 pending 项：dequeue → handler → markDone / markFailed
 * 3. getStats()  → 获取队列统计信息
 */
export class UrlIngestQueue {
	private processing = false;

	constructor(
		private readonly vaultRoot: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	/** 入队：添加 URL 并持久化。不会触发自动处理——调用方显式调用 run()。 */
	async enqueue(url: string, targetFsPath: string, maxRetries = DEFAULT_MAX_RETRIES): Promise<string> {
		const queue = await this.readQueue();
		// 去重：跳过已存在的相同 URL pending/processing 项
		for (const existing of Object.values(queue)) {
			if (existing.url === url && existing.status !== 'failed') {
				this.logService.info(`[UrlIngestQueue] skipped duplicate: ${url}`);
				return existing.id;
			}
		}
		const id = `url_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const item: QueueItem = {
			id, url, targetFsPath,
			enqueuedAt: Date.now(),
			retryCount: 0,
			maxRetries,
			status: 'pending',
		};
		queue[id] = item;
		await this.writeQueue(queue);
		this.logService.info(`[UrlIngestQueue] enqueued: ${id} → ${url}`);
		return id;
	}

	/**
	 * 循环消费所有 pending 项：取下一项 → handler → markDone / markFailed。
	 * 可多次调用（第一次之后的调用会被 re-entrant guard 跳过）。
	 * handler 抛出异常时自动 retry；超过 maxRetries 标记为永久失败。
	 */
	async run(handler: (item: QueueItem) => Promise<void>): Promise<void> {
		if (this.processing) { return; }
		this.processing = true;
		try {
			while (true) {
				const item = await this.dequeue();
				if (!item) { break; }
				this.logService.info(`[UrlIngestQueue] processing: ${item.id} → ${item.url}`);
				try {
					await handler(item);
					await this.markDone(item.id);
				} catch (e) {
					const errMsg = String(e?.message ?? e);
					await this.markFailed(item.id, errMsg);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	/** 获取队列统计信息。 */
	async getStats(): Promise<{ pending: number; processing: number; failed: number }> {
		const queue = await this.readQueue();
		const values = Object.values(queue);
		return {
			pending: values.filter(i => i.status === 'pending').length,
			processing: values.filter(i => i.status === 'processing').length,
			failed: values.filter(i => i.status === 'failed').length,
		};
	}

	/** 获取所有 pending 项的 URL 列表。 */
	async getPendingUrls(): Promise<string[]> {
		const queue = await this.readQueue();
		return Object.values(queue).filter(i => i.status === 'pending').map(i => i.url);
	}

	/** 移除某任务（成功时由 run 内部调用）。 */
	async markDone(id: string): Promise<void> {
		const queue = await this.readQueue();
		delete queue[id];
		await this.writeQueue(queue);
	}

	/** 标记失败（retryCount++ 或最终失败），由 run 内部调用。 */
	async markFailed(id: string, error: string): Promise<void> {
		const queue = await this.readQueue();
		const item = queue[id];
		if (!item) { return; }
		item.retryCount++;
		item.lastError = error;
		if (item.retryCount >= item.maxRetries) {
			item.status = 'failed';
			this.logService.warn(`[UrlIngestQueue] permanently failed (${item.retryCount}/${item.maxRetries}): ${id} → ${item.url}  error: ${error}`);
		} else {
			item.status = 'pending';
			this.logService.info(`[UrlIngestQueue] retry ${item.retryCount}/${item.maxRetries}: ${id} → ${item.url}`);
		}
		await this.writeQueue(queue);
	}

	// ─── internal ──────────────────────────────────────────────────────

	/** 取下一个 pending 项并标记为 processing。 */
	private async dequeue(): Promise<QueueItem | null> {
		const queue = await this.readQueue();
		const pending = Object.values(queue).filter(i => i.status === 'pending');
		if (pending.length === 0) { return null; }
		const item = pending[0];
		item.status = 'processing';
		queue[item.id] = item;
		await this.writeQueue(queue);
		return item;
	}

	private async readQueue(): Promise<QueueMap> {
		try {
			const uri = URI.joinPath(this.vaultRoot, QUEUE_FILENAME);
			return JSON.parse((await this.fileService.readFile(uri)).value.toString());
		} catch {
			return {};
		}
	}

	private async writeQueue(queue: QueueMap): Promise<void> {
		try {
			const uri = URI.joinPath(this.vaultRoot, QUEUE_FILENAME);
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(queue, null, 2)));
		} catch { /* best-effort */ }
	}
}
