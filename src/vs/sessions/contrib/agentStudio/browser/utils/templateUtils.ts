/*---------------------------------------------------------------------------------------------
 *  Agent Studio Host - Template Variable Utilities
 *  Runtime side of the {{variable}} system (Mustache-style double-brace identifiers).
 *
 *  ★ 2026-09-11 更正：原文写「Mirrors the webview `utils/templateUtils.ts`」已过时 ——
 *    webview 侧那份现位于 `webview/src/features/workflowEditor/utils/templateUtils.ts`，
 *    且是**纯词法工具**（`extractVariables`/`substituteVariables`，不识别任何内置变量），
 *    与本文件的语义（内置变量表 + 分层取值 + 共享内存命名空间）不是镜像关系。
 *    不要照它改本文件，反之亦然。
 *
 *  Used by `WorkflowExecutionService` to substitute node data.prompt
 *  values just before sending them to an agent. Variable sources:
 *    1. executionState.context  (taskTitle / taskDescription / ...)
 *    2. data.variables           (per-node static values, cc-wf-studio parity)
 *    3. upstream node outputs    (key: <nodeId>.output, plus the special
 *                                 `$prev` alias for the most recent node)
 *
 *  Variable name regex: `\$?\w+(?:\.\w+)*` — supports both `{{$prev}}` and
 *  the suffixed forms `{{$prev.output}}` / `{{nodeId.output}}` / `{{nodeId}}`
 *  in a single match. The `.output` suffix is treated as a "field accessor"
 *  but the lookup logic also tries the unsuffixed name, so users can write
 *  `{{myNode}}` instead of `{{myNode.output}}` interchangeably.
 *--------------------------------------------------------------------------------------------*/

// v23: was `/\{\{(\$?\w+)\}\}/g` which rejected `.` — the regex would stop
// at `$prev` in `{{$prev.output}}` and leave `.output}}` as literal
// characters in the output, breaking runtime substitution of upstream
// node outputs. The new pattern `(?:\.\w+)*` allows 0+ `.field` suffixes
// per variable. The `.output` part is just the convention we picked for
// accessing an upstream node's stored output (`nodeState.output`); the
// `buildRuntimeValueMap` layer also adds the bare nodeId key, so a
// missing suffix still resolves correctly.
export const HOST_VARIABLE_PATTERN = /\{\{(\$?[\w-]+(?:\.[\w-]+)*)\}\}/g;

/**
 * 共享内存变量的命名空间前缀：`{{shared.<key>}}`。
 *
 * ★ 为什么加前缀而不是直接裸键：裸键会与「运行上下文」（`executionState.context` 的键，
 *   如 `taskTitle`）和「上游节点 id」抢同一个命名空间 —— 节点 id 是自动生成的 uid，
 *   用户键名撞上它就变成静默串值。加前缀后三方命名空间互不干扰，语义也无歧义：
 *   `shared.*` **永远**指共享内存。
 */
export const SHARED_VAR_PREFIX = 'shared.';

/**
 * 用与 `{{var}}` 替换**同一份**正则做整串判定（避免另写一份字符集规则后漂移）。
 * 非全局正则 → 无 `lastIndex` 状态坑。
 */
const SHARED_KEY_PROBE = new RegExp(`^(?:${HOST_VARIABLE_PATTERN.source})$`);

/**
 * 候选键能否被真正替换为 `{{shared.<key>}}`。
 * 不满足时**必须丢弃**：否则会写进共享内存却永远替换不出来（静默失效）。
 * 例：`verdict` / `plan-v2` / `a.b` 通过；`我的裁决`（非 ASCII）与 `has space` 不通过。
 */
export function isSubstitutableSharedKey(key: string): boolean {
	if (!key) { return false; }
	return SHARED_KEY_PROBE.test(`{{${SHARED_VAR_PREFIX}${key}}}`);
}

/**
 * 解析节点声明的「语义发布键」`data.publishes`。
 * 接受三种形态（节点 data 可能来自手改 JSON / LLM 生成 / 弹窗表单）：
 *   - 字符串数组：`["verdict", "plan"]`
 *   - 单个键：`"verdict"`
 *   - **逗号分隔**（弹窗表单是单行文本框，最自然的写法）：`"verdict, plan"`
 *     ⚠ 只按**逗号**切分，不按空白 —— 空白切分会让 `"has space"` 变成两个「合法」键，
 *       掩盖「键名不能含空格」这一事实（那种键根本替换不出来）。
 * 归一：trim、去重、**丢弃无法被 `{{shared.<key>}}` 替换的键**（见 `isSubstitutableSharedKey`）。
 */
