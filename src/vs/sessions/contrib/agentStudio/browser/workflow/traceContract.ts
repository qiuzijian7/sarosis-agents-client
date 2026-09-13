/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流 trace 契约校验（2026-09-11 质量评估 P2）。
 *
 * 背景：`IWorkflowTraceEvent`（common/workflowExecutionService.ts）是 host 与 webview
 * 之间的**运行时契约**，但发送端（多处 `.fire({...})`）与消费端（controller 的
 * `switch (trace.kind)`）之间**没有任何编译期连接**——字段名写错、必填项漏传、
 * kind 拼错，都只会在运行时**静默失效**（卡片不出现、进度不动，排查成本极高；
 * 本会话多次撞到这一类）。
 *
 * 本模块把契约**显式化**为可校验的纯数据 + 纯函数：
 *   · 未知 kind（发送端新增而消费端未跟上）→ 立刻可查；
 *   · 必填字段缺失 / 类型不符 → 定位到具体字段；
 *   · 枚举值越界（如 status 写成 'success' 而契约是 'done'）→ 捕获。
 *
 * 校验是**非破坏性**的：调用方只记日志（按签名去重），绝不抛出、不阻断执行。
 */

/** 每种 trace kind 的**必填字段**（与 IWorkflowTraceEvent 同构，权威来源）。 */
export const TRACE_REQUIRED_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
	subagent_start: ['executionId', 'sessionId', 'nodeId', 'nodeName'],
	delta: ['executionId', 'sessionId', 'nodeId', 'delta'],
	subagent_end: ['executionId', 'sessionId', 'nodeId', 'status'],
	ask_user: ['executionId', 'sessionId', 'nodeId', 'nodeName'],
	ask_user_end: ['executionId', 'sessionId', 'nodeId', 'status'],
	// ★ 已移除 picker_select / picker_select_end（2026-09-13）：契约表此前登记了这两个
	//   kind，但**全仓没有任何发射端** —— 2026-09-11「单链路改造」后 ImagePicker 家族
	//   归一为 comfyStage，交互改由 `node_interaction` 的 `applyMode:'snapshot'`
	//   （`initialValues.__candidates`）承载。登记一个不存在的 kind 会让契约表本身失真
	//   （测试"验"的是一张与实际不符的表）。移除后若将来真有人发射，会立刻触发
	//   unknownKind 告警 —— 这正是契约层存在的目的 ✓。
	//   注：controller 的处理分支与渲染层的 `pickerSelects` 字段**保留**（历史消息兼容，
	//   已落盘的老消息里仍有该字段）。
	node_interaction: ['executionId', 'sessionId', 'nodeId', 'nodeName', 'title', 'fields'],
	node_interaction_end: ['executionId', 'sessionId', 'nodeId', 'status'],
	collect_variables: ['executionId', 'sessionId'],
	collect_variables_end: ['executionId', 'sessionId', 'status'],
	execution_end: ['executionId', 'sessionId', 'status'],
	node_progress: ['executionId', 'sessionId', 'nodeId', 'progress'],
	// 画布节点值变更回流（2026-09-11「卡片数据 ↔ 画布节点 UI 始终同步」）：
	// 用户在**画布**上改控件 → 卡片字段值跟着更新。**单向**（只更新卡片、不回写画布）→ 防回环。
	node_values_changed: ['executionId', 'sessionId', 'nodeId', 'values'],
});

/** 字段类型约束：`kind` → `field` → 期望的运行时类型。 */
export const TRACE_FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, 'string' | 'number' | 'array' | 'object'>>>> = Object.freeze({
	// ★ icon（2026-09-13 P0 修复）：host 按节点描述符推导的卡片图标（可选字段）。
	subagent_start: { nodeName: 'string', nodeId: 'string', icon: 'string' },
	delta: {},
	subagent_end: { status: 'string' },
	ask_user: { nodeName: 'string' },
	ask_user_end: { status: 'string' },
	node_interaction: { fields: 'array', initialValues: 'object', title: 'string' },
	node_interaction_end: { status: 'string' },
	collect_variables: { variables: 'array' },
	collect_variables_end: { status: 'string' },
	// ★ durationMs（2026-09-13 P2-2）：host 给出的真实耗时（可选字段）。
	execution_end: { status: 'string', durationMs: 'number' },
	node_progress: { progress: 'number' },
});

