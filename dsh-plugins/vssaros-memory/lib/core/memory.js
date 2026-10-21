// @vssaros/dsh-memory — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源（全部来自仓库里既有实现，不是猜的）：
// - 记忆网关 = `extensions/agentmemory-gateway`：由主进程 spawn，**HTTP REST 监听 127.0.0.1:3111**
//   （dev 3112；`extensions/agentmemory-memory/src/serverConfig.ts` 的端口隔离规则）。
// - 已核实的端点：`POST {base}/search/{agentId}`（body `{query, limit}` → `[{id, score}]`）、
//   `GET {base}/stats/{agentId}`；其余是 RPC 风格 `POST {base}/{encodeURIComponent(method)}`。
// - 工作记忆文本由 `buildWorkingContext(agentId, tokenBudget) → string` 产出
//   （`extensions/agentmemory-memory/src/amFunctions.ts:175`）；它在网关上的方法名取自方法清单的
//   `mem::context`，**参数形态 `{agentId, tokenBudget}` 未经真机核实**——真机上若不匹配，页面上会显示
//   网关原始错误（不静默、不伪装成功）。
//
// 单写者：记忆的写入口是网关（方案 6.8 / 8.5）。本模块**只读**，不开任何直写文件的通道。

/** 注入用的系统提示词 section 名。 */
export const SECTION_NAME = 'vssaros-memory-working';

/** 工作记忆的 token 预算（传给网关 `mem::context`）。 */
export const DEFAULT_TOKEN_BUDGET = 1024;

/** 注入文本的硬上限（网关给的文本超长时截断——system prompt 不该被一段记忆吃满）。 */
export const MAX_INJECT_CHARS = 8000;

/** 工作记忆 section 的位置：紧随部署级人设之后（`DEPLOYMENT_PERSONA_PREFIX` = 0 → 这里 100）。 */
export const SECTION_ORDER_FALLBACK = 100;

/**
 * 快照归属键：**取不到 scope/agent 时的保底键**。
 *
 * 为什么需要保底：`AssembleContext` 的 d.ts 只声明了 `scope?` / `signal?`
 * （`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:37-45`），官方注释也写明
 * "When absent, only global providers and subject-less listeners participate"
 * ⇒ **不能假设它一定有值** ✗。取不到时退回一个全局共享槽位：功能不丢 ✓，只是不按会话隔离 ✓
 * —— 而这个降级**必须是可观察的**（页面诊断会把它标成 `global`，提醒"冻结没按会话生效"）✓。
 */
export const GLOBAL_SNAPSHOT_KEY = Symbol.for('vssaros-memory.global-snapshot');

/**
 * 冻结快照表的上限（防长驻 Host 里无限增长；超限按插入序淘汰最旧的那个）。
 *
 * 为什么是 8：会话数是**低频**维度（同一 Host 同时活跃的会话极少超过这个数）✓，
 * 而每个槽位只是几百到 8000 字符的文本 ⇒ 上限本身就足够保守 ✓。
 */
export const SNAPSHOT_MAX_SCOPES = 8;

/**
 * 选快照归属键：`context.scope` → `context.agent` → `GLOBAL_SNAPSHOT_KEY`。
 *
 * ⚠ **为什么要取 `context.agent` 这一级**：它**没有写在 d.ts 里**，但官方自己在用 ——
 * `@deepseek-ai/dsh-user-approval/lib/index.js:83-87` 的 context provider 里
 * `const agent = context.agent; if (agent === void 0) return "";` ⇒ 它是**运行时真实存在**的字段 ✓。
 * 再看 `dsh-system-prompt/lib/index.js:189` 的 `PromptLayer` 构造注释：section/context 的归属分
 * "全局层"与"**按 agent 的层**"两种 ⇒ `context.agent` 就是"这次 assembly 是哪个 agent" ✓。
 * 本仓纪律：**类型声明 ≠ 运行时形状** ⇒ 两者都取、任一可用即可，并由探针钉住 ✓。
 *
 * `ScopeKey` 是 `object`（`@deepseek-ai/dsh-scope`："An opaque, identity-compared scope key"）
 * ⇒ 直接当 Map 的键 ✓（按身份比较，不需要字符串化）。
 *
 * @param {{scope?: unknown, agent?: unknown} | undefined} context - section provider 收到的装配上下文。
 * @returns {unknown} 归属键（`scope` / `agent` / `GLOBAL_SNAPSHOT_KEY`）。
 */
export function snapshotKeyOf(context) {
	if (context?.scope !== undefined && context.scope !== null) {
		return context.scope;
	}
	if (context?.agent !== undefined && context.agent !== null) {
		return context.agent;
	}
	return GLOBAL_SNAPSHOT_KEY;
}

/** 空快照的**唯一**工厂（字面量散落各处会让"新槽位漏了某个字段"变成静默的 undefined ✗）。 */
export function createSnapshot() {
	return { text: '', fetchedAt: 0, ok: false, error: '尚未刷新', source: '' };
}

