/*---------------------------------------------------------------------------------------------
 *  canvasExport — M4a 画布 → 动态工作流脚本导出（纯生成器，单向不回写）。
 *
 *  输入画布 nodes/edges，按 buildParallelExecutionPlan 的波次拓扑生成
 *  workflow 工具的 { meta, script } 起点：
 *   - 波次层内多节点 → parallel([...])；单节点 → 顺序语句
 *   - Saros.Agent → agent(prompt, {label, agentId})；prompt 模板的 {{input}}
 *     替换为上游变量的 JS 模板字符串插值（${varName}）
 *   - Saros.Prompt → 文本字面量（{{input}} 同上插值）
 *   - Saros.IfElse/Switch → Boolean(上游?.路径) 判定表达式
 *   - Saros.IfElse 的独占子树 → if/else 块（产物变量块外 let 提升）
 *   - 媒体/Comfy 节点 → await stage(UID.x)（真正驱动 ComfyUI 执行）
 *   - 上游缺失/被跳过 → null + warning（fail-loud 语义进 warnings，不静默）
 *
 *  ★ 可读性契约（2026-08-19 重构）：画布是「二维带标签图」，脚本是「一维语句流」，
 *  转换必须保住图的两类信息，否则产物只是能跑的乱码：
 *   1. 身份 —— 变量名取自节点 label/agentId（非 ASCII 回退类型缩写，如 image/reply/
 *      verdict），不再是 n1..nN；每条语句尾随 `// <label> · <type>` 注释；
 *      stage uid 收进头部 UID 映射表（正文只见 UID.image，换画布只改一处）。
 *   2. 关系 —— 头部拓扑摘要（含分支树）、多上游节点的 `// ← a, b` 注释、
 *      按波次自动生成的 phase() 进度分组。
 *  另：变量名按**输出顺序**分配（分支块会重排语句 → 层序编号会跳号）；
 *  return 只吐叶子节点（出度 0），中间量不再倾泻。
 *
 *  产物是「可编辑起点」：导给 Chat 后模型/用户可加 for 扇出等动态能力。
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §5.3 M4a。
 *--------------------------------------------------------------------------------------------*/

import { buildParallelExecutionPlan, type ExecutionEdgeLike, type ExecutionNodeLike } from './executionGraph';

// 类型判定与 workflowRun.ts 同源（字符串比较内联，避免拖入其重运行时依赖）。
// ★ P1 后节点 type 统一为命名空间形态（`Saros.*`）：palette 直接产出、
//   loadWorkflow 对旧持久化数据做 normalizeNodeType 迁移。此处只需认命名空间。
const isAgentNodeType = (type: string): boolean => type === 'Saros.Agent';
const isPromptNodeType = (type: string): boolean => type === 'Saros.Prompt';
const isGateNodeType = (type: string): boolean => type === 'Saros.IfElse' || type === 'Saros.Switch';
/** 编排节点 = 脚本域原生表达；其余 exportable 节点 = 画布域（经 stage 执行）。 */
const isOrchestrationNodeType = (type: string): boolean =>
	isAgentNodeType(type) || isPromptNodeType(type) || isGateNodeType(type);

export interface CanvasExportInput {
	readonly nodes: ExecutionNodeLike[];
	readonly edges: ExecutionEdgeLike[];
	/** widget 值（prompt/agentId/label 等）。 */
	readonly getNodeValue: (nodeId: string) => Record<string, unknown>;
	readonly workflowName?: string;
	/**
	 * nodeId → 画布稳定 uid（节点 __sarosId）。P0：媒体节点导出为
	 * `await stage(UID.x)`（真正驱动 ComfyUI 执行），而非 null 占位。
	 * 缺省/查不到 uid 时回退 null 占位 + warning（保持旧行为，fail-loud 提示）。
	 */
	readonly getStageUid?: (nodeId: string) => string | undefined;
}

