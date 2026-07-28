/*---------------------------------------------------------------------------------------------
 *  AgentOS — ChatMode policy / WorkMode runtime separation
 *--------------------------------------------------------------------------------------------*/

export type AgentChatMode = 'craft' | 'ask' | 'plan' | 'workflow';
export type AgentWorkMode = 'plan' | 'work';
export type PlanApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type PlanExecutionStatus = 'idle' | 'dispatching' | 'running' | 'completed' | 'failed';

export interface AgentWorkState {
	readonly mode: AgentWorkMode;
	readonly planFilePath?: string;
	readonly approvalStatus: PlanApprovalStatus;
	readonly executionStatus: PlanExecutionStatus;
}

export type AgentWorkEvent =
	| { readonly type: 'ENTER_PLAN'; readonly planFilePath?: string }
	| { readonly type: 'SET_PLAN_FILE'; readonly planFilePath: string }
	| { readonly type: 'REQUEST_APPROVAL' }
	| { readonly type: 'APPROVE_PLAN' }
	| { readonly type: 'REJECT_PLAN' }
	| { readonly type: 'START_DISPATCH' }
	| { readonly type: 'START_EXECUTION' }
	| { readonly type: 'COMPLETE_EXECUTION' }
	| { readonly type: 'FAIL_EXECUTION' };

/** 初始 WorkState（不再依赖 ChatMode，默认 work 模式） */
export function createInitialWorkState(requestedMode?: AgentWorkMode): AgentWorkState {
	return {
		mode: requestedMode ?? 'work',
		approvalStatus: 'none',
		executionStatus: 'idle',
	};
}

export function reduceWorkState(state: AgentWorkState, event: AgentWorkEvent): AgentWorkState {
	switch (event.type) {
		case 'ENTER_PLAN':
			return {
				mode: 'plan',
				planFilePath: event.planFilePath ?? state.planFilePath,
				approvalStatus: 'none',
				executionStatus: 'idle',
			};
		case 'SET_PLAN_FILE':
			return { ...state, planFilePath: event.planFilePath };
		case 'REQUEST_APPROVAL':
			return { ...state, approvalStatus: 'pending' };
		case 'APPROVE_PLAN':
			return { ...state, mode: 'work', approvalStatus: 'approved' };
		case 'REJECT_PLAN':
			return { ...state, mode: 'plan', approvalStatus: 'rejected' };
		case 'START_DISPATCH':
			return { ...state, mode: 'work', executionStatus: 'dispatching' };
		case 'START_EXECUTION':
			return { ...state, mode: 'work', executionStatus: 'running' };
		case 'COMPLETE_EXECUTION':
			return { ...state, executionStatus: 'completed' };
		case 'FAIL_EXECUTION':
			return { ...state, executionStatus: 'failed' };
	}
}

/** plan_exit 是否需要审批（已移除 ChatMode，默认不审批） */
export function planExitRequiresApproval(_chatMode?: string): boolean {
	return false;
}

export interface ParsedPlanTask {
	readonly title: string;
	readonly description: string;
	readonly files?: string[];
	readonly complexity?: 'low' | 'medium' | 'high';
	readonly suggestedRole?: string;
	readonly dependencies?: string[];
	readonly deliverable?: string;
}

export interface ParsedPlanDocument {
	readonly summary: string;
	readonly tasks: ParsedPlanTask[];
}

function cleanList(value: string): string[] | undefined {
	const items = value
		.split(/[,，;]/)
		.map(item => item.trim().replace(/^`|`$/g, ''))
		.filter(item => item.length > 0 && !/^(none|无|n\/a)$/i.test(item));
	return items.length > 0 ? items : undefined;
}