/**
 * 把 `key` 登记进冻结表（超上限淘汰最旧的），返回它对应的槽位。
 *
 * 为什么不是 `WeakMap`：`ScopeKey` 是 object ✓ 本可以用 WeakMap，但那样**页面与探针无法枚举**
 * 到底冻结了几个会话 ✗ —— 而"冻结没生效（所有会话退化成同一个槽位）"恰恰是本机制最需要被看见的
 * 失败模式 ✓。所以用 `Map` + 显式上限（按插入序淘汰，够用：会话数低频）✓。
 *
 * @param {Map<unknown, object>} map - 冻结表。
 * @param {unknown} key - `snapshotKeyOf` 的产物。
 * @param {number} [max] - 上限。
 * @returns {{text: string, fetchedAt: number, ok: boolean, error: string, source: string}} 槽位（新登记时为空快照）。
 */
export function admitSnapshot(map, key, max = SNAPSHOT_MAX_SCOPES) {
	const existing = map.get(key);
	if (existing !== undefined) {
		return existing;
	}
	while (map.size >= max) {
		const oldest = map.keys().next().value;
		map.delete(oldest);
	}
	const entry = createSnapshot();
	map.set(key, entry);
	return entry;
}

/** 旧分区名：本功能（按工作区隔离）之前，dsh 侧所有记忆都落在这里。 */
export const LEGACY_PARTITION = 'default';

/** 工作区分区的前缀。刻意**不以 `subagent-` 开头** ⇒ 不会撞上写预算的子代理档判据 ✓。 */
export const WORKSPACE_PARTITION_PREFIX = 'ws-';

/**
 * 记忆**分区键**（即网关的 `agentId`）—— 2026-10-12 起按**工作区**隔离。
 *
 * 优先级：`config.agentId`（显式）→ `ws-<config.workspaceId>` → `'default'`（兜底＝旧分区）。
 *
 * ★ 为什么把工作区编码进 agentId 的**值**、而不是"给 scope 加一层段" ✗（这条是实测结论）：
 *   · 网关上 `mem:memories:` 的前缀被**硬编码依赖 20+ 处**（正则反解 `/^mem:memories:(.+)$/`、
 *     `scope.slice('mem:memories:'.length)`、SQL `LIKE 'mem:memories:%'`），其中**剪枝规则**
 *     `scope LIKE 'mem:memories:subagent-%'`（`agentmemory-gateway/host/host.mjs:1291-1293`）
 *     一旦失配，超期 subagent 数据就不再被清（那个注释记着实测曾滞留 5309 行 / 7.9MB ✗）；
 *   · 而 `amSchema.ts` 的 43 个 scope 构造函数被 **388 个调用点**使用 ⇒ 加一层段要全链路透传。
 *   ⇒ 编码进值 = **零网关改动、零调用点改动** ✓（剪枝不受影响：`ws-…` 不是 `subagent-%` ✓）。
 *
 * 清洗（防御性）：只保留 `[A-Za-z0-9_-]`、其余折成 `_`、截断 64 字符 —— 分区名会被拼进
 * **KV 的 scope 字符串**，不许带分隔符/空格/路径符（否则 scope 结构歧义 ✗）。
 * 显式的 `config.agentId` **不清洗**（与从前的口径一致：显式配置信任调用方 ✓）。
 *
 * @param {{agentId?: unknown, workspaceId?: unknown}} config - 插件 config。
 * @returns {string} 分区键。
 */
export function partitionOf(config) {
	const explicit = typeof config?.agentId === 'string' ? config.agentId.trim() : '';
	if (explicit) { return explicit; }
	const workspaceId = typeof config?.workspaceId === 'string' ? config.workspaceId.trim() : '';
	const safe = workspaceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	return safe ? `${WORKSPACE_PARTITION_PREFIX}${safe}` : LEGACY_PARTITION;
}

// ── 人设分区（2026-10-20，用户拍板「写 ws、读 ws + 当前人设」）─────────────────────
//
// 背景：IDE 侧聊天框停用、统一走 dsh 后，历史记忆全在**按 agent 命名**的分区里
//   （`knowledge-base-expert` 401 条、`saros-claw` 4039 条……），而 dsh 侧只认工作区分区 `ws-<id>`
//   ⇒ 在 dsh 里选「知识库专家」也**读不到它自己的旧记忆**。
// 口径（只改**读**，不改写）：
//   · 写：仍只进 `ws-<workspace>`（项目事实按工作区隔离，不因换人设而散落）；
//   · 读：`ws-<workspace>` **+** 当前人设对应的 agent 分区（人设积累的偏好/经验跟人设走）。
// 人设分区名 = agent id（dsh 的 `vssaros-agents` 与 IDE 时代是**同一套 id**，实测
//   `resources/.agents/agents/` 下就是 `knowledge-base-expert` / `saros-claw` …）。

/** preset id 前缀（与 `vssaros-agents/lib/core/agents.js` 的 `PRESET_ID_PREFIX` 一致）。 */
export const AGENT_PRESET_PREFIX = 'vssaros-';

