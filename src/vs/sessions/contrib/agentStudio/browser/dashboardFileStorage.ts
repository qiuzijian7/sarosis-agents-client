/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dashboard File Storage Service
 *
 * 替代 node/dashboardDatabase.ts（SQLite 原生模块），使用 IFileService + JSON/JSONL
 * 实现相同的持久化能力。
 *
 * 原因：渲染端 sandbox 无法加载 @vscode/sqlite3 原生模块，EXE 打包后
 * require('@vscode/sqlite3') 失败。IFileService 通过 IPC 委托主进程
 * 执行文件操作，在 EXE 中也能正常工作。
 *
 * 存储布局：
 *   ~/.saros/dashboard/cumulative-stats.json  — 累计统计 (Key-Value JSON)
 *   ~/.saros/dashboard/tool-call-stats.json   — 工具调用统计 (JSON)
 *   ~/.saros/dashboard/snapshots.jsonl        — 时间序列快照 (JSONL, 追加模式)
 *   ~/.saros/dashboard/config.json            — 布局配置 (JSON)
 *   ~/.saros/dashboard/custom-data.json       — 自定义面板数据 (JSON)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import type { IDashboardMetricsSnapshot, IDailyBucket } from '../common/agentOS.js';

interface ICumulativeStatsFile {
	[key: string]: string;
}

interface IToolCallStatsFile {
	[toolName: string]: number;
}

interface IConfigFile {
	[key: string]: unknown;
}

interface ICustomDataFile {
	[panelId: string]: { sourceId: string; data: Record<string, unknown>; lastUpdated: string };
}

/**
 * 基于 IFileService 的 Dashboard 持久化存储。
 * 与 DashboardDatabase 接口对齐，可在渲染端 sandbox 安全使用。
 */
export class DashboardFileStorage extends Disposable {

	private _ready = false;
	private _dirUri: URI | undefined;

	/** 内存缓存：累计统计 */
	private _cumulativeStats: ICumulativeStatsFile = {};
	/** 内存缓存：工具调用统计 */
	private _toolCallStats: IToolCallStatsFile = {};
	/** 内存缓存：时间序列快照 */
	private _snapshots: IDashboardMetricsSnapshot[] = [];
	/** 内存缓存：配置 */
	private _config: IConfigFile = {};
	/** 内存缓存：自定义面板数据 */
	private _customData: ICustomDataFile = {};
	/** 脏标记：累计统计/工具调用是否需要保存 */
	private _statsDirty = false;
	/** 脏标记：快照是否需要追加写入 */
	private _snapshotsDirty = false;
	/** 防抖保存定时器 */
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;

	/** 获取就绪状态 */
	get ready(): boolean { return this._ready; }

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	// ─── Lifecycle ──────────────────────────────────────────────

	/**
	 * 初始化存储：创建目录，加载已有数据。
	 * @param dirUri 存储目录 URI（如 ~/.saros/dashboard/）
	 */
	async initialize(dirUri: URI): Promise<void> {
		this._dirUri = dirUri;

		// 确保目录存在
		try {
			await this._fileService.createFolder(dirUri);
		} catch { /* dir may already exist */ }

		// 并行加载所有数据文件
		await Promise.allSettled([
			this._loadCumulativeStats(),
			this._loadToolCallStats(),
			this._loadSnapshots(),
			this._loadConfig(),
			this._loadCustomData(),
		]);

		// 清理超过 90 天的旧快照
		await this._cleanupOldSnapshots();

		this._ready = true;
		this._logService.info('[DashboardFileStorage] Initialized at:', dirUri.toString());

		// 注册 dispose 时保存
		this._register({
			dispose: () => {
				if (this._saveTimer) { clearTimeout(this._saveTimer); }
				this._flushAll().catch(() => { /* best effort */ });
			},
		});
	}

	// ─── Cumulative Stats ───────────────────────────────────────

	async getStat(key: string): Promise<string | null> {
		return this._cumulativeStats[key] ?? null;
	}

	async setStat(key: string, value: string): Promise<void> {
		this._cumulativeStats[key] = value;
		this._markStatsDirty();
	}

	async getAllStats(): Promise<Record<string, string>> {
		return { ...this._cumulativeStats };
	}