export function parseSharedPublishKeys(raw: unknown): string[] {
	const list: unknown[] = typeof raw === 'string'
		? raw.split(',')
		: Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	for (const item of list) {
		if (typeof item !== 'string') { continue; }
		const key = item.trim();
		if (!isSubstitutableSharedKey(key)) { continue; }
		if (!out.includes(key)) { out.push(key); }
	}
	return out;
}

/** Built-in variable names that are auto-populated at runtime — never ask the user. */
const BUILTIN_VAR_NAMES: ReadonlySet<string> = new Set([
	'taskDescription',
	'taskTitle',
	'workflowName',
	'workflowDescription',
	'input',
	'firstInput',
	'$prev',
	'$prev.output',
	'$preNode',
	'$preNode.output',
]);

/**
 * Decide whether a captured variable name is a built-in (auto-resolved
 * by the runtime value map) or one the user must supply via the variable
 * collection card.
 */
function isBuiltinVarName(name: string): boolean {
	if (BUILTIN_VAR_NAMES.has(name)) { return true; }
	// ★ 共享内存命名空间（`shared.<key>`）：运行时由 `executionState.sharedMemory` 解析
	//   → 不得当作「需要用户填写」的变量（2026-09-11，与 `{{shared.<key>}}` 读路径配套）。
	if (name.startsWith(SHARED_VAR_PREFIX)) { return true; }
	// Anything starting with `$` is a reserved runtime alias (e.g. `$prev`).
	if (name.startsWith('$')) { return true; }
	return false;
}