function parseTaskBlock(title: string, body: readonly string[]): ParsedPlanTask {
	let files: string[] | undefined;
	let dependencies: string[] | undefined;
	let suggestedRole: string | undefined;
	let complexity: ParsedPlanTask['complexity'];
	let deliverable: string | undefined;
	const description: string[] = [];

	for (const rawLine of body) {
		const line = rawLine.trim().replace(/^[-*]\s+/, '');
		if (!line) { continue; }
		const metadata = /^(description|files?|dependencies|depends on|role|agent|complexity|deliverable)\s*:\s*(.*)$/i.exec(line);
		if (!metadata) {
			description.push(line);
			continue;
		}
		const key = metadata[1].toLowerCase();
		const value = metadata[2].trim();
		if (key === 'description') { description.push(value); }
		else if (key.startsWith('file')) { files = cleanList(value); }
		else if (key === 'dependencies' || key === 'depends on') { dependencies = cleanList(value); }
		else if (key === 'role' || key === 'agent') { suggestedRole = value || undefined; }
		else if (key === 'deliverable') { deliverable = value || undefined; }
		else if (key === 'complexity' && /^(low|medium|high)$/i.test(value)) {
			complexity = value.toLowerCase() as ParsedPlanTask['complexity'];
		}
	}

	return {
		title: title.trim(),
		description: description.join('\n').trim() || title.trim(),
		files,
		dependencies,
		suggestedRole,
		complexity,
		deliverable,
	};
}

/**
 * Parse the stable `## Tasks` contract emitted by the plan prompt.
 * Supports `### Task N: title` blocks and simple checklist/numbered-list fallbacks.
 */
export function parsePlanDocument(markdown: string): ParsedPlanDocument {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const goalStart = lines.findIndex(line => /^##\s+Goal\s*$/i.test(line.trim()));
	const tasksStart = lines.findIndex(line => /^##\s+Tasks\s*$/i.test(line.trim()));
	const summaryLines: string[] = [];
	if (goalStart >= 0) {
		for (let i = goalStart + 1; i < lines.length && !/^##\s+/.test(lines[i].trim()); i++) {
			if (lines[i].trim()) { summaryLines.push(lines[i].trim()); }
		}
	}

	const taskLines = tasksStart >= 0
		? lines.slice(tasksStart + 1, lines.findIndex((line, index) => index > tasksStart && /^##\s+/.test(line.trim())) >= 0
			? lines.findIndex((line, index) => index > tasksStart && /^##\s+/.test(line.trim()))
			: lines.length)
		: [];
	const headingIndexes: number[] = [];
	for (let i = 0; i < taskLines.length; i++) {
		if (/^#{3,6}\s+/.test(taskLines[i].trim())) { headingIndexes.push(i); }
	}

	const tasks: ParsedPlanTask[] = [];
	if (headingIndexes.length > 0) {
		for (let i = 0; i < headingIndexes.length; i++) {
			const start = headingIndexes[i];
			const end = headingIndexes[i + 1] ?? taskLines.length;
			const heading = taskLines[start].trim().replace(/^#{3,6}\s+/, '');
			const title = heading.replace(/^Task\s*\d+\s*[:.)-]\s*/i, '').trim();
			if (title) { tasks.push(parseTaskBlock(title, taskLines.slice(start + 1, end))); }
		}
	} else {
		for (const rawLine of taskLines) {
			const match = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/.exec(rawLine);
			if (!match) { continue; }
			const text = match[1].trim();
			if (/^(description|files?|dependencies|depends on|role|agent|complexity|deliverable)\s*:/i.test(text)) { continue; }
			const split = /^(.+?)\s+(?:—|-)\s+(.+)$/.exec(text);
			tasks.push(parseTaskBlock(split?.[1] ?? text, split ? [split[2]] : []));
		}
	}

	const fallbackSummary = lines
		.filter(line => line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('*Created:'))
		.slice(0, 3)
		.map(line => line.trim())
		.join(' ');
	return {
		summary: summaryLines.join('\n').trim() || fallbackSummary || 'Execute the approved plan',
		tasks,
	};
}