	async setAllStats(stats: Record<string, string>): Promise<void> {
		this._cumulativeStats = { ...stats };
		this._markStatsDirty();
	}

	// ─── Tool Call Stats ────────────────────────────────────────

	async getToolCallCounts(): Promise<Record<string, number>> {
		return { ...this._toolCallStats };
	}

	async incrementToolCall(toolName: string): Promise<void> {
		this._toolCallStats[toolName] = (this._toolCallStats[toolName] ?? 0) + 1;
		this._markStatsDirty();
	}

	async setToolCallCounts(counts: Record<string, number>): Promise<void> {
		this._toolCallStats = { ...counts };
		this._markStatsDirty();
	}

	// ─── Metrics Snapshots ──────────────────────────────────────

	async insertSnapshot(snap: IDashboardMetricsSnapshot): Promise<void> {
		this._snapshots.push(snap);
		this._snapshotsDirty = true;
		this._scheduleFlush();
	}

	async querySnapshots(rangeMs: number): Promise<IDashboardMetricsSnapshot[]> {
		const cutoff = Date.now() - rangeMs;
		return this._snapshots.filter(s => new Date(s.ts).getTime() > cutoff);
	}

	async dailyBuckets(rangeMs: number): Promise<IDailyBucket[]> {
		const cutoff = Date.now() - rangeMs;
		const recent = this._snapshots.filter(s => new Date(s.ts).getTime() > cutoff);

		// 按天分组
		const buckets = new Map<string, IDashboardMetricsSnapshot[]>();
		for (const s of recent) {
			const day = s.ts.slice(0, 10); // YYYY-MM-DD
			if (!buckets.has(day)) { buckets.set(day, []); }
			buckets.get(day)!.push(s);
		}

		// 每天取最后一个快照（最终值）
		return Array.from(buckets.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([day, snaps]) => {
				const last = snaps[snaps.length - 1];
				return {
					day,
					input_tokens: last.inputTokens,
					output_tokens: last.outputTokens,
					cached_tokens: last.cachedTokens,
					compression_count: last.compressionCount,
					memory_total: last.memoryTotal,
					graph_nodes: last.graphNodes,
					session_count: last.sessionCount,
				} satisfies IDailyBucket;
			});
	}

	async cleanupOldSnapshots(maxAgeDays: number = 90): Promise<void> {
		return this._cleanupOldSnapshots(maxAgeDays);
	}

	// ─── Config ─────────────────────────────────────────────────

	async getConfig(key: string): Promise<unknown | null> {
		return this._config[key] ?? null;
	}

	async setConfig(key: string, value: unknown): Promise<void> {
		this._config[key] = value;
		await this._saveConfig();
	}

	// ─── Custom Panel Data ──────────────────────────────────────

	async getCustomData(panelId: string): Promise<Record<string, unknown> | null> {
		return this._customData[panelId]?.data ?? null;
	}

	async setCustomData(panelId: string, sourceId: string, data: Record<string, unknown>): Promise<void> {
		this._customData[panelId] = { sourceId, data, lastUpdated: new Date().toISOString() };
		await this._saveCustomData();
	}

	// ─── Internal: File Paths ───────────────────────────────────

	private _fileUri(name: string): URI {
		if (!this._dirUri) { throw new Error('[DashboardFileStorage] Not initialized'); }
		return joinPath(this._dirUri, name);
	}

	// ─── Internal: Loaders ──────────────────────────────────────

	private async _loadCumulativeStats(): Promise<void> {
		try {
			const content = await this._fileService.readFile(this._fileUri('cumulative-stats.json'));
			this._cumulativeStats = JSON.parse(content.value.toString());
		} catch { /* file doesn't exist yet */ }
	}

	private async _loadToolCallStats(): Promise<void> {
		try {
			const content = await this._fileService.readFile(this._fileUri('tool-call-stats.json'));
			this._toolCallStats = JSON.parse(content.value.toString());
		} catch { /* file doesn't exist yet */ }
	}

