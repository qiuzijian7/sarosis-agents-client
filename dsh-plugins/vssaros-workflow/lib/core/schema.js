// @vssaros/dsh-workflow — `workflow_get_schema` 的**纯逻辑**：节点类型目录 + 装配结果。
//
// 真源：IDE `browser/providers/tool/workflowTools.ts` 的 `workflow_get_schema`（2026-10-12 逐条核对 ✓）：
//   · 它返回 `WORKFLOW_NODE_SCHEMA.nodeTypes`（**只有 5 条一行描述** ✓：start / agent / branch / askUser / end）
//     并把**在线 agent 列表**塞进 `agent` 类型的描述里 ✓（`availableAgents` 字段 ✓）—— **那才是它值钱的一半** ✓
//    （没有它，模型填不出合法的 `data.agentId` ✓）。
//   · ⚠ 照抄会**教错**：真源把 `branch` 当节点类型宣称 ✗，而我们 `store.js` 明确把 `branch`/`condition`
//     **归一成 `ifElse`** ✓（真源自己的注释："引擎里不存在" ✓）⇒ 我们的目录改成**宣称真名 + 单列别名** ✓。
//
// ⚠ **反漂移**（本文件最要紧的性质）：目录里所有**规范性**内容都不是我手写的断言 ✗，而是
//   **从我们自己的写侧推导** ✓ —— `workflow_apply` 的归一化常量（别名表 / 顶层元键表 / 必带的 Start+End）
//   才是唯一真源 ✓，本文件只是把它们**讲给模型听** ✓。`p3-10` 会拿两份**互相对账** ✓：
//   写侧加了别名而目录没跟上 ⇒ 红 ✓（这正是"文档与实现会漂移"那条老病的免疫 ✓）。
//
// 纯函数：零 I/O、零 dsh 依赖 ✓ ⇒ 可直接单测（`p3-10` ✓）。

/** i18n/文案口径：类型目录（**规范性字段由写侧推导 ✓**，这里的 `doc` 只是给人/模型看的解释 ✓）。 */
export const NODE_TYPES = [
	{
		type: 'start',
		label: 'Start',
		doc: '工作流入口（必须有 ✓，且引擎从它开始走）。',
	},
	{
		type: 'agent',
		label: 'Agent',
		doc: '执行一个 agent：`data.agentId` 要取 `availableAgents` 里的 id ✓（真源原话：agentId MUST be one of …）。',
		usesAgentId: true,
	},
	{
		type: 'ifElse',
		label: 'If / Else',
		doc: '条件分支：出边要带 `fromPort`（`branch-0` = 真分支 / `branch-1` = 假分支 ✓）。',
		ports: ['branch-0', 'branch-1'],
	},
	{
		type: 'switch',
		label: 'Switch',
		doc: '多路分支：出边按 `option-<序号>` 标明走哪一支 ✓。',
		ports: ['option-0'],
	},
	{
		type: 'askUser',
		label: 'Ask User',
		doc: '问用户：出边同样是 `option-<序号>`（用户选哪条走哪条 ✓）。',
		ports: ['option-0'],
	},
	{
		type: 'end',
		label: 'End',
		doc: '工作流出口（必须有 ✓）。',
	},
];

/** 画布坐标的建议（`position` 是**必填**的 —— 写侧对每个节点都要求 `{ id, type, position, data }` ✓）。 */
export const POSITION_HINT = '每个节点都要给 `position: { x, y }`（画布坐标；只影响显示，不影响执行）—— 建议同一列 x 相同、按 y 每 120 递增 ✓。';

/** 未知类型怎么办（**如实说明** ✓：写侧不校验类型集合 ⇒ 未知类型会原样落库，引擎那边才可能报错 ✗）。 */
export const UNKNOWN_TYPE_NOTE = '本目录列的是**已知**类型 ✓；写侧对未知类型**不改不拦**（原样落库 ✗）—— 用没列在这里的类型前先确认引擎认它 ✓。';

/**
 * 装配对外 payload（**纯函数** ✓）。
 * @param {{ agents?: Array<{id:string,name?:string,model?:string}>, agentErrors?: string[], enforced?: { aliases?: object, metaKeys?: string[] } }} input
 *   `enforced` 由**写侧常量**传入（`store.js` 导出 ✓）⇒ 目录里的别名/元键部分**不是**手写副本 ✓。
 */
export function buildSchema({ agents = [], agentErrors = [], enforced = {} } = {}) {
	const agentIds = agents.map(a => a.id).filter(Boolean);
	const aliasPairs = Object.entries(enforced.aliases ?? {}).map(([alias, type]) => ({ alias, type }));
	const metaKeys = [...(enforced.metaKeys ?? [])];
	const dataFieldRule = `节点内容字段（label / agentId / …）必须放进 \`data\` ✓：写侧把**除 ${metaKeys.join(' / ') || '(元键)'} 之外**的顶层键自动挪进 \`data\` ✓（能修，但别依赖它 ✗）。`;
	const nodeTypes = NODE_TYPES.map(def => (def.usesAgentId
		? {
			...def,
			doc: `${def.doc} 可选值：${agentIds.length ? `[${agentIds.join(', ')}]` : '(no agents available — ask the user to create one first)'}`,
		}
		: def));
	return {
		nodeTypes,
		aliases: aliasPairs,
		metaKeys,
		requiredNodeTypes: ['start', 'end'],
		dataFieldRule,
		positionHint: POSITION_HINT,
		availableAgents: agents.map(a => ({ id: a.id, ...(a.name ? { name: a.name } : {}), ...(a.model ? { model: a.model } : {}) })),
		...(agentErrors.length ? { agentErrors } : {}),
		notes: [
			UNKNOWN_TYPE_NOTE,
			aliasPairs.length ? `别名（进库前自动归一 ✓）：${aliasPairs.map(p => `${p.alias} → ${p.type}`).join('、')}` : '（无别名）',
			agentIds.length ? '' : '本机 `.agent.md` 里没有可用 agent ⇒ agent 节点先别写，或先让用户建一个 ✓。',
			'规范性字段（别名 / 元键 / 必带 Start+End）来自**写侧实现**，与它逐条对账 ⇒ 不会漂移 ✓。',
		].filter(Boolean),
	};
}