/**
 * **不是人设**的 preset（它们的 id 也以 `vssaros-` 开头）：标准组合 / 委派派生版的后缀。
 * ⚠ 新增"组合型" preset 时要加进来，否则会被误当成一个叫 `standard` 的人设分区（只读、无害，但会多一次空查询）。
 */
export const NON_PERSONA_PRESETS = new Set(['vssaros-standard']);

/** 人格切换投影的 key（与 `vssaros-agents/lib/core/persona.js` 的 `PERSONA_PROJECTION_KEY` 一致）。 */
export const PERSONA_PROJECTION_KEY = 'vssaros-persona';

/**
 * 从 preset id 反推人设的 agent id；不是人设 preset 就返回 `''`。
 *
 * 规则与 `presetIdOf(agentId) = 'vssaros-' + slugify(agentId)` 互逆（slug 只含 `[a-z0-9-]`）；
 * 委派派生版 `vssaros-<id>-assign` 归回本体 `<id>`（同一个人设）。
 * @param {unknown} presetId
 * @returns {string}
 */
export function personaIdFromPreset(presetId) {
	if (typeof presetId !== 'string') { return ''; }
	const id = presetId.trim();
	if (!id.startsWith(AGENT_PRESET_PREFIX) || NON_PERSONA_PRESETS.has(id)) { return ''; }
	const rest = id.slice(AGENT_PRESET_PREFIX.length).replace(/-assign$/, '');
	return /^[a-z0-9][a-z0-9-]*$/.test(rest) ? rest : '';
}

/**
 * 当前会话**生效**的人设 agent id（`''` = 没有人设：标准 preset / 拿不到会话）。
 *
 * 优先级（与 `vssaros-agents` 的装配口径一致）：
 *   ① 会话中途**切换过人格**（`vssaros-persona` 投影的 `personaId`）——那才是模型此刻看到的人设；
 *   ② 会话**当前 preset**：创建头 `meta.agentPreset`，再按日志里的 `agent-preset/selected` 前推
 *      （dsh 自己的 `agentPreset` 投影就是这么算的：`init: header.agentPreset`、`apply: selected`）。
 * ⚠ 任何异常都吞掉返回 `''` —— 本函数在 section 的 `text(context)` 热路径上，装配**绝不能**因此失败。
 *
 * @param {unknown} agent - dsh `Agent`（装配上下文 / 工具执行上下文 / turn-stopping 负载里的那个）。
 * @param {{ stateOf?: (session: unknown, key: string) => unknown } | undefined} projections - `sessionProjections` 服务（可缺席）。
 * @returns {string}
 */
export function personaIdOf(agent, projections) {
	try {
		const session = /** @type {any} */ (agent)?.session;
		if (!session) { return ''; }
		if (projections && typeof projections.stateOf === 'function') {
			const switched = /** @type {any} */ (projections.stateOf(session, PERSONA_PROJECTION_KEY))?.personaId;
			if (typeof switched === 'string' && switched.trim()) { return switched.trim(); }
		}
		let preset = session.meta?.agentPreset;
		if (typeof session.snapshotEvents === 'function') {
			for (const event of session.snapshotEvents()) {
				if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
					preset = event.data.agentPreset;
				}
			}
		}
		return personaIdFromPreset(preset);
	} catch {
		return '';
	}
}

/**
 * **读**分区清单：主分区（工作区）在前，人设分区在后；去重、去空。
 *
 * ⚠ 显式 `config.agentId`（探针 / 单租户部署）⇒ **只读它** —— 那是"我就要这一个分区"的意思，
 *   不应再被人设分区稀释（与 `partitionOf` 里"显式压过一切"同一口径）。
 * @param {{agentId?: unknown}} config
 * @param {string} primary - 写分区（`partitionOf` 的结果）。
 * @param {string} personaId - `personaIdOf` 的结果。
 * @returns {string[]}
 */
export function readPartitionsOf(config, primary, personaId) {
	const explicit = typeof config?.agentId === 'string' && config.agentId.trim() !== '';
	const out = [primary];
	if (!explicit && personaId && personaId !== primary) { out.push(personaId); }
	return out;
}

/**
 * 审批载荷的**认领前缀**（`tools/pre-execute` 的 `ask` decision）。
 *
 * 为什么需要它：审批事件里的 `toolName` 是**自由命名空间** —— 别的插件也可能注册 `memory_*`
 * 工具 ⇒ 光凭工具名认不出"这条审批是不是我发的"。手法与 `dsh-memento` 的 `[dsh-memento]`
 * 一致（`lib/gate.mjs:23-29` 的 `isMemoryWriteRequest`）。
 */
export const REQUEST_MARKER = '[vssaros-memory]';

/** 目标层的**稳定键**（策略配置用 ASCII：`core` = 核心槽位，`long` = 长期层）。 */
export function targetKeyOf(memoryType) {
	return memoryType === 'working' || memoryType === 'short_term' ? 'core' : 'long';
}