export interface CanvasExportResult {
	readonly meta: { name: string; description: string };
	/** body-only（workflow 工具契约：hooks 由引擎注入为全局，脚本禁止 import/export）。 */
	readonly script: string;
	/**
	 * 自包含展示形态（代码投影视图用）：meta 头 + hooks 说明 + `async function run()`
	 * 无参签名（表达「hooks 是全局标识符而非参数」）+ 缩进 body。
	 * 函数体与 script 逐字一致 —— 复制 { } 之间的内容即可作为工具 script 参数。
	 */
	readonly displayScript: string;
	/**
	 * 行锚点：displayScript 的 1-based 行号 → 画布 nodeId。
	 * `kind`：'decl' = 该节点的产物声明行（反向定位应优先跳这里）；
	 *        'ref'  = 引用行（UID 表条目、gate 的 if/else 行）。
	 *
	 * ★ 刻意**不**写成脚本里的 `// @saros-node <id>` 注释 —— 那会把每个节点的
	 * 内部 id 塞进发往 LLM 的 script（纯噪音 + 白烧 token），而 UI 需要的只是
	 * 「点第 N 行 → 高亮哪个节点」这一映射。身份信息已由 `// label · type`
	 * 注释承担，锚点走带外通道。
	 */
	readonly anchors: ReadonlyArray<{ readonly line: number; readonly nodeId: string; readonly kind: 'decl' | 'ref' }>;
	readonly warnings: string[];
}

function kebab(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'canvas-export';
}

// ── 标识符工具（语义变量名的基础）────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 不可用作节点变量名的标识符：JS 保留字 + 引擎注入的 hooks + 生成器自用符号。
 * 命中则加 `Node` 后缀 —— 否则节点变量会**遮蔽 hook**（`const agent = …` 之后
 * 再调 `agent()` 直接 TypeError），是最隐蔽的一类生成器 bug。
 */
const RESERVED_IDENTS = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
	'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
	'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
	'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
	'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'await',
	// 引擎注入的 hooks（workflowWorkerMain.source.ts 的 __wfHooks）
	'agent', 'parallel', 'pipeline', 'phase', 'log', 'nodeOutput', 'stage', 'args',
	// 生成器自用
	'UID', 'run', 'asData',
]);

/**
 * 自由文本 → lowerCamel ASCII 标识符；无可用 ASCII 字符时 undefined。
 * 已是驼峰的输入保留内部大小写（'RedrawNote' → 'redrawNote'，不是 'redrawnote'）；
 * 全大写段视为缩写降级（'API Key' → 'apiKey'）。
 */
function identFromText(text: string): string | undefined {
	const parts = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) { return undefined; }
	const norm = (p: string): string => /^[A-Z0-9]+$/.test(p) ? p.toLowerCase() : p;
	const head = norm(parts[0]);
	const camel = head.charAt(0).toLowerCase() + head.slice(1)
		+ parts.slice(1).map(p => { const n = norm(p); return n.charAt(0).toUpperCase() + n.slice(1); }).join('');
	const cleaned = camel.replace(/^[0-9]+/, '');
	return IDENT_RE.test(cleaned) ? cleaned : undefined;
}

/** 类型 → 语义缩写（ComfyTV.ImageStage → image / Saros.Agent → reply / gate → verdict）。 */
function identFromType(type: string): string {
	if (isGateNodeType(type)) { return 'verdict'; }
	if (isPromptNodeType(type)) { return 'text'; }
	if (isAgentNodeType(type)) { return 'reply'; }
	const last = type.split('.').pop() ?? '';
	return identFromText(last.replace(/Stage$/, '').replace(/Node$/, '')) ?? 'node';
}

/** 唯一化分配器：首个用裸 base，重复者 base2/base3…（编号按调用顺序 = 输出顺序）。 */
function createNamer(): (candidates: Array<string | undefined>, type: string) => string {
	const taken = new Set<string>();
	return (candidates, type) => {
		let base = candidates.find(c => c !== undefined && c !== '') ?? identFromType(type);
		if (RESERVED_IDENTS.has(base)) { base = `${base}Node`; }
		let name = base;
		for (let i = 2; taken.has(name); i++) { name = `${base}${i}`; }
		taken.add(name);
		return name;
	};
}