/** Extract the set of variable names referenced in a template that need user input. */
export function extractHostVariables(text: string): string[] {
	if (!text) { return []; }
	const matches = text.matchAll(HOST_VARIABLE_PATTERN);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of matches) {
		const name = m[1];
		if (isBuiltinVarName(name)) { continue; }
		if (!seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/** Substitutes values. Undefined variables are preserved as `{{name}}`. */
export function substituteHostVariables(
	text: string,
	values: Record<string, string>,
): string {
	if (!text) { return text ?? ''; }
	return text.replace(HOST_VARIABLE_PATTERN, (match, varName: string) => {
		const v = values[varName];
		return v !== undefined ? v : match;
	});
}

/** List of variable names in `text` that have no entry in `values`. */
export function getUndefinedHostVariables(
	text: string,
	values: Record<string, string>,
): string[] {
	return extractHostVariables(text).filter(v => !(v in values));
}

/**
 * Build the runtime value map for a single node execution.
 *
 * Layered (later wins, but the lookup is single-key so order is informational):
 *   1. executionState.context  (e.g. taskTitle, taskDescription, taskConsumed flag)
 *   2. data.variables          (per-node static value overrides)
 *   3. upstream node outputs   (key: <nodeId>.output, plus `$prev` for last)
 *   4. workflow name           (`workflowName`)
 *
 * `consumed` is a special token: when the first consuming node already
 * received `taskDescription`, the context flag is set and the value is
 * hidden from later nodes (see workflowExecutionService v10).
 */
export function buildRuntimeValueMap(args: {
	context: Record<string, unknown> | undefined;
	nodeVariables: Record<string, string> | undefined;
	upstreamOutputs: Record<string, string> | undefined;
	workflowName: string;
	/**
	 * ★ 共享内存（2026-09-11 补）：`executionState.sharedMemory`。
	 * 暴露为 `{{shared.<key>}}`（命名空间隔离，见 `SHARED_VAR_PREFIX`）。
	 * 此前 sharedMemory **只写不读**（全服务无消费点）→ 文档承诺的
	 * 「Agent 间共享、所有节点可见」从未生效。
	 */
	sharedMemory?: ReadonlyMap<string, string> | undefined;
}): Record<string, string> {
	const values: Record<string, string> = {};
	const ctx = args.context ?? {};

	// Layer 1: execution context. Skip the consumed taskDescription once a
	// downstream node has taken it (workflowExecutionService v10 behaviour).
	const consumed = Boolean(ctx['_taskConsumed']);
	for (const [k, v] of Object.entries(ctx)) {
		if (k.startsWith('_')) { continue; } // internal flag (e.g. _taskConsumed)
		if (consumed && k === 'taskDescription') { continue; }
		if (typeof v === 'string') {
			values[k] = v;
		} else if (v !== undefined && v !== null) {
			values[k] = String(v);
		}
	}
	// v22: `input` is no longer aliased to `taskDescription`. With the new
	// pre-execution variable collection card, `{{input}}` is always collected
	// from the user (host substitutes the value into `data.prompt` BEFORE
	// node executors run), so the runtime layer doesn't need to resolve it
	// here. The previous auto-alias caused a confusing double-source-of-truth
	// (chat message OR user-typed-in-card) and silently produced empty
	// prompts when the user clicked Run in the workflow editor without
	// typing in chat. Kept `taskDescription` in the value map for back-compat
	// (e.g. custom {{taskDescription}} references in advanced users' prompts).

	// Layer 2: per-node static values (cc-wf-studio `data.variables`).
	if (args.nodeVariables) {
		for (const [k, v] of Object.entries(args.nodeVariables)) {
			values[k] = v;
		}
	}

	// Layer 3: upstream node outputs. Keys: <nodeId>.output and `$prev` alias
	// (the most recent upstream node's output).
	if (args.upstreamOutputs) {
		// Strip the `.output` suffix for direct lookup (so {{myNode}} also works).
		for (const [nodeId, out] of Object.entries(args.upstreamOutputs)) {
			values[`${nodeId}.output`] = out;
			values[nodeId] = out;
		}
		// `$prev` = most recent upstream (already a flattened string).
		const lastId = Object.keys(args.upstreamOutputs).pop();
		if (lastId) {
			const lastOut = args.upstreamOutputs[lastId];
			values['$prev'] = lastOut;
			values['$prev.output'] = lastOut;
		}
	}

	// Layer 3.5: 共享内存（`{{shared.<key>}}`）。命名空间独立 → 不会与上面三层抢键；
	// 放在上游产出之后，保证 `shared.*` 永远指共享内存（可预测）。
	if (args.sharedMemory) {
		for (const [key, value] of args.sharedMemory) {
			values[`${SHARED_VAR_PREFIX}${key}`] = value;
		}
	}

	// Layer 4: workflow metadata.
	values['workflowName'] = args.workflowName;

	return values;
}

/**
 * Scan an entire workflow graph for `{{variable}}` references that the user must supply.
 *
 * This is the pure-function counterpart of `WorkflowExecutionService._collectTemplateVariables`:
 * it scans every node's `data.prompt`, `data.skillArgs`, and `data.toolParams`, dedupes by name,
 * and skips built-in / auto-resolved names. Unlike the runtime `extractHostVariables` (which is
 * per-string and strips `input` via BUILTIN_VAR_NAMES), this function mirrors the host's variable
 * collection semantics exactly — it DOES include `{{input}}` (the chat text) so the caller (the
 * composer parameter form) can decide whether to surface it or hide it (chat mode supplies
 * `input` from the message body instead of the form).
 *
 * Zero-dependency (structural node type only) so it can be imported from unit tests directly.
 */
export function collectWorkflowVariables(
	nodes: ReadonlyArray<{ data?: Record<string, unknown> }> | undefined,
): Array<{ name: string; defaultValue: string }> {
	const seen = new Set<string>();
	const vars: Array<{ name: string; defaultValue: string }> = [];
	// ★ 与替换侧**同一份**正则（原为 `/\{\{(\$?\w+)\}\}/g` —— 双真源漂移：该旧正则不认
	//   连字符，`{{my-var}}` 既不进参数表、也替换不出来，静默失效）。
	const regex = HOST_VARIABLE_PATTERN;

	// Mirrors workflowExecutionService._collectTemplateVariables isBuiltin.
	// NOTE: `input` / `firstInput` is intentionally NOT builtin here — see doc comment above.
	const isBuiltin = (n: string) => BUILTIN_VAR_NAMES.has(n) && n !== 'input' && n !== 'firstInput';

	const scan = (text: string) => {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const name = match[1];
			if (isBuiltin(name)) { continue; }
			// ★ 点分名 = **字段访问器**（`<nodeId>.output`、`$prev.output`、`shared.<key>`）
			//   → 不是用户变量，必须显式排除。原实现是靠「旧正则不匹配点分名」**意外**实现的；
			//   改用统一正则后若不显式排除，参数表单会去问用户「nodeA.output 填什么」。
			if (name.includes('.')) { continue; }
			if (name.startsWith('$')) { continue; } // any other $-prefixed alias
			if (!seen.has(name)) {
				seen.add(name);
				vars.push({ name, defaultValue: '' });
			}
		}
	};

	for (const node of nodes ?? []) {
		const data = node.data ?? {};
		if (typeof data.prompt === 'string') { scan(data.prompt); }
		if (data.skillArgs && typeof data.skillArgs === 'object') {
			for (const value of Object.values(data.skillArgs)) {
				if (typeof value === 'string') { scan(value); }
			}
		}
		if (data.toolParams && typeof data.toolParams === 'object') {
			for (const value of Object.values(data.toolParams)) {
				if (typeof value === 'string') { scan(value); }
			}
		}
	}

	return vars;
}