/**
 * 核心槽位 vs 长期层的**人类可读**归属名。
 *
 * ⚠ **2026-10-13 真机订正**：`working` / `short_term` 与其余类型的**分叉发生在网关侧**（引擎按 `entry.type` 路由 ✓），
 * 客户端**只有一个**入口 `POST /provider/writeMemory` ✓ —— 旧注释里那句 `mem::core-add` / `mem::remember` ✗ 是**不存在的路径** ✗
 * （真机 404；`/provider/mem::context` 更直说 `unknown provider method` ✓）。
 * ⇒ 本函数只是**呈现用**的归属名，不再对应任何客户端分支 ✓。
 * @param {string} memoryType - 记忆类型。
 * @returns {string} 归属名。
 */
export function targetLabelOf(memoryType) {
	return targetKeyOf(memoryType) === 'core' ? '核心槽位' : '长期记忆';
}

/** 写策略取值（移植 `dsh-memento` 的 `lib/gate.mjs:3-11`）。 */
export const WRITE_POLICIES = ['ask', 'auto', 'off'];

/** `memory_remember` 的 `memory_type` 枚举（与工具 schema 一致；策略 type 维只认这些）。 */
export const REMEMBER_MEMORY_TYPES = Object.freeze(['working', 'pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']);

/**
 * 审批文案里的动词（每个写工具一个；缺的会显示成 `remember` ⇒ 审批文案**说谎**）。
 * 2026-10-20：补上 slot / lesson / work / import / skill（原表只有 11 个，五个后加的工具都落到缺省 `remember`）。
 */
export const WRITE_VERBS = Object.freeze({
	memory_remember: 'remember', memory_forget: 'forget', memory_cascade: 'cascade', memory_crystal: 'crystal',
	memory_routine: 'routine', memory_improve: 'improve', memory_facet: 'facet', memory_governance: 'governance',
	memory_team: 'team', memory_mesh: 'mesh', memory_sentinel: 'sentinel',
	memory_slot: 'slot', memory_lesson: 'lesson', memory_work: 'work', memory_import: 'import', memory_skill: 'skill',
});

/**
 * 这次写入在策略表里的**类型**（`resolveWritePolicy` 的 type 维）。
 *
 * ★ 2026-10-20（代码评估：审批策略可被绕过）：原来所有写工具都用 `exec.arguments.memory_type` ——
 *   而只有 `memory_remember` **声明**了这个参数。模型可以给 `memory_governance`（批量删除）/ `memory_forget`
 *   多塞一个 `memory_type: 'working'` ⇒ 这次**删除**落进 `core` 档（若配了 `writePolicies.core='auto'` 就被
 *   自动放行）。参数是模型给的，schema 外的键 dsh 不会替我们挡。
 * 现在：
 *   · `memory_remember`：用它声明的 `memory_type`（必须在枚举里，否则按 `fact`）—— 这是**写到哪一层**的真实
 *     路由，模型选类型就是在选目标（`resolveWritePolicy` 注释差异 ② 的有意取舍，保持不变）；
 *   · 其余写工具：**固定**长期层，type = `op-<动词>`（不受参数影响）。它们能被 `long` 层键或全局策略命中，
 *     但永远命中不了 `core` 或 `long/<记忆类型>` 这些为 remember 设计的键。
 * @param {string} toolName
 * @param {{ memory_type?: unknown }} args
 * @returns {string}
 */
export function policyMemoryTypeOf(toolName, args) {
	if (toolName === 'memory_remember') {
		const t = typeof args?.memory_type === 'string' ? args.memory_type : '';
		return REMEMBER_MEMORY_TYPES.includes(t) ? t : 'fact';
	}
	return `op-${WRITE_VERBS[toolName] ?? 'write'}`;
}

/**
 * 粒度写策略解析（移植 `dsh-memento` 的 `lib/gate.mjs:73-81`，**只保留我们真有的维度**）。
 *
 * 优先级：`<target>/<type>` 精确键 > `<target>` 层键 > 全局 `writePolicy`。
 *
 * ⚠ **两处与 memento 的有意差异**（照抄会教错 ✗，两条都由 p3-26 钉着）：
 *   ① **没有 `source:<name>` 那一级**：我们只有**一条**写入路径（模型调 `memory_remember`），
 *      没有第二来源 ⇒ 那个键永远没有东西能命中它 ⇒ 配了就是"配了不生效" ✗（memento 有
 *      `/memory` 命令、`seed`、`dsh-claude-move` 等入口，所以它需要）。将来做 `turn/end`
 *      自动沉淀时再加，届时要**同时**给它一条真的写入路径 ✓。
 *   ② **type 维来自 `memory_remember` 的 `memory_type` 参数** ⇒ **模型可以自选类型落到更宽松的策略上**
 *      （例：把内容标成 `working` 就落进 `core`；memento 的 track/scope 由写方会话决定、模型不可选 ✓）。
 *      这是**有意的取舍**：闸的目标是"让用户看见跨会话的持久写入"，而 `core`（本会话工作记忆）
 *      本来就是高频低价值的一档 ⇒ 显式把它降成 `auto` 是用户的选择 ✓。要收紧就**只用全局策略**
 *      （`config.writePolicy`，那一级模型绕不过去 ✓）。
 *      ⚠ 2026-10-20 收紧：**只有 remember** 的类型来自参数；其余写工具的类型固定为 `op-<动词>`
 *      （`policyMemoryTypeOf`）⇒ 删改类工具再也借不到 `core` 档。
 *
 * @param {Record<string, string> | undefined} policies - `config.writePolicies`。
 * @param {string} fallback - `config.writePolicy`（全局）。
 * @param {string} target - `targetKeyOf(memoryType)`。
 * @param {string} memoryType - 记忆类型。
 * @returns {{policy: string, key: string}} 生效策略与命中的键（`'(fallback)'` = 全局兜底；供日志与探针诊断）。
 */
