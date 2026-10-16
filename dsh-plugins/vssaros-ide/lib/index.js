// @vssaros/dsh-ide — Host half：把 VsSaros 的 IDE 能力（诊断 / 选区）暴露成 dsh 工具。
//
// 分工（反向通道协议 v2，README 4.49–4.52）：
//   本模块（Host 里的插件）：注册工具 → 模型调用 → `vssarosBridge.callIDE('ide.request', …)`
//   VsSaros **主进程**：授权（能力名在清单白名单 + 调用方插件已装 + **该插件清单声明过这个能力**）
//   VsSaros **渲染进程**：执行（marker / editor）→ 回执。
//
// 因此本模块**必须**在清单 `vssaros.ideCapabilities` 里声明它用到的每个能力：漏一个，请求会在主进程
// 被拒（默认拒绝），工具报"未声明能力 xxx"。探针里有一条断言专门把"代码里用到的能力"与"清单声明的
// 能力"对齐——两边不一致在真机上只表现为一次工具失败，不值得让人去猜。
//
// **无界面模块**：清单 `view.kind=none`（不占容器 / 不开页面 / 不注册 ActivityBar）。工具是这个模块的
// 全部对外面。

export const name = 'vssaros-ide';

/**
 * 必需服务：`tools` 注册工具；`vssarosBridge` 是控制桥给兄弟插件的出站原语
 * （由伴生插件 @vssaros/dsh-bridge `ctx.provide`，见桥的 `callIDE`）。
 */
export const inject = ['tools', 'vssarosBridge'];

/** 反向请求里的调用方标识：VsSaros 侧据此查"这个插件声明了哪些能力"。 */
const PLUGIN_ID = '@vssaros/dsh-ide';

/**
 * 缺省超时（毫秒）：**故意长于 VsSaros 那份"渲染侧等待预算"**。renderer 没接能力时，主进程会先
 * 给出"IDE 能力 X 超时：renderer 没有回执"这种能指导排查的错误；本侧超时更晚发生，就不会盖掉它。
 *
 * ⚠️ 现行渲染侧预算（`common/dshIdeCapabilities.ts: ideRequestTimeoutMs`）是 **20s 默认 / 120s 慢档**，
 * 且**用户确认（VsSaros 侧窗口 60s）也算在慢档里** ⇒ 本侧不能再用一个固定值：固定 20s 时，
 * `browser.type` 的用户还在读确认框，Host 侧已经超时（真机踩过）。按操作语义算预算见 {@link bridgeTimeoutMs}。
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 渲染侧同一 op 的预算（镜像值；真值在 `dshIdeCapabilities.ts`，有跨源码用例钉住"本侧必须更晚"）。 */
const RENDER_TIMEOUT_DEFAULT_MS = 20_000;
const RENDER_TIMEOUT_SLOW_MS = 120_000;
/** 本侧至少比渲染侧晚这么多：让那条更有指导性的错误（renderer 无回执 / 用户拒绝）先到。 */
const BRIDGE_TIMEOUT_MARGIN_MS = 5_000;
/**
 * 需用户确认的 op 的**兜底**下限：VsSaros 侧同意窗口 60s + 余量。
 * （按当前渲染侧预算，慢档 120s+余量已经盖过它；留着是防"渲染侧预算被调小"时又退回
 * "用户还在读确认框、Host 侧已超时"——那正是这一版修掉的那类错配。）
 */
const CONSENT_TIMEOUT_MS = 70_000;

/**
 * 需用户**逐次确认**的 op（与 VsSaros 侧 `IDE_CANVAS_ACTION_OPS` 一一对应；漂移会被
 * `test/common/dshIdeToolContract.test.ts` 的用例打出来）。确认发生在能力执行**内部**，算在同一份预算里，
 * 所以这些 op 必须留足确认时间。
 *
 * ⚠ `browser` 那档（`IDE_BROWSER_ACTION_OPS`）已随该族退役（README 4.73 Step 3）⇒ 这里不再有它的表。
 */
