/*---------------------------------------------------------------------------------------------
 *  Slash 命令解析（纯函数，可单测）。
 *
 *  支持：
 *  - /skill <id>          → explicitSkillIds（可多个）
 *  - /workflow <id> [in]  → workflowTrigger
 *  - /wf <id> [input]     → workflowTrigger（别名）
 *  - /{wf-xxx} [input]    → workflowTrigger（bare 语法，整行匹配）
 *--------------------------------------------------------------------------------------------*/

export interface IWorkflowTrigger {
	readonly workflowId: string;
	readonly input?: string;
}

export interface ISlashCommandParseResult {
	readonly explicitSkillIds: string[];
	readonly workflowTrigger?: IWorkflowTrigger;
}

/**
 * 解析聊天输入中的 slash 命令。
 * - skill：收集全部 /skill <id>（去重、小写化）
 * - workflow：取首个 /workflow|/wf <wf-id> 或整行 bare /{wf-id}，input 为命令后剩余文本
 */
export function parseSlashCommands(message: string): ISlashCommandParseResult {
	// ── /skill <id> ──
	const explicitSkillIds: string[] = [];
	const seenSkillIds = new Set<string>();
	const skillPattern = /\/skill\s+(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = skillPattern.exec(message)) !== null) {
		const id = match[1].toLowerCase();
		if (!seenSkillIds.has(id)) {
			seenSkillIds.add(id);
			explicitSkillIds.push(id);
		}
	}

	// ── 工作流触发：/workflow|/wf <wf-id> [input]，或整行 bare /{wf-id} [input] ──
	let workflowTrigger: IWorkflowTrigger | undefined;
	const wfCmdPattern = /\/(?:workflow|wf)\s+(wf-[\w-]+)(?:\s+([\s\S]*))?/;
	const barePattern = /^\/(wf-[\w-]+)(?:\s+([\s\S]*))?$/;
	const wfCmdMatch = message.match(wfCmdPattern) ?? message.match(barePattern);
	if (wfCmdMatch) {
		workflowTrigger = {
			workflowId: wfCmdMatch[1],
			input: wfCmdMatch[2]?.trim() || undefined,
		};
	}

	return { explicitSkillIds, workflowTrigger };
}