export function resolveWritePolicy(policies, fallback, target, memoryType) {
	const table = policies && typeof policies === 'object' ? policies : {};
	const byType = table[`${target}/${memoryType}`];
	if (byType !== undefined) { return { policy: byType, key: `${target}/${memoryType}` }; }
	const byTarget = table[target];
	if (byTarget !== undefined) { return { policy: byTarget, key: target }; }
	return { policy: fallback, key: '(fallback)' };
}

/** 校验单个策略（加载期**响亮失败**，绝不静默忽略错配置 —— 照 `gate.mjs:126-131`）。 */
export function validateWritePolicy(policy, where = 'writePolicy') {
	if (!WRITE_POLICIES.includes(policy)) {
		throw new Error(`${where} 非法：${JSON.stringify(policy)}（应取 ${WRITE_POLICIES.join('|')}）`);
	}
	return policy;
}

/**
 * 校验策略表：键必须是 `<target>` 或 `<target>/<type>`，值必须在 `WRITE_POLICIES` 里。
 *
 * **在挂载期抛，不在写入期静默忽略** ✓ —— 尤其 `source:<name>`：本版**刻意不支持**（见
 * `resolveWritePolicy` 的差异 ①），所以配上去会**当场报错**，而不是"悄悄不生效"这种
 * 最难查的坏法 ✗（`dsh-memento` 的 `validateWritePolicies` 用同样口径，且它的注释原话是
 * "非法键/值在加载期响亮失败（绝不静默忽略错误配置）"）。
 *
 * @param {unknown} policies - 原始 `config.writePolicies`。
 * @returns {Record<string, string>} 合法策略表（缺省空表）。
 */
export function validateWritePolicies(policies) {
	if (policies === undefined) { return {}; }
	if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
		throw new Error(`writePolicies 必须是对象（键形如 "core" 或 "long/architecture"），收到 ${JSON.stringify(policies)}`);
	}
	for (const [key, value] of Object.entries(policies)) {
		if (!/^(core|long)(\/[a-z_]+)?$/.test(key)) {
			throw new Error(`writePolicies 键非法：${JSON.stringify(key)}（应形如 "core" / "long/architecture"；`
				+ '本版**不支持** "source:<name>" —— 我们只有一条写入路径，加了也不会有东西命中它）');
		}
		validateWritePolicy(value, `writePolicies[${JSON.stringify(key)}]`);
	}
	return /** @type {Record<string, string>} */ (policies);
}

/**
 * 认领判据：这条 `approval/request` 是不是本插件的记忆写请求。
 *
 * 两个条件都要满足：`toolName` 在写工具名单里 **且** `reason` 带 `REQUEST_MARKER` 前缀
 * （光凭工具名认不出自己 —— 别的插件也可能注册 `memory_*`，见 `REQUEST_MARKER` 的说明）。
 * 手法同 `dsh-memento` 的 `isMemoryWriteRequest`（`lib/gate.mjs:23-29`，它的注释原话是
 * "防止误伤其它插件以同名工具身份发出的审批请求"）。
 *
 * @param {unknown} req - `ApprovalRequestEvent` 形状（防御性解析）。
 * @param {readonly string[]} writeToolNames - 本插件的写工具名单（`WRITE_TOOLS`）。
 * @param {string} [marker] - 认领前缀。
 * @returns {boolean} 是否本插件的记忆写请求。
 */
export function isMemoryWriteRequest(req, writeToolNames, marker = REQUEST_MARKER) {
	if (req === null || typeof req !== 'object') { return false; }
	const candidate = /** @type {{toolName?: unknown, reason?: unknown}} */ (req);
	return typeof candidate.toolName === 'string'
		&& writeToolNames.includes(candidate.toolName)
		&& typeof candidate.reason === 'string'
		&& candidate.reason.startsWith(marker);
}

