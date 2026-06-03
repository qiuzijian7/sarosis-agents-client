/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { TaskBoardRecord } from './types.js';

// ─── Triage Service ─────────────────────────────────────────────────────────
// LLM 驱动的任务分诊（triage）能力，对应 Hermes 的 kanban_specify / kanban_decompose。
//
//  - specify：把一个粗糙的 triage 任务细化为结构化规格（Goal / Approach /
//    Acceptance criteria / Out of scope），写回任务 description，并将其推进到 todo。
//  - decompose：把一个 triage 任务分解为 2-N 个可执行子任务，建立父子依赖
//    （子任务 dependencies 指向父任务），父任务自身推进到 todo（作为伞任务）。
//
// 两者都通过 Agent OS 的 active model provider 做单次 LLM 推理（非完整 agent 轮次）。

export const ITriageService = createDecorator<ITriageService>('triageService');

export interface ITriageService {
	readonly _serviceBrand: undefined;

	/**
	 * 将一个 triage 任务细化为结构化规格并推进到 todo。
	 * @param taskId 目标任务 ID（必须存在；建议处于 triage 状态，但不强制）
	 * @returns 更新后的任务记录
	 */
	specify(taskId: string): Promise<TaskBoardRecord>;

	/**
	 * 将一个 triage 任务分解为多个子任务。
	 * @param taskId 父任务 ID
	 * @param options 分解选项（并行/串行、最大子任务数、默认指派）
	 * @returns 新创建的子任务记录数组
	 */
	decompose(taskId: string, options?: DecomposeOptions): Promise<TaskBoardRecord[]>;
}

export interface DecomposeOptions {
	/** true=生成并行子任务（彼此独立）；false=生成有序子任务（线性依赖）。默认 true。 */
	readonly fanout?: boolean;
	/** 子任务数量上限。默认 6，硬上限 12。 */
	readonly maxSubTasks?: number;
	/** 为生成的子任务指定默认指派人名（可选）。 */
	readonly assignee?: string;
}

/**
 * specify() 的结构化中间结果（也会被序列化进任务 description）。
 */
export interface SpecifyResult {
	readonly goal: string;
	readonly approach: string;
	readonly acceptanceCriteria: string[];
	readonly outOfScope: string[];
}

/**
 * decompose() 的单个子任务草案（LLM 输出解析后的中间结构）。
 */
export interface SubTaskDraft {
	readonly title: string;
	readonly description?: string;
}
