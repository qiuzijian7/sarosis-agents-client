/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill Usage Tracker — 技能使用追踪（对齐 Hermes-Agent `tools/skill_usage.py`）。
 *
 * 在每个技能目录下维护 `.usage.json` sidecar，记录：
 *   - state: active | stale | archived
 *   - created_at / last_used_at / last_patched_at
 *   - read_count / patch_count
 *   - pinned（钉选免于自动清理）
 *
 * 消费者：
 *   - `builtinToolProvider._registerSkillTools()` → `onSkillRead` 回调记录读取
 *   - `memoryDetailEditorPane.ts` → 技能页签展示使用统计
 *   - 未来 curator → 基于活跃度自动 stale → archive
 */

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * 技能生命周期状态
 */
export type SkillUsageState = 'active' | 'stale' | 'archived';

/**
 * 技能使用记录（对应 `.usage.json`）
 */
export interface ISkillUsageRecord {
	/** 生命周期状态 */
	state: SkillUsageState;
	/** 创建时间 (ISO 8601) */
	createdAt: string;
	/** 最近一次 read_skill 调用时间 (ISO 8601) */
	lastUsedAt: string | null;
	/** 最近一次 patch/edit 时间 (ISO 8601) */
	lastPatchedAt: string | null;
	/** read_skill 调用次数 */
	readCount: number;
	/** 被 patch/edit 次数 */
	patchCount: number;
	/** 钉选状态（设为 true 则跳过自动清理） */
	pinned: boolean;
}

/**
 * 默认记录（新技能初始化用）
 */
export function defaultUsageRecord(): ISkillUsageRecord {
	return {
		state: 'active',
		createdAt: new Date().toISOString(),
		lastUsedAt: null,
		lastPatchedAt: null,
		readCount: 0,
		patchCount: 0,
		pinned: false,
	};
}

/**
 * 技能使用追踪器。
 *
 * 职责单一：读写 `.usage.json` + 更新统计。
 * 不依赖注册表、不感知技能来源——只操作文件系统。
 */
export class SkillUsageTracker {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	/**
	 * 记录一次技能读取（read_skill / skill_view）。
	 * 若 `.usage.json` 不存在则自动初始化。
	 */
	async recordRead(skillDirUri: URI): Promise<void> {
		try {
			let record = await this._loadRecord(skillDirUri);
			if (!record) {
				record = defaultUsageRecord();
			}
			record.readCount++;
			record.lastUsedAt = new Date().toISOString();
			await this._saveRecord(skillDirUri, record);
		} catch (err) {
			this.logService.warn(`[SkillUsageTracker] recordRead failed for ${skillDirUri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 记录一次技能修改（patch / edit）。
	 */
	async recordPatch(skillDirUri: URI): Promise<void> {
		try {
			let record = await this._loadRecord(skillDirUri);
			if (!record) {
				record = defaultUsageRecord();
			}
			record.patchCount++;
			record.lastPatchedAt = new Date().toISOString();
			await this._saveRecord(skillDirUri, record);
		} catch (err) {
			this.logService.warn(`[SkillUsageTracker] recordPatch failed for ${skillDirUri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 获取技能使用记录。
	 * 返回 null 表示文件不存在（可能未初始化）。
	 */
	async getUsage(skillDirUri: URI): Promise<ISkillUsageRecord | null> {
		return this._loadRecord(skillDirUri);
	}

	/**
	 * 获取多个技能的使用记录（批量）。
	 */
	async getUsageBatch(skillDirs: URI[]): Promise<Map<string, ISkillUsageRecord>> {
		const result = new Map<string, ISkillUsageRecord>();
		for (const dir of skillDirs) {
			try {
				const record = await this._loadRecord(dir);
				if (record) {
					result.set(dir.fsPath, record);
				}
			} catch { /* skip individual failures */ }
		}
		return result;
	}

	// ─── internals ──────────────────────────────────────────────────────────

	private _usageUri(skillDir: URI): URI {
		return URI.joinPath(skillDir, '.usage.json');
	}

	private async _loadRecord(skillDir: URI): Promise<ISkillUsageRecord | null> {
		const usageUri = this._usageUri(skillDir);
		try {
			const raw = await this.fileService.readFile(usageUri);
			const parsed = JSON.parse(raw.value.toString());
			// 补全缺失字段（向前兼容旧记录）
			const defaultValue = defaultUsageRecord();
			return { ...defaultValue, ...parsed };
		} catch {
			return null;
		}
	}

	private async _saveRecord(skillDir: URI, record: ISkillUsageRecord): Promise<void> {
		const usageUri = this._usageUri(skillDir);
		await this.fileService.writeFile(usageUri, VSBuffer.fromString(JSON.stringify(record, null, 2)));
	}
}