/**
 * 构造审批 reason：**第一行**人类可读摘要 + `\n` + **完整内容**（"批准即所见"）。
 *
 * 为什么要把全文放进去（而不是像从前那样只给一句泛化说明）✗→✓：
 *   ① 人批准的是**具体变更**，不是"某个工具想写点什么" —— 看不到 content 的审批等于没审批 ✓；
 *   ② 官方契约里 `PreToolDecision.ask.reason` **就是"被审计的审批理由"**
 *      （`@deepseek-ai/dsh-tools/lib/types/index.d.ts:437-442` 原话 "its `reason` is the audited
 *      approval reason"）⇒ 它随审批服务的 `approval/asked` 事件进会话日志
 *      （`dsh-user-approval/lib/types/index.js:129`）⇒ 这一步**顺带**拿到了审计，
 *      不必自建账本 ✓（这是移植 dsh-memento 审批 waterfall 时最划算的一刀）。
 *
 * ⚠ **单条不截断**：`dsh-memento` 只在 `consolidate`（批量，最多 20 条）把单条截前 300 字
 * （`lib/protocol.mjs:462-466`），单条 `add` 的载荷是全文 —— 我们照单条口径 ✓。
 *
 * @param {{content?: unknown, memoryType?: unknown, importance?: unknown, tags?: unknown, verb?: unknown}} input - 写载荷。
 *   `verb`（2026-10-13 新增 ✓）：审批里那行"要改什么"的**动词** —— `remember`（缺省 ✓，与从前逐字一样）/
 *   `forget` / `cascade` / `crystal` ✓。为什么必须泛化 ✗：批 1 那几个**改数据**的工具（软删除 / 级联 /
 *   结晶）载荷里没有 `content`，若照旧硬写 `remember` ⇒ 审批文案会**说谎**（"remember 长期记忆/fact" ✓✗），
 *   而 `parseWriteReason` 也解析不出 ⇒ 每条都退回 ask + 记一行 `(unparsable)` ✗。
 * @returns {string} 审批 reason。
 */
export function buildWriteReason({ content, memoryType, importance, tags, verb } = {}) {
	const type = typeof memoryType === 'string' && memoryType ? memoryType : 'fact';
	const action = typeof verb === 'string' && verb ? verb : 'remember';
	const parts = [REQUEST_MARKER, action, `${targetLabelOf(type)}/${type}`];
	if (Number.isFinite(importance)) {
		parts.push(`importance=${Math.trunc(/** @type {number} */ (importance))}`);
	}
	if (Array.isArray(tags) && tags.length) {
		parts.push(`tags=${tags.join(',')}`);
	}
	return `${parts.join(' ')}\n${typeof content === 'string' ? content : ''}`;
}

/**
 * 从审批 reason 反解析回结构化载荷（审计重建 + 探针往返断言用）。
 *
 * **解析不了返回 `null`**（调用方据此响亮处理）—— 不静默当成"没有载荷"✗。
 * 这也让"字段形状漂移"可被钉住：`lib/index.js` 取不到 `exec.arguments` 时产出的是一句
 * 显式说明（不是空载荷），它**必然**解析失败 ⇒ 探针红 ✓。
 *
 * @param {unknown} reason - `buildWriteReason` 的产物。
 * @returns {{verb: string, target: string, memoryType: string, importance?: number, tags?: string[], content: string} | null} 结构化载荷。
 */
export function parseWriteReason(reason) {
	if (typeof reason !== 'string') {
		return null;
	}
	// 动词由 `buildWriteReason` 的 `verb` 决定（`remember` / `forget` / `cascade` / `crystal` ✓）——
	// 2026-10-13 之前这里写死 `remember` ✗ ⇒ 新写工具全部解析失败 ⇒ 退回 ask + `(unparsable)` ✗。
	const match = /^\[vssaros-memory\] (\S+) ([^/]+)\/(\S+?)(?: importance=(-?\d+))?(?: tags=([^\n]*))?\n([\s\S]*)$/.exec(reason);
	if (match === null) {
		return null;
	}
	return {
		verb: match[1],
		target: match[2],
		memoryType: match[3],
		...(match[4] === undefined ? {} : { importance: Number(match[4]) }),
		...(match[5] === undefined || match[5] === '' ? {} : { tags: match[5].split(',') }),
		content: match[6],
	};
}

/**
 * 这次调用**到底写不写** —— 决定要不要弹窗 ✓（判据**收在一处**：写在闸里会变成一长串 `&&/||`，
 * 下一个写工具接进来时最容易漏掉其中一个 ✓；手法同 kb 的 `writeIntentOf`，`vssaros-kb/lib/index.js:1755` ✓）。
 *
 * 两类判据：
 *   · **一律问**（没有只读形态 ✓）：`memory_remember` / `memory_forget` / `memory_cascade` / `memory_crystal`。
 *   · **参数敏感**（有只读 action ✓）：`memory_routine` 的 `list` / `get` / `status` **只读** ⇒ 不弹窗 ✗；
 *     `create` / `run` / `step` / `freeze` / `delete` 会改数据 ✓；`action` 缺失/不认识 ⇒ **当写**（从严 ✓）。
 * ⚠ 不给"只读工具"留按参数放行的口子 ✗：`memory_recall` / `memory_obsidian_export` 压根不在写名单里 ✓。
 *
 * @param {string} name - 工具名（`exec.name`）。
 * @param {Record<string, unknown>} args - `exec.arguments`（**已解析**的参数 ✓）。
 * @returns {boolean} true = 这次调用会改用户数据 ⇒ 过闸 ✓。
 */
