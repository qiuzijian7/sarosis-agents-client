/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IAgentTaskBoardService } from '../../../common/agentStudio.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import type { TaskBoardRecord } from '../../../common/types.js';
import { TaskBoardStatus, TaskSource } from '../../../common/types.js';
import { IChatMessage, IModelProvider } from '../../../common/providers.js';
import {
	ITriageService,
	DecomposeOptions,
	SpecifyResult,
	SubTaskDraft,
} from '../../../common/triageService.js';

const MAX_SUBTASKS_HARD_LIMIT = 12;
const DEFAULT_MAX_SUBTASKS = 6;

/**
 * LLM 驱动的 Triage 服务实现。
 *
 * 通过 Agent OS 的 active model provider 做单次 LLM 推理（非完整 agent 轮次），
 * 把 triage 任务细化（specify）或分解（decompose）后落地到 IAgentTaskBoardService。
 *
 * 解析策略：要求模型输出 JSON code-fence，解析失败时回退到启发式文本解析，
 * 保证即使模型不严格遵守格式也能产出可用结果。
 */
export class LlmTriageService extends Disposable implements ITriageService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ─── specify ──────────────────────────────────────────────────────────

	async specify(taskId: string): Promise<TaskBoardRecord> {
		const task = await this.taskBoardService.getTask(taskId);
		if (!task) {
			throw new Error(`triage.specify: task "${taskId}" not found`);
		}

		const prompt = this._buildSpecifyPrompt(task);
		const raw = await this._runLlm(
			'You are a senior engineering planner. You turn rough task ideas into crisp, actionable specifications.',
			prompt,
		);

		const spec = this._parseSpecifyResult(raw, task);
		const description = this._renderSpecMarkdown(spec);

		const updated = await this.taskBoardService.updateTask(taskId, {
			description,
			status: task.status === TaskBoardStatus.Triage ? TaskBoardStatus.Todo : task.status,
		});
		this.logService.info(`[Triage] specify: task #${taskId.slice(-6)} refined → ${updated.status}`);
		return updated;
	}

	// ─── decompose ────────────────────────────────────────────────────────

	async decompose(taskId: string, options?: DecomposeOptions): Promise<TaskBoardRecord[]> {
		const task = await this.taskBoardService.getTask(taskId);
		if (!task) {
			throw new Error(`triage.decompose: task "${taskId}" not found`);
		}

		const fanout = options?.fanout ?? true;
		const maxSubTasks = Math.min(
			Math.max(2, options?.maxSubTasks ?? DEFAULT_MAX_SUBTASKS),
			MAX_SUBTASKS_HARD_LIMIT,
		);

		const prompt = this._buildDecomposePrompt(task, fanout, maxSubTasks);
		const raw = await this._runLlm(
			'You are a senior engineering planner. You break a goal into a minimal set of concrete, independently-verifiable subtasks.',
			prompt,
		);

		const drafts = this._parseSubTaskDrafts(raw, maxSubTasks);
		if (drafts.length === 0) {
			throw new Error('triage.decompose: model returned no usable subtasks');
		}

		const created: TaskBoardRecord[] = [];
		let previousId: string | undefined;
		for (const draft of drafts) {
			// fanout=true：所有子任务依赖父任务（并行）。
			// fanout=false：链式依赖（subtask N 依赖 subtask N-1），首个依赖父任务。
			const dependencies = fanout
				? [task.id]
				: [previousId ?? task.id];

			const child = await this.taskBoardService.createTask({
				title: draft.title,
				description: draft.description,
				status: TaskBoardStatus.Todo,
				source: TaskSource.Manual,
				workspaceId: task.workspaceId,
				assigneeName: options?.assignee ?? task.assigneeName,
				dependencies,
			});
			created.push(child);
			previousId = child.id;
		}

		// 父任务转为 todo（作为伞任务保留，记录已分解）。
		const note = `[DECOMPOSED into ${created.length} subtask(s): ${created.map(c => `#${c.id.slice(-6)}`).join(', ')}]`;
		const parentDesc = task.description ? `${task.description}\n${note}` : note;
		await this.taskBoardService.updateTask(taskId, {
			description: parentDesc,
			status: task.status === TaskBoardStatus.Triage ? TaskBoardStatus.Todo : task.status,
		});

		this.logService.info(`[Triage] decompose: task #${taskId.slice(-6)} → ${created.length} subtasks (fanout=${fanout})`);
		return created;
	}

	// ─── LLM plumbing ───────────────────────────────────────────────────────

	/**
	 * 用 active model provider 做一次非流式（内部累积流）的 LLM 推理，返回完整文本。
	 */
	private async _runLlm(systemPrompt: string, userPrompt: string): Promise<string> {
		const selection = this.agentOS.getActiveModelSelection();
		if (!selection || !selection.providerId || !selection.modelId) {
			throw new Error('triage: no active model selection available');
		}
		const providers = this.agentOS.getModelProviders();
		const provider: IModelProvider | undefined = providers.find(p => p.id === selection.providerId);
		if (!provider) {
			throw new Error(`triage: model provider "${selection.providerId}" not found`);
		}

		const messages: IChatMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		];

		let text = '';
		try {
			const stream = provider.chat(
				selection.modelId,
				messages,
				{ temperature: 0.2, systemPrompt },
				selection.agentId ? { agentId: selection.agentId } : undefined,
			);
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					text += delta.content;
				} else if (delta.type === 'error') {
					throw new Error(delta.error || 'model returned an error');
				} else if (delta.type === 'done') {
					break;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`triage: LLM call failed: ${msg}`);
		}
		void CancellationToken; // reserved for future cancellation support
		return text.trim();
	}

	// ─── prompt builders ────────────────────────────────────────────────────

	private _buildSpecifyPrompt(task: TaskBoardRecord): string {
		return [
			`Refine the following rough task into a clear specification.`,
			``,
			`TITLE: ${task.title}`,
			task.description ? `CURRENT NOTES:\n${task.description}` : `CURRENT NOTES: (none)`,
			``,
			`Respond with ONLY a JSON object inside a \`\`\`json code fence, with this exact shape:`,
			`{`,
			`  "goal": "one-sentence goal",`,
			`  "approach": "2-4 sentence approach",`,
			`  "acceptanceCriteria": ["criterion 1", "criterion 2"],`,
			`  "outOfScope": ["thing explicitly not included"]`,
			`}`,
		].join('\n');
	}

	private _buildDecomposePrompt(task: TaskBoardRecord, fanout: boolean, maxSubTasks: number): string {
		return [
			`Break the following goal into ${fanout ? 'INDEPENDENT (parallelizable)' : 'SEQUENTIAL (ordered)'} subtasks.`,
			`Produce at most ${maxSubTasks} subtasks. Each subtask must be concrete and independently verifiable.`,
			``,
			`GOAL TITLE: ${task.title}`,
			task.description ? `CONTEXT:\n${task.description}` : `CONTEXT: (none)`,
			``,
			`Respond with ONLY a JSON array inside a \`\`\`json code fence, with this exact shape:`,
			`[`,
			`  { "title": "short imperative title", "description": "1-3 sentence detail" }`,
			`]`,
		].join('\n');
	}

	// ─── output parsing ───────────────────────────────────────────────────

	/** 从文本中抽取第一个 JSON code-fence（或裸 JSON）的内容。 */
	private _extractJson(raw: string): string | undefined {
		// 1. ```json ... ``` 或 ``` ... ```
		const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence && fence[1]) {
			return fence[1].trim();
		}
		// 2. 裸 JSON：找第一个 { 或 [ 到最后一个 } 或 ]
		const firstObj = raw.indexOf('{');
		const firstArr = raw.indexOf('[');
		const start = (firstArr === -1) ? firstObj : (firstObj === -1 ? firstArr : Math.min(firstObj, firstArr));
		if (start === -1) { return undefined; }
		const lastObj = raw.lastIndexOf('}');
		const lastArr = raw.lastIndexOf(']');
		const end = Math.max(lastObj, lastArr);
		if (end <= start) { return undefined; }
		return raw.slice(start, end + 1).trim();
	}

	private _parseSpecifyResult(raw: string, task: TaskBoardRecord): SpecifyResult {
		const json = this._extractJson(raw);
		if (json) {
			try {
				const obj = JSON.parse(json) as Partial<SpecifyResult>;
				return {
					goal: typeof obj.goal === 'string' && obj.goal.trim() ? obj.goal.trim() : task.title,
					approach: typeof obj.approach === 'string' ? obj.approach.trim() : '',
					acceptanceCriteria: Array.isArray(obj.acceptanceCriteria) ? obj.acceptanceCriteria.filter(x => typeof x === 'string') : [],
					outOfScope: Array.isArray(obj.outOfScope) ? obj.outOfScope.filter(x => typeof x === 'string') : [],
				};
			} catch (err) {
				this.logService.warn(`[Triage] specify: JSON parse failed, falling back to raw text: ${err}`);
			}
		}
		// 回退：把整段文本作为 approach。
		return {
			goal: task.title,
			approach: raw.trim() || '(model returned no content)',
			acceptanceCriteria: [],
			outOfScope: [],
		};
	}

	private _parseSubTaskDrafts(raw: string, maxSubTasks: number): SubTaskDraft[] {
		const json = this._extractJson(raw);
		const drafts: SubTaskDraft[] = [];
		if (json) {
			try {
				const arr = JSON.parse(json) as unknown;
				if (Array.isArray(arr)) {
					for (const item of arr) {
						if (item && typeof item === 'object' && typeof (item as any).title === 'string') {
							const title = (item as any).title.trim();
							if (!title) { continue; }
							const description = typeof (item as any).description === 'string' ? (item as any).description.trim() : undefined;
							drafts.push({ title, description });
						}
					}
				}
			} catch (err) {
				this.logService.warn(`[Triage] decompose: JSON parse failed, falling back to line parsing: ${err}`);
			}
		}
		// 回退：按行解析「- xxx」「1. xxx」形式的列表。
		if (drafts.length === 0) {
			const lines = raw.split('\n');
			for (const line of lines) {
				const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
				if (m && m[1].trim()) {
					drafts.push({ title: m[1].trim() });
				}
			}
		}
		return drafts.slice(0, maxSubTasks);
	}

	private _renderSpecMarkdown(spec: SpecifyResult): string {
		const lines = [
			`## Goal`,
			spec.goal,
			``,
			`## Approach`,
			spec.approach || '(none)',
		];
		if (spec.acceptanceCriteria.length) {
			lines.push(``, `## Acceptance Criteria`);
			for (const c of spec.acceptanceCriteria) { lines.push(`- ${c}`); }
		}
		if (spec.outOfScope.length) {
			lines.push(``, `## Out of Scope`);
			for (const c of spec.outOfScope) { lines.push(`- ${c}`); }
		}
		return lines.join('\n');
	}
}