/** 点路径 → optional chaining（合法标识符用点号，其余回退方括号）。 */
function accessPath(base: string, dotted: string): string {
	return dotted.split('.').filter(Boolean).reduce(
		(acc, seg) => IDENT_RE.test(seg) ? `${acc}?.${seg}` : `${acc}?.[${JSON.stringify(seg)}]`,
		base,
	);
}

/**
 * prompt 模板 → JS 表达式。
 * 占位符支持（W1/W4 输入契约）：
 *   - `{{input}}`     → `${upstreamVar}`（第一上游变量插值；上游不可用保留原样）
 *   - `{{args.key}}`  → `${args.key}`（Start 节点输入契约，点路径直接引用）
 * 无占位符 → 纯字符串字面量（JSON.stringify）。
 *
 * ★ 转义顺序关键：先转义 template 字面量特殊字符（\ ` $），**再**替换占位符
 * 插入 `${...}` —— 插入的 `${` 是后续新字符，不会被前序 `$` 转义命中（否则
 * 插值语法的 `$` 被转义成 `\$`，运行时输出字面量 `${args.key}` 而非取值）。
 */
function promptLiteral(template: string, upstreamVar: string | undefined): string {
	const hasInput = template.includes('{{input}}');
	const hasArgs = /\{\{args\./.test(template);
	if (!hasInput && !hasArgs) {
		return JSON.stringify(template);
	}
	// 整段纯 {{input}} → 直接返回上游变量（旧语义：不做无意义模板包裹）
	if (template === '{{input}}' && upstreamVar) {
		return upstreamVar;
	}
	// 1. 先转义字面量特殊字符（此时 template 只有 {{...}}，无 ${...}）
	let out = template
		.replace(/\\/g, '\\\\')
		.replace(/`/g, '\\`')
		.replace(/\$/g, '\\$');
	// 2. 再替换占位符 → 插值语法（新插入的 ${...} 不受步骤 1 转义影响）
	if (hasArgs) {
		out = out.replace(/\{\{args\.([A-Za-z0-9_.]+)\}\}/g, '${args.$1}');
	}
	if (hasInput && upstreamVar) {
		out = out.replace(/\{\{input\}\}/g, '${' + upstreamVar + '}');
	}
	// 仍有未替换占位符（如 {{input}} 但上游不可用 / 未知占位符）→ 回退字面量，
	// 保留原样由模型/用户后续修正（warning 由调用方记录）。
	if (out.includes('{{')) {
		return JSON.stringify(template);
	}
	return '`' + out + '`';
}

/**
 * 生成动态工作流脚本。cycles → 直接报错（脚本无法表达）。
 */
export function exportCanvasToWorkflowScript(input: CanvasExportInput): CanvasExportResult {
	const { nodes, edges, getNodeValue, getStageUid } = input;
	const warnings: string[] = [];
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const typeOf = (id: string): string => nodeById.get(id)?.type ?? '';
	/** 原始 label（无兜底）—— 变量名/摘要取名用，避免把 type 串当成 label。 */
	const rawLabelOf = (id: string): string => {
		const n = nodeById.get(id) as { data?: { label?: string } } | undefined;
		return (n?.data?.label && String(n.data.label).trim()) || '';
	};
	/** 展示用 label（注释 / agent 的 label 选项）。 */
	const labelOf = (id: string): string => rawLabelOf(id) || typeOf(id) || id;
	const isExportable = (type: string): boolean =>
		isOrchestrationNodeType(type) || type.startsWith('ComfyTV.') || type.startsWith('Comfy.');

	const plan = buildParallelExecutionPlan(nodes, edges, isExportable);
	if (plan.hasCycle) {
		throw new Error('画布包含环，无法导出为脚本（动态工作流按 DAG 拓扑执行）');
	}

	type Step = { id: string; type: string; upstreams: string[] };
	const steps: Step[] = plan.layers.flat();
	const stepById = new Map(steps.map(s => [s.id, s]));
	const topoIndex = new Map(steps.map((s, i) => [s.id, i]));

	// ── W2b 结构化导出：IfElse 分支子树拆分 ─────────────────────────────
	// 对每个 IfElse：T = 仅经 true 端口可达、F = 仅经 false 端口可达的子树。
	// 拆分条件（否则回退 verdict 平铺 + warning）：子树内不含其他 gate（嵌套 v1 不支持）。
	const reachFrom = (gateId: string, port: string): Set<string> => {
		const seen = new Set<string>();
		const queue: string[] = [];
		for (const e of edges) {
			if (e.source !== gateId) { continue; }
			// 无 handle 出边 = always-active → 两分支公共（差集自动排除）
			if (e.sourceHandle !== undefined && e.sourceHandle !== '' && e.sourceHandle !== port) { continue; }
			if (!seen.has(e.target)) { seen.add(e.target); queue.push(e.target); }
		}
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const e of edges) {
				if (e.source === cur && !seen.has(e.target)) { seen.add(e.target); queue.push(e.target); }
			}
		}
		return seen;
	};
	const allGateIds = new Set(steps.filter(s => isGateNodeType(s.type)).map(s => s.id));
	interface BranchPlan { readonly gateId: string; readonly trueIds: string[]; readonly falseIds: string[] }
	const branchPlans = new Map<string, BranchPlan>();
	const branchNodeIds = new Set<string>();
	const byTopo = (ids: string[]): string[] => [...ids].sort((a, b) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0));
	for (const g of steps.filter(s => s.type === 'Saros.IfElse')) {
		const t = reachFrom(g.id, 'true');
		const f = reachFrom(g.id, 'false');
		if ([...t, ...f].some(id => id !== g.id && allGateIds.has(id))) {
			warnings.push(`IfElse「${labelOf(g.id)}」的分支子树包含其他判定节点（嵌套）——保持 verdict 平铺`);
			continue;
		}
		const onlyT = byTopo([...t].filter(id => !f.has(id) && id !== g.id && stepById.has(id)));
		const onlyF = byTopo([...f].filter(id => !t.has(id) && id !== g.id && stepById.has(id)));
		if (onlyT.length === 0 && onlyF.length === 0) { continue; }
		branchPlans.set(g.id, { gateId: g.id, trueIds: onlyT, falseIds: onlyF });
		for (const id of [...onlyT, ...onlyF]) { branchNodeIds.add(id); }
	}
	if (branchNodeIds.size > 0) {
		warnings.push('分支子树内节点导出为 if/else 块内串行执行（画布并行语义不保留）');
	}

	// ── 输出计划：决定语句顺序 ───────────────────────────────────────────
	// 变量名必须按**输出顺序**分配 —— 分支块把子树节点从各自波次抽出重排，
	// 若按层序编号会出现 n7/n9/n8 跳号（旧形态的可读性杀手之一）。
	type Emit =
		| { readonly kind: 'single'; readonly step: Step }
		| { readonly kind: 'parallel'; readonly steps: Step[] }
		| { readonly kind: 'branch'; readonly branch: BranchPlan };
	const emits: Emit[] = [];
	for (const layer of plan.layers) {
		const mainSteps = layer.filter(s => !branchNodeIds.has(s.id));
		if (mainSteps.length === 1) {
			emits.push({ kind: 'single', step: mainSteps[0] });
		} else if (mainSteps.length > 1) {
			emits.push({ kind: 'parallel', steps: mainSteps });
		}
		// 本波次内的 IfElse gate → 紧随输出其分支块
		for (const s of layer) {
			const branch = branchPlans.get(s.id);
			if (branch) { emits.push({ kind: 'branch', branch }); }
		}
	}

	// ── 变量名分配（语义优先：label → agentId → 类型缩写）────────────────
	const namer = createNamer();
	const varOf = new Map<string, string>();
	const assign = (step: Step): void => {
		const values = getNodeValue(step.id) ?? {};
		const agentId = isAgentNodeType(step.type) && typeof values.agentId === 'string' ? values.agentId : '';
		varOf.set(step.id, namer([identFromText(rawLabelOf(step.id)), identFromText(agentId)], step.type));
	};
	/** 分支块内产物 → 需要块外 let 提升（否则块作用域逃逸，return 引用即 ReferenceError）。 */
	const hoistedIds: string[] = [];
	for (const e of emits) {
		if (e.kind === 'single') {
			assign(e.step);
		} else if (e.kind === 'parallel') {
			for (const s of e.steps) { assign(s); }
		} else {
			for (const id of [...e.branch.trueIds, ...e.branch.falseIds]) {
				const s = stepById.get(id);
				if (!s) { continue; }
				assign(s);
				hoistedIds.push(id);
			}
		}
	}

	// ── stage uid 映射表（正文只见 UID.x；换画布只改这一处）────────────────
	const stageUidOf = new Map<string, string>();
	for (const s of steps) {
		if (isOrchestrationNodeType(s.type)) { continue; }
		const uid = getStageUid?.(s.id);
		if (uid) { stageUidOf.set(s.id, uid); }
	}

	/**
	 * 数据上游变量：**穿透 gate**。gate 是控制流节点，其变量是 Boolean 判定值 ——
	 * 下游若插值 gate 变量会得到 "true"/"false" 而非真实数据（旧形态的语义 bug）。
	 */
	const dataUpstreamVar = (step: Step, seen = new Set<string>()): string | undefined => {
		for (const up of step.upstreams) {
			if (seen.has(up)) { continue; }
			seen.add(up);
			const upStep = stepById.get(up);
			if (upStep && isGateNodeType(upStep.type)) {
				const through = dataUpstreamVar(upStep, seen);
				if (through !== undefined) { return through; }
				continue;
			}
			const v = varOf.get(up);
			if (v !== undefined) { return v; }
		}
		return undefined;
	};

	// ── 单节点表达式生成 ───────────────────────────────────────────────
	/** 是否需要 asData 文本兜底 helper（存在「带取值路径且有上游」的 gate）。 */
	const needsAsDataHelper = steps.some(s => {
		if (!isGateNodeType(s.type)) { return false; }
		const t = (getNodeValue(s.id) ?? {}).evaluationTarget;
		return typeof t === 'string' && t.trim() !== '' && dataUpstreamVar(s) !== undefined;
	});
	interface Emitted { readonly step: Step; readonly expr: string; readonly note?: string }
	const emitExpr = (step: Step): Emitted => {
		const values = getNodeValue(step.id) ?? {};
		const upVar = dataUpstreamVar(step);
		if (isAgentNodeType(step.type)) {
			const prompt = typeof values.prompt === 'string' ? values.prompt : '';
			if (!prompt.trim()) {
				warnings.push(`节点「${labelOf(step.id)}」(${step.id}) 缺少提示词——导出为 null，请补 prompt`);
				return { step, expr: 'null', note: '缺少 prompt' };
			}
			const lit = promptLiteral(prompt, upVar);
			if (upVar === undefined && prompt.includes('{{input}}')) {
				warnings.push(`Agent 节点「${labelOf(step.id)}」的 {{input}} 无可用上游变量`);
			}
			const opts: string[] = [`label: ${JSON.stringify(labelOf(step.id).slice(0, 48))}`];
			const agentId = typeof values.agentId === 'string' && values.agentId.trim() ? values.agentId.trim() : '';
			if (agentId) { opts.push(`agentId: ${JSON.stringify(agentId)}`); }
			// ★ expr 不带 await：agent() 本身返回 Promise——parallel thunk 是普通零参函数，
			//   非 async 箭头体内 await 非法（"Unexpected identifier"）；顺序语句外加 await。
			return { step, expr: `agent(${lit}, { ${opts.join(', ')} })` };
		}
		if (isPromptNodeType(step.type)) {
			const text = typeof values.prompt === 'string' ? values.prompt : '';
			if (!text.trim()) {
				warnings.push(`Prompt 节点「${labelOf(step.id)}」为空——导出为空串`);
				return { step, expr: "''" };
			}
			return { step, expr: promptLiteral(text, upVar) };
		}
		if (isGateNodeType(step.type)) {
			const target = typeof values.evaluationTarget === 'string' ? values.evaluationTarget.trim() : '';
			if (!upVar) {
				warnings.push(`判定节点「${labelOf(step.id)}」无上游——导出 false`);
				return { step, expr: 'false', note: '无上游' };
			}
			// ★ 上游 Agent 导出时不带 schema（画布节点无 schema 配置）→ 其结果是**纯文本**。
			//   直接 `upVar?.a?.b` 恒为 undefined → 判定恒 false（所有 IfElse 静默走假分支）。
			//   asData() 先按 JSON 解析文本再取路径，兼容 structured / 文本两种上游。
			return {
				step,
				expr: `Boolean(${target ? accessPath(`asData(${upVar})`, target) : upVar})`,
				note: `判定：${target || '(整体)'}`,
			};
		}
		// ── 媒体/Comfy 节点 → await stage(UID.x)（真正驱动 ComfyUI 执行）──
		const uid = stageUidOf.get(step.id);
		if (uid) {
			return { step, expr: `stage(UID.${varOf.get(step.id)})` };
		}
		warnings.push(`媒体节点「${labelOf(step.id)}」无画布 uid —— 导出为 null 占位（脚本无法驱动其执行）`);
		return { step, expr: 'null', note: '无画布 uid，脚本无法驱动执行（可经 nodeOutput 读旧快照）' };
	};

	/** 返回 Promise 的表达式需要 await（agent 子代理 / stage 画布节点执行）。 */
	const needsAwait = (expr: string): boolean => expr.startsWith('agent(') || expr.startsWith('stage(');
	/** 耗时节点（决定是否值得生成 phase 进度分组）。 */
	const isSlow = (step: Step): boolean => isAgentNodeType(step.type) || !isOrchestrationNodeType(step.type);
	/** 行尾身份注释：`// <label> · <type>` + 多上游时补 `← a, b`。 */
	const identityNote = (step: Step, extra?: string): string => {
		const ups = step.upstreams.map(u => varOf.get(u)).filter((v): v is string => v !== undefined);
		const parts = [`${labelOf(step.id)} · ${step.type}`];
		if (extra) { parts.push(extra); }
		if (ups.length > 1) { parts.push(`← ${ups.join(', ')}`); }
		return `  // ${parts.join(' · ')}`;
	};

	const lines: string[] = [];
	/** 与 lines 平行的归属表：该行由哪个画布节点产生（行锚点的数据源）。 */
	const lineOwners: Array<{ nodeId: string; kind: 'decl' | 'ref' } | undefined> = [];
	const push = (text: string, owner?: { nodeId: string; kind: 'decl' | 'ref' }): void => { lines.push(text); lineOwners.push(owner); };
	let lastPhase = '';
	const pushPhase = (title: string): void => {
		const t = title.trim();
		if (!t || t === lastPhase) { return; }
		lastPhase = t;
		push('');
		push(`phase(${JSON.stringify(t.slice(0, 48))});`);
	};
	const pushStatement = (e: Emitted, decl: 'const' | 'assign', indent: string): void => {
		const rhs = needsAwait(e.expr) ? `await ${e.expr}` : e.expr;
		const name = varOf.get(e.step.id)!;
		const lhs = decl === 'const' ? `const ${name}` : name;
		push(`${indent}${lhs} = ${rhs};${identityNote(e.step, e.note)}`, { nodeId: e.step.id, kind: 'decl' });
	};

	// ── 头部：UID 映射表 + 分支产物提升 ─────────────────────────────────
	if (stageUidOf.size > 0) {
		push('// 画布节点 uid（stage() 执行锚点；换画布只需改这张表）');
		push('const UID = {');
		for (const [id, uid] of stageUidOf) {
			push(`  ${varOf.get(id)}: ${JSON.stringify(uid)},${identityNote(stepById.get(id)!)}`, { nodeId: id, kind: 'ref' });
		}
		push('};');
	}
	if (needsAsDataHelper) {
		push('// 判定辅助：上游 Agent 无 schema 时返回纯文本 → 先按 JSON 解析再取路径');
		push('const asData = (v) => { if (typeof v !== "string") { return v; } try { return JSON.parse(v); } catch { return null; } };');
	}
	if (hoistedIds.length > 0) {
		push('// 分支产物：块外声明，未命中的分支保持 null（if 块内 const 会作用域逃逸）');
		push(`let ${hoistedIds.map(id => `${varOf.get(id)} = null`).join(', ')};`);
	}

	// ── 主体 ───────────────────────────────────────────────────────────
	for (const e of emits) {
		if (e.kind === 'single') {
			const emitted = emitExpr(e.step);
			if (isSlow(e.step)) { pushPhase(labelOf(e.step.id)); }
			pushStatement(emitted, 'const', '');
			continue;
		}
		if (e.kind === 'parallel') {
			const emittedList = e.steps.map(step => emitExpr(step));
			if (e.steps.some(isSlow)) { pushPhase(`并行：${e.steps.map(s => labelOf(s.id)).join(' ‖ ')}`); }
			push(`const [${emittedList.map(x => varOf.get(x.step.id)).join(', ')}] = await parallel([`);
			for (const x of emittedList) {
				push(`  () => ${x.expr},${identityNote(x.step, x.note)}`, { nodeId: x.step.id, kind: 'decl' });
			}
			push(']);');
			continue;
		}
		// 分支块：if/else 互斥形态（旧形态是两条独立 if，读者需自行推断互斥）
		const { gateId, trueIds, falseIds } = e.branch;
		const cond = varOf.get(gateId)!;
		const emitBlockBody = (ids: string[]): void => {
			for (const id of ids) {
				const s = stepById.get(id);
				if (!s) { continue; }
				pushStatement(emitExpr(s), 'assign', '  ');
			}
		};
		push('');
		if (trueIds.length > 0) {
			push(`if (${cond}) {  // ${labelOf(gateId)} → 是`, { nodeId: gateId, kind: 'ref' });
			emitBlockBody(trueIds);
			if (falseIds.length > 0) {
				push(`} else {  // ${labelOf(gateId)} → 否`, { nodeId: gateId, kind: 'ref' });
				emitBlockBody(falseIds);
			}
			push('}');
		} else {
			push(`if (!${cond}) {  // ${labelOf(gateId)} → 否`, { nodeId: gateId, kind: 'ref' });
			emitBlockBody(falseIds);
			push('}');
		}
	}

	// ── 返回值：只吐叶子（出度 0）产物，中间量不倾泻 ──────────────────────
	const hasDownstream = (id: string): boolean => edges.some(edge => edge.source === id && stepById.has(edge.target));
	const leafIds = new Set(steps.filter(s => !hasDownstream(s.id)).map(s => s.id));
	const returnIds = leafIds.size > 0 ? leafIds : new Set(steps.map(s => s.id));
	// 按**声明顺序**输出（varOf 的插入顺序 = 语句输出顺序），不用层序 —— 否则
	// return 里的字段顺序与上文声明顺序不一致，读者要来回找。
	const returnVars = [...varOf.entries()].filter(([id]) => returnIds.has(id)).map(([, v]) => v);
	push('');
	if (returnVars.length > 0) {
		push(`// 叶子节点产物（${leafIds.size > 0 ? '出度为 0 的终端节点' : '无叶子 → 全部变量'}；分支未命中者为 null）`);
		push(`return { ${returnVars.join(', ')} };`);
	} else {
		push('return {};');
	}

	// 折叠连续空行；owner 同步过滤 —— 否则行锚点会整体错位。
	const kept: Array<{ text: string; owner?: { nodeId: string; kind: 'decl' | 'ref' } }> = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === '' && (i === 0 || lines[i - 1] === '')) { continue; }
		kept.push({ text: lines[i], ...(lineOwners[i] !== undefined ? { owner: lineOwners[i] } : {}) });
	}
	const bodyLines = kept.map(k => k.text);
	const body = bodyLines.join('\n');
	const script = body;

	const name = kebab(input.workflowName ?? 'canvas-export');
	const meta = {
		name,
		description: `从画布「${input.workflowName ?? '未命名'}」导出的动态工作流起点（${plan.layers.length} 波次 / ${steps.length} 节点）`,
	};

	// ── 拓扑摘要（头部注释：一眼看懂全图的形状）────────────────────────────
	const chain: string[] = [];
	for (const e of emits) {
		if (e.kind === 'single') { chain.push(labelOf(e.step.id)); } else if (e.kind === 'parallel') { chain.push(`[${e.steps.map(s => labelOf(s.id)).join(' ‖ ')}]`); }
	}
	const topoLines: string[] = [];
	for (let i = 0; i < chain.length; i += 5) {
		const seg = chain.slice(i, i + 5).join(' → ');
		topoLines.push(i === 0 ? `// 拓扑：${seg}` : `//       → ${seg}`);
	}
	for (const e of emits) {
		if (e.kind !== 'branch') { continue; }
		const g = labelOf(e.branch.gateId);
		if (e.branch.trueIds.length > 0) { topoLines.push(`//   ${g} ├─ 是 → ${e.branch.trueIds.map(labelOf).join(' → ')}`); }
		if (e.branch.falseIds.length > 0) { topoLines.push(`//   ${g} └─ 否 → ${e.branch.falseIds.map(labelOf).join(' → ')}`); }
	}

	// ── displayScript：自包含展示形态（代码投影视图）──────────────────────
	// 无参 `async function run()` 签名：表达「hooks 是引擎注入的全局标识符，
	// 不是函数参数」—— 旧形态写成 run({ agent, … }) 会让人以为照抄能跑。
	const displayLines: string[] = [
		`// ⚡ Saros 动态工作流 · ${meta.name}（由画布生成的只读投影）`,
		`// meta: ${JSON.stringify(meta)}`,
		'',
		...topoLines,
		'',
		'// hooks 由 Workflow Engine 注入为脚本作用域的全局标识符（无需 import/声明）：',
		'//   agent(prompt, opts?)       运行一个子代理至完成；失败解析为 null（filter(Boolean)）',
		'//   parallel(thunks)           并发执行零参函数并等待全部完成（barrier）',
		'//   pipeline(items, ...stages) 逐项流水，阶段间无屏障',
		'//   stage(stageUid, over?)     **执行**画布媒体节点（真实驱动 ComfyUI 生成）',
		'//   nodeOutput(stageUid)       读取画布节点已有快照（不触发执行）',
		'//   phase(title) / log(msg)    进度分组 / 进度叙述',
		'//   args                       工具调用入参，原样',
		'// ↓ run() 的函数体与 workflow 工具的 script 参数逐字一致（复制 { } 之间的内容）。',
		'async function run() {',
	];
	const headerLineCount = displayLines.length;
	for (const line of bodyLines) {
		displayLines.push(line === '' ? '' : '  ' + line);
	}
	displayLines.push('}');
	const displayScript = displayLines.join('\n');

	// 行锚点：body 第 i 行 → displayScript 的 1-based 行号（头部行数 + i + 1）。
	const anchors = kept
		.map((k, i) => (k.owner !== undefined ? { line: headerLineCount + i + 1, nodeId: k.owner.nodeId, kind: k.owner.kind } : undefined))
		.filter((a): a is { line: number; nodeId: string; kind: 'decl' | 'ref' } => a !== undefined);

	return {
		meta,
		script,
		displayScript,
		anchors,
		warnings,
	};
}
