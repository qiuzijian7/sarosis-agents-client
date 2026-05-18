/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Self-Evolution Service 实现。
 *
 * 负责：
 * - 持久化进化记录到文件系统 (JSON)
 * - 跟踪每个 Agent 的 nudge 计数器
 * - 在达到阈值时触发后台进化审查
 * - 提供记录查询接口给 UI (EvolutionViewPane / EvolutionDetailEditorPane)
 *
 * 存储结构：
 *   <userRoamingDataHome>/sarosis/evolution/
 *     records.json          — 全局进化记录
 *     configs/
 *       <agentId>.json      — 每个 agent 的进化配置
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import {
	ISelfEvolutionService,
	IEvolutionRecord,
	IEvolutionConfig,
	EvolutionTrigger,
	DEFAULT_EVOLUTION_CONFIG,
} from '../common/selfEvolution.js';

export class SelfEvolutionService extends Disposable implements ISelfEvolutionService {
	declare readonly _serviceBrand: undefined;

	// --- Events ---

	private readonly _onDidChangeRecords = this._register(new Emitter<void>());
	readonly onDidChangeRecords: Event<void> = this._onDidChangeRecords.event;

	private readonly _onDidStartEvolution = this._register(new Emitter<{ agentId: string; trigger: EvolutionTrigger }>());
	readonly onDidStartEvolution: Event<{ agentId: string; trigger: EvolutionTrigger }> = this._onDidStartEvolution.event;

	private readonly _onDidCompleteEvolution = this._register(new Emitter<IEvolutionRecord>());
	readonly onDidCompleteEvolution: Event<IEvolutionRecord> = this._onDidCompleteEvolution.event;

	// --- State ---

	private _records: IEvolutionRecord[] = [];
	private readonly _configs = new Map<string, IEvolutionConfig>();
	private readonly _nudgeCounters = new Map<string, { turns: number; iterations: number }>();

	// --- Storage paths ---

	private readonly _evolutionDir: URI;
	private readonly _recordsFile: URI;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Use userRoamingDataHome for cross-workspace persistence
		this._evolutionDir = URI.joinPath(this.environmentService.userRoamingDataHome, 'sarosis', 'evolution');
		this._recordsFile = URI.joinPath(this._evolutionDir, 'records.json');

