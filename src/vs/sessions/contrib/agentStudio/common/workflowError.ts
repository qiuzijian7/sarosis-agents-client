/*---------------------------------------------------------------------------------------------
 * workflowError — 工作流执行域的统一错误分类（2026-09-09，P0-1 最小切片）。
 *
 * 背景（框架分析缺点①）：三套执行范式错误语义不统一——
 *   A Dynamic Workflow（worker）: result 永不 reject，死亡是投递屏障；
 *   B Stored Workflow（DAG）   : fail-loud 标 Failed + 级联；
 *   C ComfyUI Stage（webview） : throw 到调用方。
 * 本模块提供跨范式共享的**错误分类**（不改变各范式的传递机制，只统一"类别"），
 * 让上层（聊天卡/日志/重试策略）能按 `code` 一致地呈现与决策。
 *
 * 注意：不纳入全仓的 debounce/poll 超时常量——那些是各子系统自有语义，
 * 强行集中只会让调用点跨文件跳转。本模块只覆盖「执行」域。
 *--------------------------------------------------------------------------------------------*/

/** 工作流执行错误类别（跨三范式一致）。 */
export type WorkflowErrorCode =
	| 'Cancelled'        // 用户/宿主主动取消
	| 'Timeout'          // 超时（执行/等待）
	| 'UpstreamFailed'   // 上游节点/依赖失败导致的级联失败
	| 'BackendError'     // 外部后端（ComfyUI/LLM）错误
	| 'InvalidInput'     // 入参/配置非法
	| 'NoCanvas'         // 画布/执行载体缺失
	| 'Unknown';         // 无法归类

/** 带分类的工作流错误（兼容 Error 所有用法）。 */
export class WorkflowError extends Error {
	readonly code: WorkflowErrorCode;
	/** 原始错误（如有），用于日志与诊断。 */
	override cause?: unknown;
	override readonly name = 'WorkflowError';

	constructor(code: WorkflowErrorCode, message: string, cause?: unknown) {
		super(message);
		this.code = code;
		this.cause = cause;
	}
}

/** 从任意抛错值归一化为 WorkflowError：已是则原样返回，否则按规则推断 code。 */
export function toWorkflowError(err: unknown, fallback: WorkflowErrorCode = 'Unknown'): WorkflowError {
	if (err instanceof WorkflowError) { return err; }
	if (err instanceof Error) {
		const m = err.message ?? '';
		if (/cancel/i.test(m)) { return new WorkflowError('Cancelled', m, err); }
		if (/timeout|超时|timed out/i.test(m)) { return new WorkflowError('Timeout', m, err); }
		return new WorkflowError(fallback, m, err);
	}
	return new WorkflowError(fallback, String(err), err);
}

/** 是否可重试类错误（取消/入参非法/画布缺失不可重试；超时/后端/上游可重试）。 */
export function isRetryableError(code: WorkflowErrorCode): boolean {
	return code === 'Timeout' || code === 'BackendError' || code === 'UpstreamFailed';
}