export function isWriteIntent(name, args) {
	// ⚠ 反向写：登记的**都是只读**形态（白名单 ✓）。第一版写的是"会改数据的 action 名单" ✗ ——
	//   那样 `action` 缺失/拼错时会落到 `includes('')` ⇒ 返回 false ⇒ **放行一次可能写入的调用** ✗✗
	//   （p3-07 当场抓到 ✓）。安全方向必须朝"从严"：**只有明确登记为只读的才放行**，其余一律过闸 ✓。
	const action = typeof args?.action === 'string' ? args.action : '';
	if (name === 'memory_routine') { return !['list', 'get', 'status'].includes(action); }
	if (name === 'memory_crystal') { return !['list', 'get'].includes(action); }
	if (name === 'memory_facet') { return !['query', 'get', 'stats', 'dimensions'].includes(action); }
	if (name === 'memory_team') { return action !== 'query'; }
	if (name === 'memory_mesh') { return action !== 'list'; }
	// 槽位：`list` / `get` 只读 ✓；`reflect` **算写** ✓（它把会话观察反思**写进**槽位 ⇒ 改用户数据 ⇒
	// 不能按"看着像读"放行 ✗ —— 与 `memory_sentinel` 的 `check` 同一条判据 ✓）。
	if (name === 'memory_slot') { return !['list', 'get'].includes(action); }
	// 课程：`list` / `recall` 只读 ✓（`recall` 只是检索，**不改**用户数据 ⇒ 与 `memory_recall` 同口径 ✓）；
	// `save` / `delete` 改数据 ⇒ 过闸 ✓。
	if (name === 'memory_lesson') { return !['list', 'recall'].includes(action); }
	// 行动链 / 草图 / 信号：只读面是 `list` / `get` / `threads` ✓（`sub` 缺省 ⇒ `list` ⇒ 只读 ✓，
	// 与 `memory_governance` 的 `sub` 缺省同一条从严规则 ✓）。
	// ⚠⚠ **`group` 缺失 / 拼错 ⇒ 一律当写** ✓ —— 这是从 `memory_governance` 那条
	//   "`action` 缺失/拼错 ⇒ 也当写（从严 ✓）"直接搬过来的判据 ✓。
	//   我第一版**漏了它**（只判 `sub`）⇒ 空参数会被判成"只读" ✗✗。当时靠"工具会抛错"侥幸没出事，
	//   但**那是下游兜的、不是闸判对的** ✗ —— 一旦将来给 `group` 加缺省值，就会**静默执行写操作** ✗✗。
	//   ⇒ 闸的职责是"不确定时从严"，不能指望下游一定抛错 ✓。
	if (name === 'memory_work') {
		const group = args?.group;
		if (group !== 'action' && group !== 'sketch' && group !== 'signal') { return true; }
		return !['list', 'get', 'threads'].includes(args?.sub ?? 'list');
	}
	// `check` **算写** ✓：它会就地评估并可能**触发**哨兵（改 status/triggeredAt ✓）⇒ 不能当只读放行 ✗。
	if (name === 'memory_sentinel') { return action !== 'list'; }
	if (name === 'memory_governance') {
		// 两个只读形态 ✓：`audit`（查审计 ✓）与 `bulk_delete` 的 **dry-run** ✓
		//（真源 `dry_run` **缺省就是 true** ＝ 只出计划不删 ✓ ⇒ 与 kb 那条"dry-run 不该弹窗"同一判据 ✓）。
		if (action === 'audit') { return false; }
		if (action === 'bulk_delete') { return args?.dry_run === false; }
		// 批 2d（2026-10-13）：检查点 / 快照 —— 只读形态是 **`sub === 'list'` 或 `sub` 缺失** ✓
		// ⚠ 缺省必须是**只读**（缺省 `list` ✓）：与 `dry_run` 缺省 true 同一思路 —— 用户/模型没明说时不动数据 ✓。
		// ⚠ `snapshot` 的 `restore` 是**高危写**（会用快照**覆盖**当前记忆 ✓）⇒ 绝不能被判成只读 ✗。
		if (action === 'checkpoint') { return (args?.sub ?? 'list') !== 'list'; }
		if (action === 'snapshot') { return (args?.sub ?? 'list') !== 'list'; }
		return true; // `delete` ⇒ 写 ✓；`action` 缺失/拼错 ⇒ 也当写（从严 ✓）
	}
	return true; // 名单里其余工具任何一次调用都写 ✓（含 `memory_improve` 的 reinforce/update/merge ✓）
}