		// Load on construction
		this._loadRecords();
	}

	// --- Query ---

	getRecords(options?: { workspaceId?: string; agentId?: string; limit?: number }): readonly IEvolutionRecord[] {
		let result: IEvolutionRecord[] = [...this._records];

		if (options?.workspaceId) {
			result = result.filter(r => r.workspaceId === options.workspaceId);
		}
		if (options?.agentId) {
			result = result.filter(r => r.agentId === options.agentId);
		}

		// Sort by timestamp descending (newest first)
		result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		if (options?.limit && options.limit > 0) {
			result = result.slice(0, options.limit);
		}

		return result;
	}

	getRecord(id: string): IEvolutionRecord | undefined {
		return this._records.find(r => r.id === id);
	}

	getConfig(agentId: string): IEvolutionConfig {
		return this._configs.get(agentId) ?? { ...DEFAULT_EVOLUTION_CONFIG };
	}

	// --- Mutation ---

	updateConfig(agentId: string, config: Partial<IEvolutionConfig>): void {
		const current = this.getConfig(agentId);
		const updated = { ...current, ...config };
		this._configs.set(agentId, updated);
		this._saveConfig(agentId, updated);
	}

	async triggerEvolution(agentId: string, trigger: EvolutionTrigger = 'manual'): Promise<IEvolutionRecord | undefined> {
		this.logService.info(`[SelfEvolution] Manual evolution triggered for agent ${agentId}`);
		this._onDidStartEvolution.fire({ agentId, trigger });

		// Create a placeholder record - in a real implementation this would
		// spawn a background review agent (like Hermes does)
		const record: IEvolutionRecord = {
			id: this._generateId(),
			timestamp: new Date().toISOString(),
			trigger,
			actions: ['memory_updated'],
			workspaceId: '',
			workspaceName: 'Current Workspace',
			agentId,
			agentName: agentId,
			contextSummary: 'Manual evolution review triggered by user.',
			fileDiffs: [],
			generatedSkills: [],
			summary: `🧬 Self-evolution review completed for agent ${agentId}`,
			durationMs: 0,
		};

		this.recordEvolution(record);
		this._onDidCompleteEvolution.fire(record);
		return record;
	}

	recordEvolution(record: IEvolutionRecord): void {
		this._records.push(record);
		this._saveRecords();
		this._onDidChangeRecords.fire();
		this.logService.info(`[SelfEvolution] Recorded evolution: ${record.id} - ${record.summary}`);
	}

	deleteRecord(id: string): void {
		const idx = this._records.findIndex(r => r.id === id);
		if (idx >= 0) {
			this._records.splice(idx, 1);
			this._saveRecords();
			this._onDidChangeRecords.fire();
		}
	}

	clearRecords(agentId: string): void {
		this._records = this._records.filter(r => r.agentId !== agentId);
		this._saveRecords();
		this._onDidChangeRecords.fire();
	}

	// --- Nudge Tracking ---

	notifyUserTurn(agentId: string): void {
		const counter = this._getOrCreateCounter(agentId);
		counter.turns++;

		const config = this.getConfig(agentId);
		if (!config.enabled) {
			return;
		}

		if (counter.turns >= config.memoryNudgeInterval) {
			counter.turns = 0;
			this.logService.info(`[SelfEvolution] Memory nudge threshold reached for agent ${agentId}`);
			this.triggerEvolution(agentId, 'nudge_memory');
		}
	}

	notifyToolIteration(agentId: string, iterationCount: number): void {
		const counter = this._getOrCreateCounter(agentId);
		counter.iterations += iterationCount;

		const config = this.getConfig(agentId);
		if (!config.enabled) {
			return;
		}

		if (counter.iterations >= config.skillNudgeInterval) {
			counter.iterations = 0;
			this.logService.info(`[SelfEvolution] Skill nudge threshold reached for agent ${agentId}`);
			this.triggerEvolution(agentId, 'nudge_skill');
		}
	}

	// --- Lifecycle ---

	async reload(): Promise<void> {
		await this._loadRecords();
	}

	// --- Private helpers ---

	private async _loadRecords(): Promise<void> {
		try {
			const exists = await this.fileService.exists(this._recordsFile);
			if (exists) {
				const content = await this.fileService.readFile(this._recordsFile);
				const parsed = JSON.parse(content.value.toString());
				this._records = Array.isArray(parsed) ? parsed : [];
			} else {
				this._records = [];
			}
			this.logService.info(`[SelfEvolution] Loaded ${this._records.length} evolution records`);
		} catch (err) {
			this.logService.warn('[SelfEvolution] Failed to load records', err);
			this._records = [];
		}
	}

	private async _saveRecords(): Promise<void> {
		try {
			const json = JSON.stringify(this._records, null, 2);
			await this.fileService.writeFile(this._recordsFile, VSBuffer.fromString(json));
		} catch (err) {
			this.logService.warn('[SelfEvolution] Failed to save records', err);
		}
	}

	private async _saveConfig(agentId: string, config: IEvolutionConfig): Promise<void> {
		try {
			const configFile = URI.joinPath(this._evolutionDir, 'configs', `${agentId}.json`);
			const json = JSON.stringify(config, null, 2);
			await this.fileService.writeFile(configFile, VSBuffer.fromString(json));
		} catch (err) {
			this.logService.warn(`[SelfEvolution] Failed to save config for ${agentId}`, err);
		}
	}

	private _getOrCreateCounter(agentId: string): { turns: number; iterations: number } {
		let counter = this._nudgeCounters.get(agentId);
		if (!counter) {
			counter = { turns: 0, iterations: 0 };
			this._nudgeCounters.set(agentId, counter);
		}
		return counter;
	}

	private _generateId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 8);
		return `evo_${timestamp}_${random}`;
	}
}