const CANVAS_CONSENT_OPS = ['apply_ops', 'generate', 'reverse_prompt'];

function timeoutOf(config) {
	const raw = config?.timeoutMs;
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

/**
 * 本侧等待预算（毫秒）：取三者最大 —— ① 配置值（仍可**调大**）；② 渲染侧同一 op 的预算 + 余量；
 * ③ 需确认 op 的同意窗口下限、或 unreal 那几条的下限。
 *
 * 为什么不是固定值：固定 20s 时，`browser.type` / `canvas.apply_ops` 的用户还在读确认框（窗口 60s），
 * Host 侧已经超时，模型拿到"renderer 没有回执"——排查方向完全错。现在两侧共用同一套操作语义，
 * 且本侧**严格晚于**渲染侧：那条更有指导性的错误总是先到。
 */
function bridgeTimeoutMs(config, capability, params) {
	const op = typeof params?.op === 'string' ? params.op : undefined;
	// ⚠️ 慢档判定必须与 VsSaros 侧 `ideRequestTimeoutMs` **完全同形**：那边是"需确认的 op 一律慢档"。
	// 两边不同形就会出现"本侧比渲染侧早超时"——契约用例会当场把这种漂移打出来。
	const needsConsent = capability === 'canvas' && CANVAS_CONSENT_OPS.includes(op);
	const floors = [
		timeoutOf(config),
		(needsConsent ? RENDER_TIMEOUT_SLOW_MS : RENDER_TIMEOUT_DEFAULT_MS) + BRIDGE_TIMEOUT_MARGIN_MS,
	];
	if (needsConsent) {
		floors.push(CONSENT_TIMEOUT_MS);
	}
	return Math.max(...floors);
}

/**
 * 发起一次 IDE 能力请求。没有反向通道时**明确报错**（不静默、不假装成功）——
 * 这条通道缺失的表现本该是"工具说清楚为什么不行"。
 */
function requestIde(bridge, capability, params, timeoutMs, sessionId) {
	if (!bridge || typeof bridge.callIDE !== 'function') {
		throw new Error('控制桥不可用（@vssaros/dsh-bridge 未加载或版本过旧）：IDE 能力需要反向通道（协议 v2）');
	}
	return bridge.callIDE('ide.request', {
		capability,
		pluginId: PLUGIN_ID,
		// 会话 id：主进程据此把这一次能力**投给正在跑这个会话的那个窗口**（拿不到就退回广播，
		// 行为与从前一致）。不带上它的话，多窗口下"结果落在哪个窗口"只能靠先到先得（README 4.47/4.48）。
		...(sessionId === undefined ? {} : { sessionId }),
		...(params === undefined ? {} : { params }),
	}, { timeoutMs });
}

/**
 * 工具执行上下文里的**会话 id**（dsh 在 `tool.execute(args, exec)` 里给：`exec.agent.session.id`）。
 * 拿不到（老版本 dsh / 非会话上下文）⇒ `undefined`，此时主进程退回广播——**不让新字段成为硬依赖**。
 */
function sessionIdOf(exec) {
	const id = exec?.agent?.session?.id;
	return typeof id === 'string' && id ? id : undefined;
}

/** 诊断条目的输出 schema（与 `common/dshIdeCapabilities.ts` 的整形一致）。 */
const DIAGNOSTIC_ITEM_SCHEMA = {
	type: 'object',
	properties: {
		path: { type: 'string' },
		severity: { type: 'string' },
		message: { type: 'string' },
		line: { type: 'integer' },
		column: { type: 'integer' },
		code: { type: 'string' },
		source: { type: 'string' },
	},
	required: ['severity', 'message', 'line', 'column'],
};

function severityTally(items) {
	const tally = new Map();
	for (const item of items) {
		tally.set(item.severity, (tally.get(item.severity) ?? 0) + 1);
	}
	return [...tally.entries()].map(([name, count]) => `${count} ${name}`).join(' / ');
}

function toolDefinitions(bridge, config) {
	return [
		{
			name: 'get_diagnostics',
			description: '读取 VsSaros 编辑器里的诊断（编译/检查错误与警告）。默认读当前活动文件；也可以读整个工作区，或指定某个文件路径。只读，不改编辑器状态。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '要读诊断的文件路径（绝对路径，或相对工作区根目录的路径）。缺省 = 当前活动文件。' },
					scope: { type: 'string', description: '\'file\'（默认，单个文件）或 \'workspace\'（整个工作区，每条结果带 path）' },
					minSeverity: { type: 'string', description: '最低严重级：hint / info / warning / error（默认全部带上）' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						scope: { type: 'string' },
						resource: { type: 'string' },
						count: { type: 'integer' },
						truncated: { type: 'boolean' },
						items: { type: 'array', items: DIAGNOSTIC_ITEM_SCHEMA },
						note: { type: 'string' },
					},
					required: ['scope', 'count', 'truncated', 'items'],
				},
				// ⚠️ `tools.register` 的 output **必须有 render**（只写 schema 会抛，且表现为整个插件不挂载）
				render: (_args, value) => [{
					type: 'text',
					text: value.count === 0
						? `没有诊断${value.note ? `（${value.note}）` : ''}`
						: `${value.count} 处诊断（${severityTally(value.items)}）${value.truncated ? `（已截断，只给了前 ${value.items.length} 条）` : ''}`,
				}],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'getDiagnostics', {
				...(typeof params?.path === 'string' && params.path.trim() ? { path: params.path.trim() } : {}),
				...(typeof params?.scope === 'string' && params.scope.trim() ? { scope: params.scope.trim() } : {}),
				...(typeof params?.minSeverity === 'string' && params.minSeverity.trim() ? { minSeverity: params.minSeverity.trim() } : {}),
			}, bridgeTimeoutMs(config, 'getDiagnostics', params), sessionIdOf(exec)),
		},
		{
			name: 'get_selection',
			description: '读取 VsSaros 里当前活动文本编辑器的选区（选中文本 + 起止行列）。属于"用户此刻在看/选中什么"的上下文。只读。',
			parameters: {
				type: 'object',
				properties: {},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						resource: { type: 'string' },
						text: { type: 'string' },
						length: { type: 'integer' },
						truncated: { type: 'boolean' },
						isEmpty: { type: 'boolean' },
						startLine: { type: 'integer' },
						startColumn: { type: 'integer' },
						endLine: { type: 'integer' },
						endColumn: { type: 'integer' },
						note: { type: 'string' },
					},
					required: ['text', 'length', 'truncated', 'isEmpty'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.isEmpty
						? `选区为空${value.note ? `（${value.note}）` : ''}`
						: `选了 ${value.length} 字${value.truncated ? '（已截断）' : ''}${value.resource ? `，来自 ${value.resource}` : ''}：${value.text}`,
				}],
			},
			isConcurrencySafe: () => true,
			execute: async (_params, exec) => requestIde(bridge, 'getSelection', undefined, bridgeTimeoutMs(config, 'getSelection', undefined), sessionIdOf(exec)),
		},
		{
			name: 'open_file',
			description: '在 VsSaros 的文件编辑区打开一个**工作区内**的文件（可定位到某行）。默认**不抢焦点**（不会把你正在输入的位置挪走）；只有用户明确说"带我去看"/"打开给我看"时才传 focus: true。文件必须存在且在工作区内，否则报错（需要内容用 read 类工具，不必打开）。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径（绝对路径，或相对工作区根目录）' },
					startLine: { type: 'integer', description: '定位到的行号（1-based）；缺省不改光标位置' },
					endLine: { type: 'integer', description: '选区结束行；缺省 = startLine' },
					focus: { type: 'boolean', description: '是否把焦点切到编辑器（缺省 false：后台打开）' },
				},
				required: ['path'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						opened: { type: 'boolean' },
						resource: { type: 'string' },
						focused: { type: 'boolean' },
						startLine: { type: 'integer' },
						endLine: { type: 'integer' },
					},
					required: ['opened', 'resource', 'focused'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: `已在文件编辑区打开 ${value.resource}${value.startLine === undefined ? '' : `（第 ${value.startLine}${value.endLine === value.startLine ? '' : `–${value.endLine}`} 行）`}${value.focused ? '' : '（未抢焦点）'}`,
				}],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'openFile', {
				...(typeof params?.path === 'string' && params.path.trim() ? { path: params.path.trim() } : {}),
				...(Number.isInteger(params?.startLine) ? { startLine: params.startLine } : {}),
				...(Number.isInteger(params?.endLine) ? { endLine: params.endLine } : {}),
				...(params?.focus === true ? { focus: true } : {}),
			}, bridgeTimeoutMs(config, 'openFile', params), sessionIdOf(exec)),
		},
		{
			name: 'reveal',
			description: '在 VsSaros 的资源管理器里定位一个**工作区内**的文件（不打开编辑器、不抢焦点）。适合回答"这个文件在哪"。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径（绝对路径，或相对工作区根目录）' },
				},
				required: ['path'],
			},
			output: {
				schema: {
					type: 'object',
					properties: { revealed: { type: 'boolean' }, resource: { type: 'string' } },
					required: ['revealed', 'resource'],
				},
				render: (_args, value) => [{ type: 'text', text: `已在资源管理器定位 ${value.resource}` }],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'reveal', {
				...(typeof params?.path === 'string' && params.path.trim() ? { path: params.path.trim() } : {}),
			}, bridgeTimeoutMs(config, 'reveal', params), sessionIdOf(exec)),
		},
		// ★ **`browser` 已退役**（README 4.73 Step 3）：整族搬到 Host 侧插件 `@vssaros/dsh-browser`
		//   （`dsh-plugins/vssaros-browser`，随包安装）。这里**不再定义**它 —— 同名工具两处注册会让
		//   整条 entry 失效；而"只在 IDE 里做得到"的能力（diagnostics / selection / openFile / reveal /
		//   showDiff / canvas / mindmap）仍留在本模块。
		{
			name: 'canvas',
			description: '读取或修改工作流画布（LiteGraph，VsSaros 工作流面板）。**只读 op 直接可用**：state（结构：节点 label/type + 连线）、task_status（每个节点的运行状态 idle/running/success/error + 错误信息 + 最近一次画布操作摘要）——需要画布打开且跑过一次 canvas_*，否则回 available:false。**三个写入 op 每次都会弹确认让用户点"允许"**，拒绝或超时就不执行（别反复重试）：**apply_ops**（原子批次：add_node / update_node / delete_node / connect / disconnect / select）、**generate**（按需求建 Prompt → ModelImageGen 流程；`run:true` 时会**立即真的跑生成**——耗时、可能花钱，确认框里会写明）、**reverse_prompt**（模型看节点上游的图，把反推的提示词**写回该节点**的 prompt 字段）。',
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', description: '\'state\' | \'task_status\'（只读）或 \'apply_ops\' | \'generate\' | \'reverse_prompt\'（改画布，均需用户逐次确认）' },
					workflowId: { type: 'string', description: '工作流 id（缺省 = default）' },
					goal: { type: 'string', description: 'generate 用（必填）：要生成什么，会成为提示词文本' },
					variants: {
						type: 'array',
						description: 'generate 用：每个变体一对 Prompt → ModelImageGen 节点（缺省只建一组）',
						items: {
							type: 'object',
							properties: {
								prompt: { type: 'string', description: '该变体的提示词（缺省用 goal）' },
								label: { type: 'string', description: '提示词节点的标签' },
							},
						},
					},
					provider_id: { type: 'string', description: 'generate 用：显式指定 provider（缺省自动选）' },
					model_id: { type: 'string', description: 'generate 用：显式指定模型（缺省自动选）' },
					negative_prompt: { type: 'string', description: 'generate 用：负向提示词（应用于所有变体）' },
					size: { type: 'string', description: 'generate 用：图像尺寸，如 1024x1024' },
					run: { type: 'boolean', description: 'generate 用：建完立即执行（缺省 false = 只建流程；true 会真的跑生成）' },
					layout: { type: 'boolean', description: 'generate 用：建完自动排版（缺省 false）' },
					node: { type: 'string', description: 'reverse_prompt 用（必填）：目标节点 id 或标签（如 "图像-1"）' },
					ops: {
						type: 'array',
						description: 'apply_ops 用：有序的操作批次（原子执行，任一失败整批回滚；最多 50 条）',
						items: {
							type: 'object',
							properties: {
								op: { type: 'string', enum: ['add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'select'] },
								type: { type: 'string', description: 'add_node 用：节点类型，如 Saros.ModelImageGen' },
								id: { type: 'string' },
								label: { type: 'string' },
								node: { type: 'string', description: 'update_node / delete_node / select 用：节点 id 或 label' },
								source: { type: 'string', description: 'connect / disconnect 用' },
								target: { type: 'string', description: 'connect / disconnect 用' },
								patch: { type: 'object', description: 'update_node 用：要合并进节点 data 的字段' },
							},
							required: ['op'],
						},
					},
				},
				required: ['op'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						op: { type: 'string' },
						workflowId: { type: 'string' },
						available: { type: 'boolean' },
						note: { type: 'string' },
						updatedAt: { type: 'string' },
						nodeCount: { type: 'integer' },
						edgeCount: { type: 'integer' },
						truncated: { type: 'boolean' },
						nodes: {
							type: 'array',
							items: {
								type: 'object',
								properties: { label: { type: 'string' }, type: { type: 'string' }, runState: { type: 'string' }, errorMsg: { type: 'string' } },
								required: ['label'],
							},
						},
						edges: {
							type: 'array',
							items: { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' } }, required: ['source', 'target'] },
						},
						lastOps: { type: 'array', items: { type: 'string' } },
						allowed: { type: 'boolean' },
						ok: { type: 'boolean' },
						opCount: { type: 'integer' },
						summaries: { type: 'array', items: { type: 'string' } },
						summariesTruncated: { type: 'boolean' },
						failedOpIndex: { type: 'integer' },
						error: { type: 'string' },
					},
					required: ['op'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.opCount !== undefined   // 三个写入 op 的回执都带 opCount
						? `画布已改（${value.op}）：${value.opCount} 个操作${value.ok ? '全部成功' : `失败在 ops[${value.failedOpIndex ?? '?'}]：${value.error ?? ''}`}${value.nodeCount === undefined ? '' : `（现 ${value.nodeCount} 节点 / ${value.edgeCount ?? 0} 连线）`}`
						: value.available === false
							? `画布 "${value.workflowId}"：${value.note ?? '没有快照'}`
							: value.op === 'task_status'
								? `画布 "${value.workflowId}" 运行状态：${value.nodeCount} 个节点${value.truncated ? '（已截断）' : ''}`
								: `画布 "${value.workflowId}" 结构：${value.nodeCount} 个节点 / ${value.edgeCount ?? 0} 条连线${value.truncated ? '（已截断）' : ''}`,
				}],
			},
			// 写入 op 会改画布且都要用户确认 ⇒ 与其它工具（尤其另一个 canvas 写）互斥
			isConcurrencySafe: args => !CANVAS_CONSENT_OPS.includes(args?.op),
			execute: async (params, exec) => requestIde(bridge, 'canvas', {
				...(typeof params?.op === 'string' && params.op.trim() ? { op: params.op.trim() } : {}),
				...(typeof params?.workflowId === 'string' && params.workflowId.trim() ? { workflowId: params.workflowId.trim() } : {}),
				// `apply_ops` 的批次原样转交（形状校验在 VsSaros 侧的统一闸门里）
				...(Array.isArray(params?.ops) ? { ops: params.ops } : {}),
				// `generate` / `reverse_prompt` 的参数：**原样**转交（映射成画布 op 是 VsSaros 侧的事，
				// 那边与既有画布工具用同一份形状，并有跨源码一致性用例钉住）
				...(typeof params?.goal === 'string' && params.goal.trim() ? { goal: params.goal.trim() } : {}),
				...(typeof params?.node === 'string' && params.node.trim() ? { node: params.node.trim() } : {}),
				...(typeof params?.provider_id === 'string' ? { provider_id: params.provider_id } : {}),
				...(typeof params?.model_id === 'string' ? { model_id: params.model_id } : {}),
				...(typeof params?.negative_prompt === 'string' ? { negative_prompt: params.negative_prompt } : {}),
				...(typeof params?.size === 'string' ? { size: params.size } : {}),
				...(Array.isArray(params?.variants) ? { variants: params.variants } : {}),
				...(typeof params?.run === 'boolean' ? { run: params.run } : {}),
				...(typeof params?.layout === 'boolean' ? { layout: params.layout } : {}),
			}, bridgeTimeoutMs(config, 'canvas', params), sessionIdOf(exec)),
		},
		// ── 工作流 / 看板（2026-10-13 补：IDE 侧执行端**早就实现**，只是 `vssaros.ideCapabilities`
		//    漏声明 + 本文件漏工具 ⇒ 能力不可达 ✗。清单已补（package.json），这里补工具定义。
		//    两者都是**展示类**：不改数据、不写文件（与 reveal/mindmap 同性质 ✓）。
		//    名字取 `workflow_open` / `taskboard_focus`（不叫 `workflow`：工作流模块自己已有
		//    `workflow_list` 等，同名两处注册会让**整条 entry 失效** ✗ —— 先查过没占用才用）。
		{
			name: 'workflow_open',
			description: '在 VsSaros 的编辑器区**打开一张工作流画布**（展示类：不改任何数据、不写文件）。id 用 workflow_list 得到的那个。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '工作流 id（workflow_list 返回值里的 id）' },
				},
				required: ['id'],
			},
			output: {
				schema: {
					type: 'object',
					properties: { op: { type: 'string' }, opened: { type: 'boolean' }, id: { type: 'string' }, name: { type: 'string' } },
					required: ['opened', 'id'],
				},
				render: (_args, value) => [{ type: 'text', text: `已打开工作流 ${value.name ?? value.id}` }],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'workflow', {
				op: 'open',
				...(typeof params?.id === 'string' && params.id.trim() ? { id: params.id.trim() } : {}),
			}, bridgeTimeoutMs(config, 'workflow', params), sessionIdOf(exec)),
		},
		{
			name: 'taskboard_focus',
			description: '在 VsSaros 的**看板编辑器**里定位一张卡片（展示类：不改任何数据）。按**标题**定位 —— 卡片 id 只在看板内部流转，两侧都拿得到的是标题。',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: '卡片标题（看板上的显示标题）' },
				},
				required: ['title'],
			},
			output: {
				schema: {
					type: 'object',
					properties: { op: { type: 'string' }, focused: { type: 'boolean' }, title: { type: 'string' } },
					required: ['focused', 'title'],
				},
				render: (_args, value) => [{ type: 'text', text: `已在看板定位 ${value.title}` }],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'taskboard', {
				op: 'focus',
				...(typeof params?.title === 'string' && params.title.trim() ? { title: params.title.trim() } : {}),
			}, bridgeTimeoutMs(config, 'taskboard', params), sessionIdOf(exec)),
		},
		{
			name: 'mindmap',
			description: '读取思维导图（`.canvas` 文件，JSON Canvas 格式）。缺省读**你正在看的那张图**（活动编辑器，已经打开着）；也可以传 path 指向**工作区内**的 .canvas 文件。返回节点（id / 文本 / 类型）与连线（from → to，含标签），带上限与 truncated（节点 100 / 连线 200，单节点文本 200 字）。节点文本读 `text`，旧数据缺 `text` 时回落到 `content`。不是 JSON Canvas 数据会明确报错（工作区外的文件请用 read 类工具）。**文件超过 4MB 会被直接拒**（要内容请用 read 类工具分片读）。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '`.canvas` 文件路径（绝对或相对工作区根）；缺省 = 活动编辑器那张图' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						resource: { type: 'string' },
						mindmap: { type: 'boolean' },
						direction: { type: 'string' },
						nodeCount: { type: 'integer' },
						edgeCount: { type: 'integer' },
						truncated: { type: 'boolean' },
						nodes: {
							type: 'array',
							items: {
								type: 'object',
								properties: { id: { type: 'string' }, text: { type: 'string' }, type: { type: 'string' } },
								required: ['text'],
							},
						},
						edges: {
							type: 'array',
							items: {
								type: 'object',
								properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
								required: ['from', 'to'],
							},
						},
					},
					required: ['resource', 'nodeCount', 'edgeCount'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: `思维导图 ${value.resource}：${value.nodeCount} 个节点 / ${value.edgeCount} 条连线${value.truncated ? '（已截断）' : ''}`,
				}],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'mindmap', {
				...(typeof params?.path === 'string' && params.path.trim() ? { path: params.path.trim() } : {}),
			}, bridgeTimeoutMs(config, 'mindmap', params), sessionIdOf(exec)),
		},
		// ★ **`unreal_*` 已退役**（README 4.73 Step 3）：整族搬到 Host 侧插件 `@vssaros/dsh-unreal`
		//   （`dsh-plugins/vssaros-unreal`，随包安装，**只读四个** —— exec / wait / build 在哪一侧都不放行）。
		{
			name: 'show_diff',
			description: '在 VsSaros 里打开两个**工作区内**文件的**只读**对比（不改文件）。默认不抢焦点，`focus: true` 才切。回答"这两份差在哪"用它比读两份更快。',
			parameters: {
				type: 'object',
				properties: {
					left: { type: 'string', description: '左侧（原始）文件路径' },
					right: { type: 'string', description: '右侧（修改后）文件路径' },
					title: { type: 'string', description: 'diff 标签页标题（可选）' },
					focus: { type: 'boolean', description: '是否切焦点（缺省 false）' },
				},
				required: ['left', 'right'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						diffed: { type: 'boolean' },
						left: { type: 'string' },
						right: { type: 'string' },
						focused: { type: 'boolean' },
					},
					required: ['diffed', 'left', 'right', 'focused'],
				},
				render: (_args, value) => [{ type: 'text', text: `已打开只读 diff：${value.left} ↔ ${value.right}${value.focused ? '' : '（未抢焦点）'}` }],
			},
			isConcurrencySafe: () => true,
			execute: async (params, exec) => requestIde(bridge, 'showDiff', {
				...(typeof params?.left === 'string' && params.left.trim() ? { left: params.left.trim() } : {}),
				...(typeof params?.right === 'string' && params.right.trim() ? { right: params.right.trim() } : {}),
				...(typeof params?.title === 'string' && params.title.trim() ? { title: params.title.trim() } : {}),
				...(params?.focus === true ? { focus: true } : {}),
			}, bridgeTimeoutMs(config, 'showDiff', params), sessionIdOf(exec)),
		},
		{
			name: 'dashboard_stats',
			description: '读 VsSaros 侧 Dashboard 的**本地聚合**（只读）：会话数与活跃数、告警条数与前几条、KPI 卡片、当前聚合的日期范围。'
				+ '⚠ 这是 **IDE 口径**的数据（聚合在 IDE 内存里）——与 dsh 侧那个 dashboard 页读的**会话投影缓存**不是同一份 ⇒ **两个数字不必相同**（README 5.115 / 5.124）。'
				+ '要"IDE 怎么看用量与告警"用它；要 dsh 自己缓存里的会话需要另一个工具。',
			parameters: { type: 'object', properties: {} },
			output: {
				schema: {
					type: 'object',
					properties: {
						available: { type: 'boolean' },
						note: { type: 'string' },
						range: { type: 'string' },
						sessionCount: { type: 'integer' },
						activeSessions: { type: 'integer' },
						alertCount: { type: 'integer' },
						alertTop: { type: 'array', items: { type: 'string' } },
						kpis: { type: 'array', items: { type: 'string' } },
						lastUpdated: { type: 'integer' },
					},
					required: ['available'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.available
						? `VsSaros Dashboard（IDE 聚合，范围 ${value.range}）：会话 ${value.sessionCount}（活跃 ${value.activeSessions}） · 告警 ${value.alertCount}\n`
							+ `${value.kpis.length ? `KPI：${value.kpis.join(' · ')}\n` : ''}`
							+ `${value.alertTop.length ? `告警前几条：${value.alertTop.join(' ｜ ')}` : ''}`
						: `没有取到 IDE 的 dashboard 数据：${value.note ?? '(未说明)'}`,
				}],
			},
			// 纯读、无副作用：允许与同批只读工具并行 ✓
			isConcurrencySafe: () => true,
			execute: async (_params, exec) => {
				const value = await requestIde(bridge, 'dashboardStats', undefined, bridgeTimeoutMs(config, 'dashboardStats', {}), sessionIdOf(exec));
				if (!value || value.available !== true) {
					return { available: false, ...(value?.note ? { note: String(value.note) } : {}) };
				}
				return {
					available: true,
					range: String(value.range ?? ''),
					sessionCount: Number(value.sessions?.total ?? 0),
					activeSessions: Number(value.sessions?.active ?? 0),
					alertCount: Number(value.alerts?.count ?? 0),
					alertTop: Array.isArray(value.alerts?.top) ? value.alerts.top.map(String) : [],
					// ⚠ 只带**卡片文字**进人读面 ✓（结构化字段留在这个工具的输出里、不塞进 meta ✗ —— 无消费者的字段等于没有，5.83）
					kpis: Array.isArray(value.kpis)
						? value.kpis.map(k => `${k?.label ?? ''} ${k?.value ?? ''}${k?.unit ?? ''}${k?.detail ? `（${k.detail}）` : ''}`.trim())
						: [],
					lastUpdated: Number(value.lastUpdated ?? 0),
				};
			},
		},
	];
}

export function apply(ctx, config = {}) {
	// R13（preset plane）：`hostHalf: true` ⇒ 这次挂载**不注册工具**（同一个包在 host plane 与 preset
	// plane 各挂一次 ✓，工具只该由 preset 那次提供）；缺省 ⇒ 与从前完全一样 ✓（详见 codebase 顶部那段注释）。
	const hostHalf = config.hostHalf === true;
	const bridge = ctx.vssarosBridge;
	ctx.effect(() => {
		// 一个 effect 管两份注册：卸载时由 Cordis 调这个组合 disposer，工具一起撤掉。
		// ⚠ 本模块**只**注册"只能在 IDE 里做"的那几族（diagnostics / selection / openFile / reveal /
		//   showDiff / canvas / mindmap）。`browser` 与 `unreal_*` 已整族退役给 Host 侧插件
		//   （`@vssaros/dsh-browser` / `@vssaros/dsh-unreal`，见 README 4.73 Step 3）——**不要**在这里加回，
		//   同名工具两处注册会让整条 entry 失效（不是后者覆盖）。
		if (hostHalf) { return undefined; }
		const disposers = toolDefinitions(bridge, config).map(definition => ctx.tools.register(definition));
		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	});
}