/** 搜索结果的清洗：非数组即报错（不猜字段、不静默返回空）。 */
export function normalizeSearchResults(raw, limit) {
	if (!Array.isArray(raw)) {
		return { error: `网关 /search 返回的不是数组：${typeof raw}` };
	}
	// ⚠⚠ **两个位置都要读**（2026-10-14 真机实测修的 bug ✗✗）：引擎
	//   `agentMemoryProviderV2.searchMemory` 把分数写在 **`metadata.score`**
	//   （源码原文：`metadata: { score: r.score, source: r.source }` ✓），
	//   而 `amTypes.ts` 的 `IMemoryEntry` **同时**声明了顶层 `score?: number` ⇒ **两者不一致** ✗。
	//   此前这里（以及 IDE 侧 `memoryTools.ts:186`）都只读**顶层** ⇒ 真机上**恒 `undefined`** ✗✗
	//   ⇒ `memory_search` 的 render 里 `item.score === undefined ? '' : …` 那个分支**一直在走**，
	//   分数**从来没露出来过** ✓——而两侧都写成"undefined 就静默跳过" ⇒ **字段错配永不报错** ✗
	//   （这条与 p3-51 学到的"能返回点什么 ≠ 精确匹配"同属"静默降级掩盖事实"一类 ✓）。
	//   ⚠ 全仓 grep `metadata.score` **零命中** ⇒ 引擎写了这个字段但**没有任何消费方读它** ✓。
	//   ⇒ 兼容读：哪个有值用哪个（引擎将来改回顶层也不会破 ✓）。
	const scoreOf = row => {
		const v = typeof row?.score === 'number' ? row.score : row?.metadata?.score;
		return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	};
	const items = raw
		.filter(row => row && typeof row === 'object')
		.map(row => ({
			id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
			score: scoreOf(row),
		}))
		.filter(item => item.id);
	return { items: typeof limit === 'number' ? items.slice(0, limit) : items };
}

/**
 * 检索结果的**置信阈值**（2026-10-14 真机实测定的，别凭感觉改 ✗）。
 *
 * ## 为什么需要它
 * 引擎 `searchMemory` 硬编码 `fn.searchMemories(this._kv, agentId, query, 20)` ⇒
 * **每查询恒返回 20 条**，即使库里只有 1 条相关 ✓。⇒ 默认 `limit=10` 时模型看到的是
 * **1 条真相关 + 9 条噪声**，而引擎**不做任何阈值截断** ✗ —— "哪几条才算命中"的判断
 * 全被推给模型，而模型**没有**分数标尺（`(0.0027)` 和 `(0.5081)` 在它眼里只是两个小数 ✓）。
 *
 * ## 实测数据（隔离真网关，30 条记忆 / 14 个查询）
 * | 情形 | 首名分数 |
 * |---|---|
 * | 真命中（查询词在库里） | **0.507–0.508**（稳得惊人，多个不同查询都是这个值 ✓）|
 * | 部分命中（「量子力学」撞上库里的「量子纠缠」）| **0.0081** ⇒ 这才是**噪声上限** ✓ |
 * | 完全无匹配（`zzz不存在的词xyz` / 英文 `blockchain consensus`/`qqqq`）| **0.0021–0.0027** |
 * ⇒ 命中与噪声相差 **约 190 倍**；阈值取 **0.05** ＝ 噪声上限（0.0081）的 **6 倍**、
 *   命中下限（0.507）的 **1/10** ⇒ 两侧都有充足余量 ✓（取 0.1 也行，但 0.05 更保守、宁可多留 ✓）。
 * ⚠ 排序**已实测**：14/14 个查询的结果都按 score 降序 ⇒ 高置信的必然排在前面 ⇒
 *   分组不需要重排 ✓（但函数仍不假设顺序，见 `splitByConfidence` ✓）。
 */
export const SEARCH_CONFIDENCE_THRESHOLD = 0.05;

/**
 * 把检索结果按置信度分成两组（纯函数，`p3-07` 直接测它 ✓）。
 * ⚠ **分数缺失进 low**（不是 high）：没有证据就不该让模型以为"这是命中" ✓
 *   —— 与 `p3-51` 那条"引擎回空要如实说、不能美化成成功"同一纪律 ✓。
 */
export function splitByConfidence(items, threshold = SEARCH_CONFIDENCE_THRESHOLD) {
	const high = [];
	const low = [];
	for (const item of Array.isArray(items) ? items : []) {
		const s = item?.score;
		if (typeof s === 'number' && Number.isFinite(s) && s >= threshold) {
			high.push(item);
		} else {
			low.push(item);
		}
	}
	return { high, low };
}

/**
 * 注入文本的规整。
 * **稳定性优先**：同一份记忆必须产出逐字节相同的文本，否则每次 assembly 都会抖动、
 * 白白打掉 KV cache（方案里"preset 活跃期组合稳定"的同一条道理）。
 */
export function renderWorkingContext(text, { maxChars = MAX_INJECT_CHARS } = {}) {
	if (typeof text !== 'string') {
		return '';
	}
	let out = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n…（工作记忆超出 ${maxChars} 字，已截断）`;
	}
	return out;
}

/** `/stats/{agentId}` 的返回值形态未知 → 只做防御性摘要（不假装认识字段）。 */
export function summarizeStats(raw) {
	if (raw === null || typeof raw !== 'object') {
		return { summary: String(raw), keys: [] };
	}
	const keys = Object.keys(raw);
	const summary = keys
		.map(key => {
			const value = raw[key];
			const shown = typeof value === 'object' ? (Array.isArray(value) ? `[${value.length}]` : '{…}') : String(value);
			return `${key}=${shown}`;
		})
		.join(' · ');
	return { summary: summary || '(空)', keys };
}