	private async _loadSnapshots(): Promise<void> {
		try {
			const content = await this._fileService.readFile(this._fileUri('snapshots.jsonl'));
			const lines = content.value.toString().split('\n').filter(Boolean);
			this._snapshots = lines.map(line => JSON.parse(line) as IDashboardMetricsSnapshot);
		} catch { /* file doesn't exist yet */ }
	}

	private async _loadConfig(): Promise<void> {
		try {
			const content = await this._fileService.readFile(this._fileUri('config.json'));
			this._config = JSON.parse(content.value.toString());
		} catch { /* file doesn't exist yet */ }
	}

	private async _loadCustomData(): Promise<void> {
		try {
			const content = await this._fileService.readFile(this._fileUri('custom-data.json'));
			this._customData = JSON.parse(content.value.toString());
		} catch { /* file doesn't exist yet */ }
	}

	// ─── Internal: Savers ───────────────────────────────────────

	private _markStatsDirty(): void {
		this._statsDirty = true;
		this._scheduleFlush();
	}

	private _scheduleFlush(): void {
		if (this._saveTimer) { clearTimeout(this._saveTimer); }
		this._saveTimer = setTimeout(() => {
			this._flushAll().catch(err => {
				this._logService.warn('[DashboardFileStorage] Flush failed:', err);
			});
		}, 2000); // 2 秒防抖
	}

	private async _flushAll(): Promise<void> {
		const tasks: Promise<void>[] = [];
		if (this._statsDirty) {
			tasks.push(this._saveCumulativeStats());
			tasks.push(this._saveToolCallStats());
			this._statsDirty = false;
		}
		if (this._snapshotsDirty) {
			tasks.push(this._saveSnapshots());
			this._snapshotsDirty = false;
		}
		await Promise.allSettled(tasks);
	}

	private async _saveCumulativeStats(): Promise<void> {
		try {
			await this._fileService.writeFile(
				this._fileUri('cumulative-stats.json'),
				VSBuffer.fromString(JSON.stringify(this._cumulativeStats, null, 2)),
			);
		} catch (err) {
			this._logService.warn('[DashboardFileStorage] Failed to save cumulative stats:', err);
		}
	}

	private async _saveToolCallStats(): Promise<void> {
		try {
			await this._fileService.writeFile(
				this._fileUri('tool-call-stats.json'),
				VSBuffer.fromString(JSON.stringify(this._toolCallStats, null, 2)),
			);
		} catch (err) {
			this._logService.warn('[DashboardFileStorage] Failed to save tool call stats:', err);
		}
	}

	private async _saveSnapshots(): Promise<void> {
		try {
			// 全量写入 JSONL（内存中只保留 90 天数据，文件不会太大）
			const lines = this._snapshots.map(s => JSON.stringify(s)).join('\n');
			await this._fileService.writeFile(
				this._fileUri('snapshots.jsonl'),
				VSBuffer.fromString(lines),
			);
		} catch (err) {
			this._logService.warn('[DashboardFileStorage] Failed to save snapshots:', err);
		}
	}

	private async _saveConfig(): Promise<void> {
		try {
			await this._fileService.writeFile(
				this._fileUri('config.json'),
				VSBuffer.fromString(JSON.stringify(this._config, null, 2)),
			);
		} catch (err) {
			this._logService.warn('[DashboardFileStorage] Failed to save config:', err);
		}
	}

	private async _saveCustomData(): Promise<void> {
		try {
			await this._fileService.writeFile(
				this._fileUri('custom-data.json'),
				VSBuffer.fromString(JSON.stringify(this._customData, null, 2)),
			);
		} catch (err) {
			this._logService.warn('[DashboardFileStorage] Failed to save custom data:', err);
		}
	}

	// ─── Internal: Cleanup ──────────────────────────────────────

	private async _cleanupOldSnapshots(maxAgeDays: number = 90): Promise<void> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const before = this._snapshots.length;
		this._snapshots = this._snapshots.filter(s => new Date(s.ts).getTime() > cutoff);
		const removed = before - this._snapshots.length;
		if (removed > 0) {
			this._logService.info(`[DashboardFileStorage] Cleaned up ${removed} old snapshots`);
			this._snapshotsDirty = true;
			await this._saveSnapshots();
			this._snapshotsDirty = false;
		}
	}
}