/** 枚举字段约束：`kind` → `field` → 允许值。 */
export const TRACE_ENUM_FIELDS: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>> = Object.freeze({
	subagent_end: { status: ['done', 'error', 'cancelled'] },
	ask_user_end: { status: ['answered', 'cancelled', 'expired'] },
	node_interaction_end: { status: ['submitted', 'skipped'] },
	collect_variables_end: { status: ['submitted', 'skipped'] },
	execution_end: { status: ['completed', 'failed', 'cancelled'] },
});

export type TraceViolationReason = 'missing' | 'wrong-type' | 'bad-enum';

export interface ITraceViolation {
	readonly kind: string;
	readonly field: string;
	readonly reason: TraceViolationReason;
	/** 人类可读说明（日志用）。 */
	readonly detail: string;
}

export interface ITraceValidationResult {
	readonly ok: boolean;
	/** 发送端使用了消费端未知的 kind（契约漂移信号）。 */
	readonly unknownKind: boolean;
	readonly violations: ReadonlyArray<ITraceViolation>;
	/** 去重用的短签名（同 kind 同字段同原因只报一次）。 */
	readonly signature: string;
}

function typeOfValue(v: unknown): 'string' | 'number' | 'array' | 'object' | 'other' {
	if (typeof v === 'string') { return 'string'; }
	if (typeof v === 'number') { return 'number'; }
	if (Array.isArray(v)) { return 'array'; }
	if (v && typeof v === 'object') { return 'object'; }
	return 'other';
}

/**
 * 校验一条 trace 事件。**永不抛出**；未知 kind 与字段违规都通过返回值表达。
 * `trace` 为 `undefined`/非对象时按未知 kind 处理（发送端漏传）。
 */
export function validateWorkflowTrace(trace: unknown): ITraceValidationResult {
	const t = (trace ?? {}) as Record<string, unknown>;
	const kind = typeof t['kind'] === 'string' ? (t['kind'] as string) : '';
	const required = TRACE_REQUIRED_FIELDS[kind];

	if (!required) {
		const v: ITraceViolation = {
			kind: kind || '(missing)',
			field: 'kind',
			reason: 'missing',
			detail: kind
				? `未知 trace kind '${kind}'（发送端新增但契约表未登记）`
				: 'trace.kind 缺失或非字符串',
		};
		return { ok: false, unknownKind: true, violations: [v], signature: `unknown:${kind || '(missing)'}` };
	}

	const violations: ITraceViolation[] = [];

	for (const field of required) {
		const val = t[field];
		if (val === undefined || val === null) {
			violations.push({ kind, field, reason: 'missing', detail: `必填字段缺失: ${field}` });
		}
	}

	const types = TRACE_FIELD_TYPES[kind] ?? {};
	for (const [field, want] of Object.entries(types)) {
		const val = t[field];
		if (val === undefined || val === null) { continue; } // missing 已在上面报过
		const got = typeOfValue(val);
		if (got !== want) {
			violations.push({ kind, field, reason: 'wrong-type', detail: `字段 ${field} 期望 ${want}，实际 ${got}` });
		}
	}

	const enums = TRACE_ENUM_FIELDS[kind] ?? {};
	for (const [field, allowed] of Object.entries(enums)) {
		const val = t[field];
		if (typeof val !== 'string') { continue; }
		if (!allowed.includes(val)) {
			violations.push({
				kind, field, reason: 'bad-enum',
				detail: `字段 ${field}='${val}' 不在允许值 [${allowed.join(', ')}] 内`,
			});
		}
	}

	const signature = violations.length === 0
		? ''
		: `${kind}:${violations.map(x => `${x.field}/${x.reason}`).sort().join(',')}`;

	return { ok: violations.length === 0, unknownKind: false, violations, signature };
}
