// @vssaros/dsh-agents — host half：把 VsSaros 的 `.agent.md` 注册成 dsh agent preset + 只读花名册页。
//
// **本包有三种挂载形态**（同一个包、三种 config；判据 = `config.persona` / `config.toolsOnly`）：
//   1. 顶层行（`cordis.patch.yml` 那一行）：扫 `~/.vssaros/agents/*/.agent.md` → `ctx.agentPresets.register()`
//      注册成 preset；提供只读页面 `/x/agents`；注册四个生命周期工具（`lib/tools.js`，带 `hostHalf` 闸）。
//      **不注册提示词 section**。
//   2. preset 内的行（本模块为每个 agent 合成的 preset 的 `plugins` 里那一行，`config.persona` = 该 agent
//      的 Markdown 正文）：只把这段人设注册成一条系统提示词 section。**不注册 preset、不开页面、不挂工具**。
//   3. preset 内的"只挂工具"行（`preset-vssaros.rows.yml` 里那一行，`config.toolsOnly: true`）：
//      只注册四个生命周期工具（无 hostHalf 闸——它管的是 host 面）。**不注册 preset、不开页面**。
//
// 状态是**每次 apply 一份**（闭包），不是模块级：同一个包里两次挂载（含 preset 内那次）不能互相看到对方
// 的注册表——模块级状态会让第二次挂载误判"已经注册过了"而整片不注册（实测踩过）。
//
// 静态 `inject` 只有 `tools`（见下方 export 的注释：可选注入会错过回合组装，真机实测 ✗）；
// 其余服务（`agentPresets` / `systemPrompt` / `webServer`+`connection` / `sessionController` /
// `sessionQuery` / `agents` / `sessionProjections`）仍是**可选注入**——写进静态 inject 会让插件
// 在缺该服务的组合里永久 pending（历史教训 ✓）。
//
// **会话内人格热切换**（2026-10-11，规范依据见 poc/dsh-p0/README.md 4.38）：
//   人格是提示词内容（会话内可变），preset 身份（工具/模型/skills）首回合后锁定——两者严格分开。
//   切换 = 往该会话的 durable inbox 注入一条 user 消息（`agent/inject` → 事件 `agent/inbox/spliced`），
//   投影 `vssaros-persona` 从该事件 fold 出"当前人格"，人设段的**函数形式**下一次装配时即取新值。
//   人格全文随消息落日志，所以历史可精确重放；工具/模型**不受影响**（要换能力只能新建会话，走 preset）。

import { randomUUID } from 'node:crypto';
import { askAssignment, cancelAssignment, createAssignment, installAssignmentTracker, listAssignments } from './assignments.js';
import { assignmentPresetIdOf, avatarColorOf, isDelegatableAgent, isShownAgent, presetIdOf, summarizeAgents, toPresetDefinition } from './core/agents.js';
import { createAgentFromDraft, deleteAgent, previewAgentDraft, resetAgentModel, setAgentMemoryLimits, setAgentSubagent } from './create.js';
import { draftFromAgentMd, modelCandidatesOf } from './core/create.js';
import { lineDiff } from './core/diff.js';
import { aggregateByPreset, liveForAgents, usageByAgent } from './core/live.js';
import { PERSONA_PROJECTION_KEY, personaProjection, personaSwitchMessage, switchedPersonaText } from './core/persona.js';
import { renderDetailPage } from './detail.js';
import { renderGroupPage } from './groupPage.js';
import { renderMemoryEvoPage } from './memoryEvoPage.js';
import { addGroupMembers, createGroup, decideGroupJoin, deleteGroup, installGroupTracker, listGroups, markGroupRead, normalizeGroupMode, postGroupMessage, removeGroupMember, setGroupAvatar, updateGroup, wakeOf } from './groups.js';
import { readLiveSessions } from './live.js';
import { markSeen, unreadSnapshot } from './seen.js';
import { backupMemory, clampMemoryChars, enableGit, gitLogOf, gitShowMemoryFile, gitStatusOf, installMemoryBackupWatcher, listBranches, listMemoryBackups, listMemoryFiles, listVersions, MEMORY_CHARS_MAX, readMemoryFile, readMemorySnapshot, restoreMemoryBackup, restoreMemoryFile, setVersion, snapshotGit, switchBranch, writeCoreMemory } from './memory.js';
// 从 AgentMemory 网关库拉一份 MEMORY.md **草稿**（只读；不落盘 —— 落盘仍走 write-memory 由人确认）
import { importMemoryDraft } from './agentmemoryImport.js';
import { ensureOutboxLoaded, outboxList, outboxRetry } from './outbox.js';
import { encodeBody } from './gzip.js';
import { botFromSoulText, importDsbBot } from './importDsb.js';
import { exportAgent, importAgent, saveExport } from './pack.js';
import { installRelay } from './relay.js';
import { renderSideviewPage } from './sideview.js';
// ★ 2026-10-19：改用 `scanAgentsFromConfig` —— 它会扫**两个**根（内置 + 自定义）并合并
//   （同 id 时自定义优先）。此前只扫自定义根 ⇒ dsh 侧**列不出任何内置 agent** ✗。
// ⚠ 2026-10-19：`agentsRootOf` / `scanAgents` 已随扫描逻辑搬进 `store.js`，但请求处理里仍在用它们
// （页面分支的 `const root = agentsRootOf(config)`、以及 `/api/unread` 与首页分支的 `scanAgents(...)`）。
// 只导入 `scanAgentsFromConfig` 会让每个 `/x/agents/*` 请求抛 `ReferenceError` ⇒ `dsh-host-webserver`
// 的 catch 回**裸 400**（无 body）⇒ 侧栏整页白屏（用户报「agents 的 sideview 不可见」）。
// 教训：这类"搬模块漏 import"只有真跑一次请求才会暴露 ⇒ 由 p3-96（页面交互探针）看守。
import { agentsRootOf, scanAgents, scanAgentsFromConfig } from './store.js';
import { addApprovalTemplate, listApprovalTemplates, removeApprovalTemplate, templateGate } from './templates.js';
import { registerAgentTools } from './tools.js';

/** 与 cordis.patch.yml 的行 id 一致。 */
export const name = 'vssaros-agents';

// 静态 inject 只收 `tools`（kanban/dashboard 同口径 ✓——工具模块的既定写法：工具在任何能跑回合的
// 模板里都存在，缺它的 profile 本就跑不了回合 ✓）。其余服务仍是可选注入（见头注释）。
// ⚠ 订正一处曾经的错误归因（2026-10-13，p3-55）：本插件工具一度在真机"unknown tool"，当时猜是
//   "可选注入错过回合组装" ✗——真根因是**工具缺 `output.render`**，dsh-tools 的 register 强制校验
//   把 apply 整个抛掉 ✓（见 tools.js 的 textOutput 注释）。静态 inject 保留是因为它是对齐口径，
//   不是因为时序。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/agents';

/**
 * 展示用名册（只做黑名单过滤）。
 * ⚠ 只影响「侧栏名册 / 编辑区页面 / `/api/agents`（聊天欢迎卡与选择器读它）」，
 *   **不影响 preset 注册** —— `saros-claw` 仍是工作流画布 Run 的默认执行 agent，
 *   注销它的 preset 会让画布跑不起来（注册留着，只是不展示）。
 */
/** 展示面名册：内置按 `.agent.md` 的 `userFacing: true` 白名单（与 IDE 同一份），自定义全显。 */
const shownAgentsOf = (agents) => (agents || []).filter(a => isShownAgent(a));
/** 人设 section 名（在 preset 自己的作用域内唯一即可）。 */
const PERSONA_SECTION_NAME = 'vssaros-agent-persona';
/** 人设 section 的位置：dsh 有中央 order 表，`DEPLOYMENT_PERSONA_PREFIX` 就是"部署级人设"该待的位置。 */
const PERSONA_ORDER_NAME = 'DEPLOYMENT_PERSONA_PREFIX';

/** dsh 的 section order 由中央表分配（`getSectionOrder`）；拿不到就退回 0。 */
function sectionOrderOf(child) {
	try {
		const order = child.systemPrompt.getSectionOrder(PERSONA_ORDER_NAME);
		return Number.isFinite(order) ? order : 0;
	} catch {
		return 0;
	}
}

/**
 * 自证/探针用（2026-10-19）：记忆注入的当前口径，按 agentId 索引。
 *   · `byAgent`：`{ mode, chars, ready, frozenSessions, served }`
 *   · `refresh`：手动重读 MEMORY.md（`p3-128` 用它验证"live 会变 / session 冻结"两条语义）
 * 为什么不放页面自证里：这段跑在 **Host**（node）；页面读不到，但探针可以直接 import 本模块。
 */
export const __promptMem = { byAgent: new Map(), refresh: new Map() };

/** 角色 2：preset 内的人设注入 + 工具 allowlist（无状态、无页面）。 */
function applyPersona(ctx, config) {
	const staticPersona = String(config.persona);
	/** 会话投影服务（装配时读当前人格；未注入则退回 preset 自带人设）。 */
	let projections;
	// 人设段的动态文本要读投影，而 section 必须注册在 **preset 作用域**（作用域遮蔽才是 dsh 的覆盖机制），
	// 所以这里也注册一份投影：同 key + 同 stateVersion 的 register 是 ref-count 共享，不会建重复单元。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		projections = child.sessionProjections;
		child.sessionProjections.register(personaProjection());
		return () => {
			projections = undefined;
		};
	}));
	// 记忆快照注入（2026-10-16；2026-10-19 升级为「可配上限 + 会话内冻结」）：
	//   · 上限 = `.agent.md` 的 `memory-chars`（缺省 2048 字符，0 = 关闭，夹 512~20000）；
	//   · 语义 = `memory-mode`：
	//       session（默认）**会话内冻结** —— 第一次装配拿到的快照，这个会话之后一直用它。
	//               为什么：装配出的 system prompt 是**前缀**，每 60s 换一次文本会让 prompt cache
	//               每轮全失效（DSB 同样用「SOUL/MEMORY 冻结快照」换缓存命中，见其文档）。
	//               代价：改了 MEMORY.md 要等**新会话**（或压缩）才生效 —— 这是有意的取舍 ✓。
	//       live   旧行为（每 60s 刷新，会话中途也会变）；显式想要"改完立刻生效"才用它。
	//   · 装配是同步的 ⇒ 文本走缓存（挂载即读 + 每分钟定时读）；定时器**两种模式都保留**，
	//     因为"新会话"要能读到最新内容。
	const memoryChars = clampMemoryChars(config.memoryChars);
	const memoryMode = config.memoryMode === 'live' ? 'live' : 'session';
	let memoryCache = '';
	let memoryReady = memoryChars <= 0;   // 关闭注入 ⇒ 视作已就绪（下面直接返回空串）
	const refreshMemory = () => {
		if (memoryChars <= 0) {
			memoryCache = '';
			memoryReady = true;
			return Promise.resolve('');
		}
		return readMemorySnapshot(config, config.agentId, memoryChars).then(text => {
			memoryCache = text;
			memoryReady = true;
			return text;
		}).catch(() => {
			memoryCache = '';
			memoryReady = true;
			return '';
		});
	};
	void refreshMemory();
	// 只在**真的会注入**时才轮询：`memory-chars: 0` = 关闭注入 ⇒ 没有任何消费方，
	// 每个 agent 一个 60s 定时器纯属白跑（N 个 agent 就是 N 个）。
	const memoryTimer = memoryChars > 0 ? setInterval(() => { void refreshMemory(); }, 60_000) : undefined;
	memoryTimer?.unref?.();
	ctx.effect(() => () => { if (memoryTimer) { clearInterval(memoryTimer); } });

	// 冻结表：**按会话**（`context.agent.session` 是每个会话自己的对象）。
	// ⚠ 拿不到会话载体时**不冻结**（退回实时）——宁可多花 token，也不假装"冻结了"却给了空串。
	const frozenMemory = new WeakMap();
	const memoryStat = { mode: memoryMode, chars: memoryChars, ready: false, frozenSessions: 0, served: 0 };
	if (config.agentId) {
		__promptMem.byAgent.set(String(config.agentId), memoryStat);
		__promptMem.refresh.set(String(config.agentId), refreshMemory);
	}
	const memoryTextFor = (context) => {
		memoryStat.ready = memoryReady;
		if (!memoryReady) {
			return '';   // 首次读取还没回来：这一轮先不注入，**也不冻结空串**
		}
		if (!memoryCache) {
			return '';
		}
		if (memoryMode === 'live') {
			memoryStat.served += 1;
			return memoryCache;
		}
		const key = context?.agent?.session ?? context?.agent ?? context?.scope;
		if (!key || typeof key !== 'object') {
			memoryStat.served += 1;
			return memoryCache;
		}
		if (!frozenMemory.has(key)) {
			frozenMemory.set(key, memoryCache);
			memoryStat.frozenSessions += 1;
		}
		memoryStat.served += 1;
		return frozenMemory.get(key);
	};

	// 人设正文与记忆快照**都为空**时不注册这条 section（空段没有信息，只是给系统提示塞一个空块）。
	// 工具 allowlist 在下面独立注册，不受这个条件影响 ✓。
	const hasSectionText = Boolean(staticPersona.trim()) || memoryChars > 0;
	if (hasSectionText) {
		ctx.inject(['systemPrompt'], child => child.effect(() => child.systemPrompt.section({
			name: PERSONA_SECTION_NAME,
			order: sectionOrderOf(child),
			// **函数形式**：每次装配按 `context.agent` 取该会话的当前人格（会话内切换过就是新的）；
			// 没切换过 / 取不到 → 退回 preset 自带人设，行为与从前完全一致。有记忆快照就追加 ✓。
			text: (context) => {
				const base = switchedPersonaText(projections, context) ?? staticPersona;
				const mem = memoryTextFor(context);
				return mem ? base + mem : base;
			},
		})));
	}

	// 工具 allowlist：`.agent.md` 的 `tools` 是 VS Code 口径，dsh 侧未必同名。
	// **只保留 dsh 里真实存在的名字**，未知名字写 Host 日志（能看到、能改）——否则一个名字对不上就会把
	// 该 Agent 的工具**静默清空**（模型突然什么都不能用，且没人知道为什么）。
	ctx.inject(['tools'], child => child.effect(() => {
		const wanted = Array.isArray(config.tools) ? config.tools.filter(t => typeof t === 'string' && t.trim()) : [];
		if (!wanted.length) {
			return;
		}
		const known = new Set((child.tools.schemas?.() ?? []).map(schema => schema?.name).filter(Boolean));
		const allow = wanted.filter(name => known.has(name));
		const unknown = wanted.filter(name => !known.has(name));
		if (unknown.length) {
			console.warn(`[vssaros-agents] agent ${config.agentId ?? '(unknown)'} 的 tools 里有 dsh 不认识的名字，已忽略：${unknown.join(', ')}`);
		}
		if (allow.length) {
			return child.tools.restrict({ allow });
		}
	}));
}

/** 一次挂载的状态（顶层角色用；页面与注册共用同一份，免得两处看到两份数据）。 */
function createState() {
	return {
		/** agentId → { presetId, fingerprint, dispose } */
		registered: new Map(),
		/** 每个 agent 的注册结果与映射缺口（页面显示，用户可见） */
		diagnostics: [],
		/** `ctx.agentPresets.list()` 的快照（证明真的进了花名册） */
		roster: [],
		/** 本轮扫描的错误 */
		errors: [],
		/**
		 * `agentPresets` **服务对象**（页面请求时用它做增量同步）。
		 * 注意：不能存 `inject` 出来的子 ctx——**回调返回后那个 ctx 就 inactive**，事后访问会抛
		 * `cannot get required service … in inactive context`（memory 模块在真机上实测 500 后统一改成存服务对象）。
		 */
		presets: null,
		/** `sessionController` 服务对象（`agent_open_session` 用；同一"存服务对象"纪律）。 */
		sessionController: null,
		/** `sessionQuery` 服务对象（`agent_read_chat` 用；同一纪律）。 */
		sessionQuery: null,
		/** 上一次成功挂上的 subagent 可选清单签名（变了才需要重挂带清单的版本）。 */
		subagentListSig: '',
		/** 正在跑的 syncPresets（并发请求复用它，避免同一时刻做两遍重注册）。 */
		syncing: null,
	};
}

/** 撤销本次挂载注册的全部 preset（幂等）。 */
async function disposeAllPresets(state) {
	const entries = [...state.registered.values()];
	state.registered.clear();
	state.roster = [];
	state.subagentListSig = '';
	for (const entry of entries) {
		try {
			await entry.dispose();
		} catch {
			/* 已失效即目标 */
		}
	}
}

/**
 * 扫 agent 目录 → 增量注册 preset。
 * 每个 agent **每次都会重算 notes**（哪怕这次不需要重新注册）——诊断是"当前映射情况"的快照，
 * 不是"本轮做了什么"的日志；只在注册时才记的话，页面第二次请求就空了（实测踩过）。
 */
async function syncPresets(state, presets, config) {
	const scan = await scanAgentsFromConfig(config, undefined);
	const provider = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim() : '';
	const errors = [...scan.errors];
	const diagnostics = [];
	// 一个 agent 可能对应**两个** preset：本体 + 委派版（`.agent.md` 写了 `model-assignment` 时，
	// 见 core/agents.js 的注释：dsh 的 `session.create` 只吃 `agentPreset`，没法在创建时覆盖模型 ⇒
	// 只能派生一个"同人格、不同 default-model"的 preset 给委派用）。
	// `state.registered` 的 key 用 `agentId` / `agentId::assign`（不用 presetId，免得与"源文件消失"判据打架）。
	const idsInScan = new Set(scan.agents.map((agent) => presetIdOf(agent.id)));

	/**
	 * 按扫描结果构造要注册的定义。
	 * @param allowedAgentPresets `null` = 不挂 `tool-subagent`（第一阶段）；数组 = 挂上动态清单。
	 */
	const buildDesired = (allowedAgentPresets) => {
		const out = [];
		for (const agent of scan.agents) {
			out.push({
				key: agent.id,
				agent,
				...toPresetDefinition(agent, {
					provider,
					...(allowedAgentPresets ? { allowedAgentPresets } : {}),
				}),
			});
			if (!agent.modelAssignment) {
				continue;
			}
			const derivedId = assignmentPresetIdOf(agent.id);
			if (idsInScan.has(derivedId)) {
				// 只在最后一次（正式那一轮）记一次，免得第一阶段重复刷同一条错误
				if (allowedAgentPresets) {
					errors.push(`agent ${agent.id} 的 model-assignment 被忽略：派生 preset ${derivedId} 与另一个 agent 的 preset 撞名`);
				}
				continue;
			}
			out.push({
				key: `${agent.id}::assign`,
				agent,
				// 派生 preset 刻意**不带** `allowedAgentPresets`（不再 fan-out，见 core/agents.js 注释）
				...toPresetDefinition(agent, { provider, modelOverride: agent.modelAssignment, idSuffix: '-assign', nameSuffix: ' · 委派' }),
			});
		}
		return out;
	};

	/**
	 * @param allowedAgentPresets `null` = 不带清单（第一阶段）；数组 = 带清单
	 * @param record 是否写诊断（只有最后一轮记，免得同一个 agent 记两条）
	 * @param only 只处理这些 key（`undefined` = 全部）。第一阶段用它把影响面收窄到"新增的 preset"。
	 */
	const applyDesired = async (allowedAgentPresets, record, only) => {
		for (const { key, agent, definition, notes } of buildDesired(allowedAgentPresets)) {
			if (only && !only.has(key)) {
				continue;
			}
			// 指纹直接取定义本身（含派生 preset 的模型行 + 子代理清单）——比手写字段清单更不容易漏
			const fingerprint = JSON.stringify(definition);
			const existing = state.registered.get(key);
			if (existing && existing.fingerprint === fingerprint) {
				if (record) {
					diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: false });
				}
				continue;
			}
			if (existing) {
				// 定义变了：先撤旧的再注册（`register` 对重名会失败，不能直接覆盖）
				try {
					await existing.dispose();
				} catch (e) {
					errors.push(`撤销旧定义失败（${key}）：${String(e?.message ?? e)}`);
				}
				state.registered.delete(key);
			}
			try {
				const dispose = await presets.register(definition);
				state.registered.set(key, { presetId: definition.id, fingerprint, dispose });
				if (record) {
					diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: true });
				}
			} catch (e) {
				// 注册失败要看得见（dsh 侧自己的花名册也会留一条带诊断的失败行，但那是它的口径）
				errors.push(`注册 preset 失败（${definition.id}）：${String(e?.message ?? e)}`);
				if (record) {
					diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes: [...notes, '注册失败'], changed: true });
				}
			}
		}
	};

	// ── 两阶段注册（2026-10-19 引入，2026-10-20 收窄）───────────────────────────────
	// 为什么需要两阶段：`tool-subagent` 激活时会 `readDocument` 清单里的**每个** preset id，
	// 未知 id 直接 reject ⇒ 整个 preset 起不来。所以"清单里引用了本次才注册的 preset"时，
	// 必须先把那个 preset 挂上，再挂带清单的版本。
	//
	// 2026-10-20 收窄（用户报"删 agent 后 UI 慢"后续）：原先只要**任何**新增就重挂**全部**
	// preset（无清单版）⇒ 新建一个普通 agent 也会把 N 个 preset 白撤白挂两轮。现在：
	//   · 第一阶段**只处理缺失的 key**；
	//   · 且只有当"缺失的那个 preset 本身在委派清单里"（= 别人会引用它）时才需要第一阶段；
	//     普通 agent（没标 `subagent: true`）不在任何清单里 ⇒ 直接带清单注册一次即可。
	const wantedKeys = buildDesired(null).map((item) => item.key);
	const missingKeys = wantedKeys.filter((key) => !state.registered.has(key));
	// 委派清单用 **isDelegatableAgent**（2026-10-20，与页面可见性**刻意分开**）：
	//   · 页面是全量管理面（看不到就改不了）⇒ `isShownAgent` 只做黑名单；
	//   · 委派是"把活派给谁"⇒ 只给显式标了 `subagent: true` 的 agent（opt-in）。
	const shownIds = new Set((scan.agents || []).filter((agent) => isDelegatableAgent(agent)).map((agent) => agent.id));
	const delegatablePresetIds = new Set([...shownIds].map((id) => presetIdOf(id)));
	const needFirstPass = missingKeys.some((key) => !key.endsWith('::assign') && delegatablePresetIds.has(presetIdOf(key)));
	if (needFirstPass) {
		await applyDesired(null, false, new Set(missingKeys));
	}
	const okPresetIds = [...state.registered.entries()]
		.filter(([key]) => !key.endsWith('::assign') && shownIds.has(key))
		.map(([, entry]) => entry.presetId)
		.sort();
	// 第二阶段：带动态清单（已一致的 preset 指纹相同 ⇒ 直接跳过，不会重复注册）
	await applyDesired(okPresetIds, true);
	state.subagentListSig = okPresetIds.join('|');
	const seenKeys = new Set(wantedKeys);
	// 源文件消失（或委派模型被删掉）的 preset：撤掉（只增不删会让花名册里留幽灵）
	for (const [key, entry] of [...state.registered]) {
		if (seenKeys.has(key)) {
			continue;
		}
		try {
			await entry.dispose();
		} catch {
			/* 已失效即目标 */
		}
		state.registered.delete(key);
		diagnostics.push({ agentId: key.replace(/::assign$/, ''), presetId: entry.presetId, rows: 0, notes: ['源文件已消失 → 已注销该 preset'], changed: true });
	}
	try {
		const roster = await presets.list();
		state.roster = roster.map(p => p.id).filter(id => typeof id === 'string').sort();
	} catch (e) {
		errors.push(`读取花名册失败：${String(e?.message ?? e)}`);
	}
	state.diagnostics = diagnostics;
	state.errors = errors;
	return scan;
}

/**
 * 串行化 `syncPresets`：同一时刻只跑一遍，后来的调用者**复用**在飞的那个 promise。
 *
 * 为什么需要：删除 agent 会触发一次 O(N²) 的全量重注册（见 delete 分支注释）。如果这时页面
 * 立刻又发来一个渲染请求，它也会调 syncPresets ⇒ 两遍重注册并互相 dispose 对方的 preset，
 * 又慢又容易冒出"刚注册就被撤"的抖动。复用同一个 promise 后，页面请求只等它跑完。
 */
function syncOnce(state, presets, config) {
	if (!presets) {
		return Promise.resolve();
	}
	if (state.syncing) {
		return state.syncing;
	}
	state.syncing = syncPresets(state, presets, config).finally(() => {
		state.syncing = null;
	});
	return state.syncing;
}

/** 读请求体并解析 JSON（空体 → `{}`）。 */
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	return text ? JSON.parse(text) : {};
}

/** `@deepseek-ai/dsh-llm` 的消息工厂；拿不到就由核心模块自组消息（运行期无校验，安全）。 */
async function loadCreateUserMessage() {
	try {
		const mod = await import('@deepseek-ai/dsh-llm');
		return typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : undefined;
	} catch {
		return undefined;
	}
}

/** 人设段此刻渲染出的文本（只留头部与字节数，别把整段人设塞进响应）。 */
async function renderedPersona(state, agent) {
	try {
		const systemPrompt = state.systemPrompt;
		if (!systemPrompt?.assemble) {
			return undefined;
		}
		// 手工装配是**纯读**：不写任何会话事件（loop 才写）。作用域给 agent（与 loop 的 assembleContextFor 同形）。
		const assembly = await systemPrompt.assemble({ agent, scope: agent });
		const section = assembly?.sections?.find(s => s.name === PERSONA_SECTION_NAME);
		if (typeof section?.text !== 'string') {
			return undefined;
		}
		return { bytes: Buffer.byteLength(section.text, 'utf8'), head: section.text.slice(0, 120) };
	} catch (e) {
		return { error: String(e?.message ?? e) };
	}
}

/** 读某会话当前生效的人格（没切换过 → personaId=null）；顺带回读人设段此刻渲染的文本。 */
async function readPersona(state, sessionId) {
	const id = String(sessionId ?? '').trim();
	if (!id) {
		throw new Error('需要 sessionId');
	}
	const agent = state.agents?.get?.(id);
	if (!agent) {
		throw new Error(`会话不在运行：${id}`);
	}
	const current = state.projections?.stateOf?.(agent.session, PERSONA_PROJECTION_KEY);
	return {
		sessionId: id,
		personaId: current?.personaId ?? null,
		name: current?.name ?? null,
		atSeq: current?.atSeq ?? -1,
		rendered: await renderedPersona(state, agent),
	};
}

/**
 * 会话内切换人格：把"切换指令"注入该会话的 durable inbox。
 *
 * `agent.inject` = 投进 next-step 队列、**不唤醒**：会话空闲时它与用户下一条消息同批被 claim（模型只
 * 回答用户，不会对切换指令自说自话起一轮）；正在跑的回合则落在其下一个 step。切换事实落成 dsh 已登记的
 * `agent/inbox/spliced` 事件（不新增事件类型），投影据此更新 → 下一步装配的 system prompt 即新人格。
 * @param state 顶层角色状态（含 `agents` / `projections`）
 * @param config 本行 config（取 agentsRoot）
 * @param body `{ sessionId, personaId }` 切换；`{ sessionId, clear: true }`（或 personaId 为空）= 切回
 *             preset 自带人设（同样落一条事件，所以"清除"也可重放）
 */
async function switchPersona(state, config, body) {
	const sessionId = String(body?.sessionId ?? '').trim();
	const personaId = String(body?.personaId ?? '').trim();
	// `presetId`：chat-surface 只知道 **preset id**（`vssaros-<slug>` —— 它列的是 dsh 花名册里的 id），
	// 而这里要的是 agent id。映射真源是 `presetIdOf`（id 经过 slug 化 ⇒ 页面侧反推不可靠 ✗），
	// 所以把"preset id → agent id"的解析放在宿主侧（2026-10-11，Commands「Agent」行接进来的）。
	const presetId = String(body?.presetId ?? '').trim();
	const clear = body?.clear === true || (!personaId && !presetId);
	if (!sessionId) {
		throw new Error('需要 sessionId');
	}
	const agent = state.agents?.get?.(sessionId);
	if (!agent) {
		throw new Error(`会话不在运行，无法热切换：${sessionId}`);
	}
	if (typeof agent.inject !== 'function') {
		throw new Error('该会话的 agent 不支持 inject（dsh 版本不匹配？）');
	}
	const createUserMessage = await loadCreateUserMessage();
	if (clear) {
		agent.inject(personaSwitchMessage(null, { clear: true, createUserMessage, uuid: () => randomUUID() }));
		return { sessionId, personaId: null, name: null, cleared: true };
	}
	const scan = await scanAgentsFromConfig(config);
	// 两种指定方式：`personaId`（= agent id，直接命中）/ `presetId`（= 花名册 id，经 `presetIdOf` 反查）。
	//
	// ★★ 2026-10-19（真机）：**再按显示名兜底一次**。
	//   模型调 `agent_switch_persona` 时经常传**中文显示名**（`知识库专家`），而这里有史以来只按 **id**
	//   （`knowledge-base-expert`）精确匹配 ⇒ 直接报"未知人格"，模型于是以为"没有这个 agent" ✗
	//   （它接着调 agent_list，看到的是英文 id，仍然对不上 ⇒ 得出错误结论）。
	//   ⇒ id 找不到就按 `name` 找一次（大小写/首尾空白已在上游 trim；显示名在本仓是唯一的 ✓）。
	//   ⚠ 顺序必须是 **id 优先**：显示名可能与他人重名，id 才是稳定标识。
	let target = personaId ? scan.agents.find(a => a.id === personaId) : undefined;
	if (!target && personaId) {
		target = scan.agents.find(a => typeof a.name === 'string' && a.name === personaId);
	}
	if (!target && !personaId) {
		target = scan.agents.find(a => presetIdOf(a.id) === presetId);
	}
	if (!target) {
		// 报错时**把可选名单一起给出来**（模型据此自我纠正；否则它只会反复试同一个名字 ✗）
		const hint = scan.agents.length
			? `可用：${scan.agents.map(a => `${a.id}（${a.name}）`).join('、')}`
			: '当前没有任何 agent（检查 agents 目录）';
		throw new Error(personaId ? `未知人格：${personaId}。${hint}` : `未知 preset：${presetId}。${hint}`);
	}
	if (!target.persona) {
		throw new Error(`该人格没有正文，无法切换：${personaId}`);
	}
	agent.inject(personaSwitchMessage(target, { createUserMessage, uuid: () => randomUUID() }));
	return {
		sessionId,
		personaId: target.id,
		name: target.name,
		personaBytes: Buffer.byteLength(target.persona, 'utf8'),
	};
}

/** 角色 1：顶层（注册 preset + 页面）。 */
function applyTopLevel(ctx, config) {
	const state = createState();
	// 审批模板闸谓词（2026-10-16，P2）：tools.js 的 pre-execute 先查它；读失败按"没有"（照常问 ✓）。
	state.approvalTemplates = templateGate(config);

	// 会话投影（顶层再注册一份，与 preset 作用域那份共享同一个单元）——切换后 UI/诊断按 sessionId 读它。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		state.projections = child.sessionProjections;
		child.sessionProjections.register(personaProjection());
		return () => {
			state.projections = undefined;
		};
	}));

	// 人格热切换要按 sessionId 找到**活的 agent**：dsh 的 `agents.get(id)` 用的就是 agent/session 共享 id。
	// `systemPrompt` 一起注入，用来回读人设段此刻渲染出的文本（诊断与 e2e 断言用）。
	ctx.inject(['agents', 'systemPrompt'], child => child.effect(() => {
		state.agents = child.agents;
		state.systemPrompt = child.systemPrompt;
		return () => {
			state.agents = undefined;
			state.systemPrompt = undefined;
		};
	}));

	// `agent_open_session` 的会话创建入口（`sessionController.create` 收 `agentPreset`，契约见
	// `dsh-api-session-controller` 的 `SessionCreateRequest`）；`agent_read_chat` 的历史检索入口
	// （`sessionQuery.filterEvents` 的字面子句，`dsh-session-query` ✓）。
	ctx.inject(['sessionController'], child => child.effect(() => {
		state.sessionController = child.sessionController;
		return () => {
			state.sessionController = undefined;
		};
	}));
	ctx.inject(['sessionQuery'], child => child.effect(() => {
		state.sessionQuery = child.sessionQuery;
		return () => {
			state.sessionQuery = undefined;
		};
	}));

	// 生命周期工具（2026-10-13，P2）。`hostHalf`：B1 ② 就绪后由 host 行携带 ⇒ host 面让出工具，
	// preset 里的 toolsOnly 行继续提供（缺省 = 注册，零行为改变）。
	ctx.effect(() => {
		if (config.hostHalf === true) {
			return undefined;
		}
		return registerAgentTools(ctx, config, state);
	});

	// 回复自动回传（2026-10-13，P3.2）：宿主面监听全部会话的 turn-stopping（与 memory 自动沉淀
	// 同一钩子 ✓）。只装顶层角色——toolsOnly（preset 内）的事件视野未证，不装 ✓。
	ctx.effect(() => installRelay(ctx, config, state));
	// 委派台账跟踪（2026-10-16，P1）：同一钩子、同一事件视野判据 ✓（lib/assignments.js 头注释）。
	ctx.effect(() => installAssignmentTracker(ctx, config, state));
	// 群聊回复回收（2026-10-16，二期）：同一钩子（lib/groups.js 头注释——承载面为何自托管写在那里 ✓）。
	ctx.effect(() => installGroupTracker(ctx, config, state));
	// 记忆自动备份（2026-10-21）：回合结束 ⇒ 记忆变了就留一份档（DSB 的「一次对话结束」口径）。
	ctx.effect(() => installMemoryBackupWatcher(ctx, config));
	// Outbox 读回（2026-10-16 二期）：启动即把盘上"等回收"的条目读回内存——relay/群聊的 tracker
	// 按 messageId 从 outbox 取 pending ⇒ 重启后回收自动续上 ✓（读失败按空队列，不炸激活 ✓）。
	ctx.effect(() => {
		void ensureOutboxLoaded(config);
		return undefined;
	});

	ctx.inject(['agentPresets'], child => child.effect(() => {
		state.presets = child.agentPresets; // ← 回调内取服务对象（子 ctx 事后就 inactive 了）
		// 注册是异步的（`register` 返回 Promise<disposer>）：登记 in-flight，卸载时先等它落地再撤销，
		// 否则会出现"卸载后又注册回来"的泄漏。
		const inflight = (async () => {
			try {
				await syncPresets(state, state.presets, config);
			} catch (e) {
				state.errors = [...state.errors, `扫描 agent 目录失败：${String(e?.message ?? e)}`];
			}
		})();
		return async () => {
			state.presets = null;
			await inflight.catch(() => undefined);
			await disposeAllPresets(state);
		};
	}));

	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pathname = url.pathname;
			const root = agentsRootOf(config);
			// 会话内人格热切换（GET 读当前人格 / POST 切换）：与只读花名册页同前缀，聊天页同源可直接 fetch，
			// 不必绕 IDE——切换只依赖 Host 侧（agents + 投影 + durable inbox），不新建会话、不新建视图。
			if (pathname === `${ROUTE_PREFIX}/api/persona`) {
				try {
					if (req.method === 'GET') {
						const current = await readPersona(state, url.searchParams.get('sessionId'));
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(current));
					} else if (req.method === 'POST') {
						const switched = await switchPersona(state, config, await readJsonBody(req));
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(switched));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(String(e?.message ?? e));
				}
				return;
			}
			// 委派 API（2026-10-16，P1）：GET 列表 / POST 创建（默认）· ask 追问 · cancel 中断。
			// 错误带 HTTP 语义（assignments.js 的 httpError：409 = 并发满/状态冲突，404 = 无此委派）✓。
			if (pathname === `${ROUTE_PREFIX}/api/assignments`) {
				try {
					if (req.method === 'GET') {
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(await listAssignments(config)));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						const action = typeof body?.action === 'string' && body.action.trim() ? body.action.trim() : 'create';
						const result = action === 'create' ? await createAssignment(config, state, body)
							: action === 'ask' ? await askAssignment(config, state, body)
								: action === 'cancel' ? await cancelAssignment(config, state, body)
									: (() => { throw Object.assign(new Error(`未知 action：${action}（支持 create/ask/cancel）`), { httpStatus: 400 }); })();
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(result));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}) }));
				}
				return;
			}
			// 审批模板 API（2026-10-16，P2）：GET 清单 + 可模板化封闭集 / POST add·remove。
			// 只覆盖本包 WRITE_TOOLS（templates.js ① ✓）；加删走插件自己的配置文件（写口同 kanban 判据 ✓）。
			if (pathname === `${ROUTE_PREFIX}/api/approval-templates`) {
				try {
					if (req.method === 'GET') {
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(await listApprovalTemplates(config)));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						const action = typeof body?.action === 'string' && body.action.trim() ? body.action.trim() : '';
						const templates = action === 'add' ? await addApprovalTemplate(config, body)
							: action === 'remove' ? await removeApprovalTemplate(config, body)
								: (() => { throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 add/remove）`), { httpStatus: 400 }); })();
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ templates }));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			// 群聊 API（2026-10-16，二期）：GET 清单 / POST create·message·delete。
			// 承载面为何是"自托管群对话区"而不是 dsh 群会话：lib/groups.js 头注释 ★ 留痕 ✓。
			if (pathname === `${ROUTE_PREFIX}/api/groups`) {
				try {
					if (req.method === 'GET') {
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(await listGroups(config)));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						const action = typeof body?.action === 'string' && body.action.trim() ? body.action.trim() : '';
						const result = action === 'create' ? await createGroup(config, body)
							: action === 'message' ? await postGroupMessage(config, state, body)
								: action === 'delete' ? await deleteGroup(config, body)
									// 2026-10-21（对齐 DSB 的频道设置）：改名 / 唤醒策略 / 邀请 / 移出
									: action === 'rename' ? await updateGroup(config, body)
										: action === 'mode' ? await updateGroup(config, body)
											: action === 'invite' ? await addGroupMembers(config, body)
												: action === 'remove' ? await removeGroupMember(config, body)
													// 加入需确认（2026-10-21）：群级开关 + 待确认队列
													: action === 'approval' ? await updateGroup(config, body)
														: action === 'join-decide' ? await decideGroupJoin(config, body)
															// 已读游标（2026-10-21）：页面把"当前群看完了"上传，unread 从这里重新算
															: action === 'read' ? await markGroupRead(config, body)
														// 群头像（2026-10-21）：页面先裁成 256×256、压到 96KB 以内再传
														: action === 'avatar' ? await setGroupAvatar(config, body)
													: (() => { throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 create/message/delete/rename/mode/invite/remove/read）`), { httpStatus: 400 }); })();
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(result));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			// 记忆 API（2026-10-16，二期）：GET ?agent= 文件+Git 状态（&file= 读内容）/ POST enable-git·snapshot。
			// 写口只有「启用 Git」与「提交快照」两个（git 子进程）；模型没有记忆 CRUD 工具 ✗（拍板点 ③⑤）。
			if (pathname === `${ROUTE_PREFIX}/api/memory`) {
				try {
					if (req.method === 'GET') {
						// ⚠ 2026-10-19 修：这个 `agent` 校验原先在**方法分支之前**，导致 POST（body 里带 agent、
						//   query 不带）一律 400 —— 页面的「启用 Git / 提交快照」两个按钮因此一直是坏的（只把错误
						//   显示在 note 里，没人注意）。GET 才要求 query 参数；POST 以 body 为准、query 兜底。
						const agentId = String(url.searchParams.get('agent') ?? '').trim();
						if (!agentId) {
							throw Object.assign(new Error('需要 agent 参数'), { httpStatus: 400 });
						}
						const file = url.searchParams.get('file');
						// `gitLogOf` 复用刚算出的 status（旧实现三项并行 ⇒ `gitStatusOf` 在一个请求里跑两遍，
						// 一次页面加载就是 8~10 个 git 子进程）。历史条数支持 `?limit=`（缺省 20、上限 100）。
						const [listing, git] = await Promise.all([
							listMemoryFiles(config, agentId),
							gitStatusOf(config, agentId),
						]);
						const log = await gitLogOf(config, agentId, git, url.searchParams.get('limit'));
						// `&rev=<hash>`：读**历史版本**里的这个文件（只读；2026-10-19 记忆面板的「看这版」）
						// `&against=<hash|working>`：再给一份"另一个版本"，服务端算行级 diff（「对比当前」）
						const rev = (url.searchParams.get('rev') ?? '').trim();
						const against = (url.searchParams.get('against') ?? '').trim();
						let content = null;
						let diff = null;
						if (rev) {
							content = await gitShowMemoryFile(config, agentId, rev, file || 'MEMORY.md');
							if (against) {
								const other = against === 'working'
									? await readMemoryFile(config, agentId, file || 'MEMORY.md')
									: await gitShowMemoryFile(config, agentId, against, file || 'MEMORY.md');
								diff = { against, leftRev: content.rev, ...lineDiff(content.text, other.text) };
							}
						} else if (file) {
							content = await readMemoryFile(config, agentId, file);
						}
						// 记忆口径（2026-10-19，P1-2）：页面要能显示「用了多少 / 上限多少 / 什么时候生效」。
						// 数据源 = 扫描出的 agent（`memory-chars`/`memory-mode`）+ 当前 MEMORY.md 实际字符数。
						const scanned = await scanAgents(root, undefined).catch(() => ({ agents: [] }));
						const meta = (scanned.agents ?? []).find(a => a.id === agentId);
						const limitChars = clampMemoryChars(meta?.memoryChars);
						// 直接读一次（`listing` 只说明存在性；先 some 再读等于同一个文件碰两次）
						const memoryText = await readMemoryFile(config, agentId, 'MEMORY.md').catch(() => null);
						// `&versions=1`：版本（tag）清单 —— 只有演化面板要，普通页面请求不必多跑一条 git
						const versions = url.searchParams.get('versions') === '1'
							? await listVersions(config, agentId).catch(() => ({ enabled: false, versions: [] }))
							: undefined;
						// `&backups=1`：备份列表（2026-10-21，演化面板的「备份」标签）
						const backups = url.searchParams.get('backups') === '1'
							? await listMemoryBackups(config, agentId).catch(() => ({ backups: [], keep: 0 }))
							: undefined;
						// `&branches=1`：分支清单（2026-10-21，记忆演化的「分支」）
						const branches = url.searchParams.get('branches') === '1'
							? await listBranches(config, agentId).catch(() => ({ enabled: false, current: '', branches: [], dirty: 0 }))
							: undefined;
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({
							agent: agentId,
							...listing,
							git,
							log: log.log,
							...(versions ? { versions: versions.versions } : {}),
			...(backups ? { backups: backups.backups, backupKeep: backups.keep } : {}),
			...(branches ? { branches: branches.branches, branch: branches.current, branchDirty: branches.dirty } : {}),
							content,
							diff,
							limits: {
								chars: limitChars,
								mode: meta?.memoryMode ?? 'session',
								personaChars: meta?.persona?.length ?? 0,
								max: MEMORY_CHARS_MAX,
								// 装配时的**真实**口径（`applyPersona` 写进 __promptMem 的那份）：
								// 页面据此显示"已装配 N 次 / 冻结 M 会话"，并与上面的上限对账 ——
								// 两个来源不同（这里是扫 .agent.md，那边是 preset config），对不上就说明
								// preset 还没按新口径重建。`null` = 该 agent 的 preset 从未挂载过。
								runtime: (() => {
									const rt = __promptMem.byAgent.get(agentId);
									return rt
										? { mode: rt.mode, chars: rt.chars, ready: rt.ready, served: rt.served, frozenSessions: rt.frozenSessions }
										: null;
								})(),
							},
							usage: { chars: memoryText?.text.length ?? 0, limit: limitChars, injected: limitChars > 0 ? Math.min(memoryText?.text.length ?? 0, limitChars) : 0 },
						}));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						const action = typeof body?.action === 'string' ? body.action.trim() : '';
						// body 为准，query 兜底（页面的 POST 不带 query；脚本可能两处都带）
						const target = String(body?.agent ?? url.searchParams.get('agent') ?? '').trim();
						if (!target) {
							throw Object.assign(new Error('需要 agent'), { httpStatus: 400 });
						}
						// 2026-10-19（P1-2）：新增两个**人工**写口 ——
						//   write-memory：整篇写 `MEMORY.md`（超 20000 字符直接 400，不静默截断）
						//   set-limits  ：只改 `.agent.md` 的 `memory-chars`/`memory-mode`（正文逐字不动）
						// 两者都不给模型开（模型写记忆走自己的文件工具），这里是人在页面上编辑 ✓。
						const result = action === 'enable-git' ? await enableGit(config, target)
							// 提交快照 / 回滚**之前**先自动备份一份（DSB 同口径：恢复错了还能回来）
						: action === 'snapshot' ? await (async () => {
							await backupMemory(config, target, 'before-snapshot').catch(() => null);
							return snapshotGit(config, target, body?.message);
						})()
								: action === 'write-memory' ? await writeCoreMemory(config, target, body?.text)
									: action === 'set-limits' ? await setAgentMemoryLimits(config, target, { chars: body?.chars, mode: body?.mode })
										// 回滚：只覆盖那一个文件（不是 git checkout），随后自动提交一条快照 ✓
										: action === 'restore' ? await (async () => {
							await backupMemory(config, target, 'before-restore').catch(() => null);
							return restoreMemoryFile(config, target, body?.rev, body?.file || 'MEMORY.md', body?.message);
						})()
							// 版本（tag）：演化面板的「版本」标签（2026-10-21）
							: action === 'version-add' ? await setVersion(config, target, body?.tag, false, body?.rev)
								: action === 'version-remove' ? await setVersion(config, target, body?.tag, true)
									// 备份（2026-10-21，演化面板的「备份」标签）
									: action === 'backup' ? await backupMemory(config, target, body?.reason || 'manual')
										: action === 'restore-backup' ? await restoreMemoryBackup(config, target, body?.backup)
											// 分支（2026-10-21）：从某次提交拉新分支 / 切回已有分支
											: action === 'branch-create' ? await switchBranch(config, target, { name: body?.name, create: true, from: body?.from })
												: action === 'branch-switch' ? await switchBranch(config, target, { name: body?.name, create: false })
											// 从记忆库拉**草稿**（2026-10-20，P1-1）：只返回文本、**不写盘** ——
											// 人看过、删改过才走 write-memory，与"提交只能人按"同一条纪律 ✓
											: action === 'import-draft' ? await importMemoryDraft(config, target, { limit: body?.limit })
												: (() => { throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 enable-git/snapshot/write-memory/set-limits/restore/import-draft）`), { httpStatus: 400 }); })();
						if (action === 'set-limits' && state.presets) {
							// 改了记忆口径 ⇒ 该 agent 的 preset 定义变了（persona row 的 config），必须重新注册
							await syncPresets(state, state.presets, config).catch(e => {
								state.errors = [...state.errors, `改记忆上限后同步 preset 失败：${String(e?.message ?? e)}`];
							});
						}
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(result));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			// Outbox API（2026-10-16，二期）：GET 队列 / POST retry（手动重发 unknown-outcome，
			// **没有自动重发口** ✗——结果不确定时自动重发会重复 ✓）。
			if (pathname === `${ROUTE_PREFIX}/api/outbox`) {
				try {
					if (req.method === 'GET') {
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(await outboxList(config)));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						if (body?.action !== 'retry') {
							throw Object.assign(new Error(`未知 action：${body?.action ?? '(空)'}（只支持 retry——重发必须是人点的）`), { httpStatus: 400 });
						}
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(await outboxRetry(config, state, body)));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			// 新建 Agent（2026-10-16，方案 A / Q7 ①：插件直接写 .agent.md，只新建不覆盖 —— lib/create.js 头注释）。
			// POST { action: 'validate', draft } ⇒ 只校验，返回 errors / warnings / 序列化原文（向导实时预览）；
			// POST { action: 'create', draft } ⇒ 写盘 + 立刻增量同步 preset（不用重启 Host）。GET 仍走下面的花名册。
			if (pathname === `${ROUTE_PREFIX}/api/agents` && req.method === 'POST') {
				try {
					const body = await readJsonBody(req);
					const action = typeof body?.action === 'string' ? body.action.trim() : '';
					let result;
					if (action === 'validate') {
						result = await previewAgentDraft(config, body?.draft);
					} else if (action === 'parse') {
						// 导入 .agent.md：服务端解析（与扫描目录同一个解析器），再走同一套校验 ✓
						const parsed = draftFromAgentMd(body?.text);
						if (parsed.error) {
							throw Object.assign(new Error(parsed.error), { httpStatus: 400 });
						}
						result = await previewAgentDraft(config, parsed.draft);
					} else if (action === 'create') {
						const created = await createAgentFromDraft(config, body?.draft);
						if (state.presets) {
							await syncPresets(state, state.presets, config).catch(e => {
								state.errors = [...state.errors, `同步 preset 失败：${String(e?.message ?? e)}`];
							});
						}
						result = { ...created, registered: state.roster.includes(created.presetId) };
					} else if (action === 'seen') {
						// 点开一个 Agent ⇒ 记「看到了此刻」（侧栏未读角标清零；lib/seen.js 头注释有口径）
						const id = typeof body?.id === 'string' ? body.id.trim() : '';
						if (!id) {
							throw Object.assign(new Error('seen 需要 id'), { httpStatus: 400 });
						}
						await markSeen(config, id);
						const live = await readLiveSessions(config).catch(() => null);
						// ⚠ 这个 POST 分支在 GET 页面段的 `scan` 之前 ⇒ 自己扫（p3-115 C2 抓到过 ✗「scan is not defined」）
						const scanNow = live ? await scanAgents(agentsRootOf(config), undefined) : null;
						result = { ok: true, counts: live && scanNow ? await unreadSnapshot(config, scanNow.agents, live.rows) : {} };
					} else if (action === 'delete') {
						// 删除 Agent（2026-10-20，侧栏右键）。口径见 lib/create.js 的 deleteAgent：
						// 只删自定义目录、内置 403、必须真的有 .agent.md；preset 靠随后的 syncPresets 注销。
						const removed = await deleteAgent(config, body?.id);
						// ⚠ 2026-10-20（用户报「删除后 UI 刷新慢」）：**不在请求里等重注册**。
						//   实测真机 delete 请求 1097ms，而文件删除 + 扫描只要 ~10ms —— 那 1 秒全花在
						//   `syncPresets` 上：删掉一个 agent 会改变**所有** preset 的 `allowedAgentPresets`
						//   ⇒ 每个 preset 都要 dispose + register；而 `tool-subagent` 激活时会对清单里
						//   **每个 id** 调 `agentPresets.readDocument()`，那是个 O(N) 的 YAML dump
						//   ⇒ 整体 O(N²)（19 个 agent ≈ 360 次 dump）。
						//   改成：先回执（页面立刻能把行移除），重注册丢到后台；下一次页面请求会
						//   复用同一个 in-flight promise（`syncOnce`），不会做两遍。
						result = { ...removed, registered: false, syncScheduled: !!state.presets };
						if (state.presets) {
							setImmediate(() => {
								void syncOnce(state, state.presets, config).catch(e => {
									state.errors = [...state.errors, `删除后同步 preset 失败：${String(e?.message ?? e)}`];
								});
							});
						}
					} else if (action === 'set-subagent') {
						// 「允许被 subagent 选用」开关（2026-10-20）。这个开关会改变**所有** preset 的
						// `allowedAgentPresets` ⇒ 必须重新注册（这次是真的变了，不是白折腾）。
						const toggled = await setAgentSubagent(config, body?.id, body?.enabled === true);
						if (state.presets) {
							await syncOnce(state, state.presets, config).catch(e => {
								state.errors = [...state.errors, `改委派开关后同步 preset 失败：${String(e?.message ?? e)}`];
							});
						}
						result = { ...toggled, registered: state.roster.includes(toggled.presetId) };
					} else if (action === 'resetModel') {
						// 「映射说明」里的「改为跟随默认」：只删未映射的 model 行（lib/create.js 头注释）⇒ 立刻重注册 preset
						const reset = await resetAgentModel(config, body?.id);
						if (state.presets) {
							await syncPresets(state, state.presets, config).catch(e => {
								state.errors = [...state.errors, `同步 preset 失败：${String(e?.message ?? e)}`];
							});
						}
						result = reset;
					} else {
						throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 validate/parse/create/resetModel）`), { httpStatus: 400 });
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify(result));
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e), ...(Array.isArray(e?.errors) ? { errors: e.errors } : {}) }));
				}
				return;
			}
			// ── Agent 打包 / 导入（2026-10-19，P0-3；包格式与安全口径见 lib/pack.js 头注释）────────
			//   GET  /api/export?id=..&memory=0|1              → 直接回 zip 字节（脚本/curl 最好用）
			//   POST /api/export {action:'save', id, memory}   → 写到 <dataRoot>/exports 并回路径
			//        （页面拿不到浏览器的下载动作，但宿主有 bridge.reveal(path) ⇒ 落盘再定位最可靠）
			//   POST /api/import {zip:'<base64>', overwrite}   → 装回 agentsRoot，随即增量同步 preset
			if (pathname === `${ROUTE_PREFIX}/api/export`) {
				if (req.method === 'GET') {
					try {
						const id = url.searchParams.get('id') ?? '';
						const pack = await exportAgent(config, id, { includeMemory: url.searchParams.get('memory') !== '0' });
						res.writeHead(200, {
							'content-type': 'application/zip',
							'content-disposition': `attachment; filename="${pack.fileName}"`,
							'content-length': String(pack.buffer.length),
							'cache-control': 'no-store',
						});
						res.end(pack.buffer);
					} catch (e) {
						const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 500;
						res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: String(e?.message ?? e) }));
					}
					return;
				}
				if (req.method === 'POST') {
					try {
						const body = await readJsonBody(req);
						if (body?.action !== 'save') {
							throw Object.assign(new Error(`未知 action：${body?.action ?? '(空)'}（只支持 save；要拿字节请用 GET）`), { httpStatus: 400 });
						}
						const saved = await saveExport(config, body?.id, { includeMemory: body?.memory !== false });
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(saved));
					} catch (e) {
						const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 500;
						res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: String(e?.message ?? e) }));
					}
					return;
				}
				res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
				res.end('GET or POST');
				return;
			}
			// ── 从 DeepSeekBot（PersonaBot）导入（2026-10-19）──────────────────────────────
			//   只吃 base64 的 zip（**不接受** 服务器端目录路径：那会把"任意目录读取"开成 HTTP 口）。
			//   映射口径见 lib/importDsb.js 头注释；`dryRun` 只回计划不写盘（页面用它做预览）。
			if (pathname === `${ROUTE_PREFIX}/api/import-bot` && req.method === 'POST') {
				try {
					const body = await readJsonBody(req);
					const zipBase64 = typeof body?.zip === 'string' ? body.zip.trim() : '';
					// 2026-10-19：也接受**纯人设 markdown**（`{ soul: "..." }`）——不是每个 bot 都有 zip
					// （DSB 内置 Tob 的人格就是源码里一段字符串）。两条来源走同一个映射器 ✓。
					const soulText = typeof body?.soul === 'string' ? body.soul : '';
					if (!zipBase64 && !soulText.trim()) {
						throw Object.assign(new Error('需要 zip（base64 字符串）或 soul（人设 markdown 文本）'), { httpStatus: 400 });
					}
					const source = zipBase64
						? Buffer.from(zipBase64, 'base64')
						: botFromSoulText(soulText, { name: typeof body?.name === 'string' ? body.name : undefined });
					const result = await importDsbBot(config, source, {
						id: typeof body?.id === 'string' ? body.id : undefined,
						name: typeof body?.name === 'string' ? body.name : undefined,
						model: typeof body?.model === 'string' ? body.model : undefined,
						modelAssignment: typeof body?.modelAssignment === 'string' ? body.modelAssignment : undefined,
						overwrite: body?.overwrite === true,
						dryRun: body?.dryRun === true,
					});
					if (result.dryRun !== true && state.presets) {
						await syncPresets(state, state.presets, config).catch(e => {
							state.errors = [...state.errors, `导入 Bot 后同步 preset 失败：${String(e?.message ?? e)}`];
						});
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, ...result }));
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 500;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/api/import` && req.method === 'POST') {
				try {
					const body = await readJsonBody(req);
					const zipBase64 = typeof body?.zip === 'string' ? body.zip.trim() : '';
					if (!zipBase64) {
						throw Object.assign(new Error('需要 zip（base64 字符串）'), { httpStatus: 400 });
					}
					const result = await importAgent(config, Buffer.from(zipBase64, 'base64'), { overwrite: body?.overwrite === true });
					// 导入即生效：本轮的增量同步（失败要如实记，不能假装"已注册"）
					if (state.presets) {
						await syncPresets(state, state.presets, config).catch(e => {
							state.errors = [...state.errors, `导入后同步 preset 失败：${String(e?.message ?? e)}`];
						});
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, ...result }));
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 500;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			try {
				// 每次请求都做增量同步（新加/改动/删掉 agent 不必重启 Host）。同步失败不影响读页面。
				// ⚠ 走 `syncOnce`：删除 agent 会在后台触发一次 O(N²) 重注册，此刻页面若立刻重载，
				//   这里**复用**那个在飞的 promise，而不是并发再做一遍（否则两边互相 dispose，越等越慢）。
				const scan = state.presets
					? await syncOnce(state, state.presets, config).catch(e => {
						state.errors = [...state.errors, `同步 preset 失败：${String(e?.message ?? e)}`];
						return scanAgents(root, undefined);
					})
					: await scanAgents(root, undefined);
				const summary = summarizeAgents(scan.agents);
				// 展示面名册（内置按 userFacing 白名单 + 去掉 HIDDEN_AGENT_IDS）—— preset 注册仍用全量 scan ✓
				const shownAgents = shownAgentsOf(scan.agents);
				const shownSummary = summarizeAgents(shownAgents);
				// 用量 API（2026-10-13，P5）：按 agent（含按模型拆分）的会话/token/回合聚合，
			// 数据源 = projcache（只读）。时间口径如实说：只有"最近活跃"（lastPromptAt），
			// 没有按天分桶——按时间的视图在 Dashboard 页（那边有完整的量）。
			if (pathname === `${ROUTE_PREFIX}/api/usage`) {
				const live = await readLiveSessions(config)
					.catch(e => ({ rows: [], errors: [`用量读取失败：${String(e?.message ?? e)}`], dir: undefined, truncated: false }));
				const usage = usageByAgent(scan.agents, live.rows);
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify({
					agents: usage.agents,
					unknown: usage.unknown,
					totals: usage.totals,
					sessions: live.rows.length,
					truncated: live.truncated === true,
					errors: live.errors,
					...(live.missing ? { missing: live.missing } : {}),
				}));
				return;
			}
			// 未读角标（2026-10-17，方案 A 收尾）：**轻量**读口——只读 projcache 行 + seen 表，
			// 不做 syncPresets（侧栏每 15s 轮询，同步太重 ✗）。404 只在老版本插件 ⇒ 页面停轮询 ✓
			if (pathname === `${ROUTE_PREFIX}/api/unread` && req.method === 'GET') {
				try {
					const live = await readLiveSessions(config).catch(() => null);
					const counts = live ? await unreadSnapshot(config, scan.agents, live.rows) : {};
					// 群未读（2026-10-21）：侧栏 15s 轮询顺手带上，只给"有未读的群"（空的不占带宽）
					const groupCounts = {};
					const groupList = await listGroups(config).catch(() => ({ groups: [] }));
					for (const g of groupList.groups ?? []) {
						if (g.unread > 0) {
							groupCounts[g.id] = g.unread;
						}
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ counts, groups: groupCounts }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			// ── 群聊独立页（2026-10-21，方案 A）─────────────────────────────────────
			// 承载：编辑区页签（`DshPluginPageEditorInput`）。侧栏的「聊天」按钮 =
			// `bridge.openModulePage('/x/agents/group?group=<id>')` ⇒ 宿主按前缀归属到 agents 容器，
			// 单例键 = 容器 + 子路由 ⇒ **每个群一个 tab** ✓
			// 数据面沿用 `api/groups`（读/写都在那儿）⇒ 本页只做视图，刷新后以服务端 transcript 为准。
			//
			// ⚠ 群 id / 「新建」走**路径段**而不是查询串：桥的 `openModulePage` 只放
			//   `[A-Za-z0-9._~/-]`（查询串被明确拒绝，见 dshPageBridgeProtocol 的实现）
			//   ⇒ `?group=` 会被协议直接丢掉。路径段同时让 `DshPluginPageEditorInput`
			//   的"容器 + 子路由"单例键天然做到**一群一 tab** ✓
			//   `/x/agents/group`（默认选第一个）/ `/x/agents/group/<groupId>` / `/x/agents/group/new`
			const groupM = new RegExp(`^${ROUTE_PREFIX}/group(?:/([A-Za-z0-9._-]+))?/?$`).exec(pathname);
			if (groupM) {
				try {
					const seg = groupM[1] ?? '';
					const scan = await scanAgentsFromConfig(config);
					const groups = await listGroups(config).catch(() => ({ groups: [], keep: 0 }));
					const html = renderGroupPage({
						groups,
						// 成员候选：页面可见的 agent（隐藏的「助理」不该被拉进群聊）
						agents: (scan.agents ?? []).filter(a => isShownAgent(a)),
						activeId: seg === 'new' ? '' : seg,
						openNew: seg === 'new',
						keep: groups.keep,
					});
					const encoded = encodeBody(req, html);
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...encoded.headers });
					res.end(encoded.body);
				} catch (e) {
					const message = String(e?.message ?? e);
					if (!res.headersSent) {
						res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					}
					res.end(message);
				}
				return;
			}
			// ── 记忆演化面板（2026-10-21）────────────────────────────────────────
			// `/x/agents/memory/<agentId>`：路径段（桥的 openModulePage 只放 [A-Za-z0-9._~/-]）。
			// 只读为主：数据全走 `/x/agents/api/memory`（log / rev / against / restore / versions）；
			// 回滚是**写**操作，但复用既有的 `restoreMemoryFile`（写回文件 + 自动提交快照）。
			const memM = new RegExp(`^${ROUTE_PREFIX}/memory/([A-Za-z0-9._-]+)/?$`).exec(pathname);
			if (memM) {
				try {
					const agentId = memM[1];
					const scan = await scanAgentsFromConfig(config).catch(() => ({ agents: [] }));
					const agent = (scan.agents ?? []).find(a => a.id === agentId);
					const html = renderMemoryEvoPage({ agentId, agentName: agent?.name, missing: !agent });
					const encoded = encodeBody(req, html);
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...encoded.headers });
					res.end(encoded.body);
				} catch (e) {
					if (!res.headersSent) {
						res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					}
					res.end(String(e?.message ?? e));
				}
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/api/agents`) {
					// 实况（2026-10-13）：会话归属与用量**不另建状态文件**——projcache 里 `agentPreset` /
					// `tokenUsage` / `sessionStats` 都是现成的（ds-bot 的 state.json 名册在我们这里不需要）。
					// 读失败只进 errors，不影响花名册本体。
					const live = await readLiveSessions(config)
						.catch(e => ({ rows: [], errors: [`实况读取失败：${String(e?.message ?? e)}`], dir: undefined, truncated: false }));
					const { rows: liveRows, unmatched } = liveForAgents(scan.agents, aggregateByPreset(live.rows));
					const liveOf = new Map(liveRows.map(row => [row.agentId, row]));
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						root,
						count: shownSummary.count,
						summary: shownSummary,
						// 与 dsh 的花名册对齐：每个 agent 是否真的注册成功
						agents: shownAgents.map(a => ({
							id: a.id,
							name: a.name,
							description: a.description,
							icon: a.icon,
							// 聊天框欢迎卡（方案 A 第 3 步，chat-surface 的 client.welcome.js）要的三个字段：
							// 角色标签、技能、头像底色（底色只有服务端会算 ⇒ 直接给，前端不再抄一份公式 ✓）
							role: a.role ?? null,
							skills: a.skills ?? [],
							color: avatarColorOf(a.id),
							model: a.model,
							tools: a.tools,
							personaBytes: Buffer.byteLength(a.persona, 'utf8'),
							presetId: presetIdOf(a.id),
							registered: state.roster.includes(presetIdOf(a.id)),
							live: liveOf.get(a.id) ?? null,
						})),
						live: {
							dir: live.dir,
							sessions: live.rows.length,
							truncated: live.truncated === true,
							unmatchedPresets: unmatched,
							errors: live.errors,
							...(live.missing ? { missing: live.missing } : {}),
						},
						roster: state.roster,
						diagnostics: state.diagnostics,
						errors: [...scan.errors, ...state.errors],
						...(scan.missing ? { missing: scan.missing } : {}),
					}));
					return;
				}
				// 实况 + 用量（P1/P5）：projcache 读不到就降级为"没有这两块"（页面主体不受影响 ✓）
				const live = await readLiveSessions(config).catch(() => null);
				const liveRows = live ? liveForAgents(scan.agents, aggregateByPreset(live.rows)).rows : [];
				const usage = live ? usageByAgent(scan.agents, live.rows) : null;
				// 双表面分派（2026-10-16，方案 D；与 kanban 同惯例）：宿主在**侧栏**承载时带
				// `?surface=sideview` ⇒ 名册摘要版（lib/sideview.js）；其余（编辑区完整页、探针的默认
				// 请求）⇒ 完整页（lib/detail.js）。两个表面吃同一份数据（上面这一份 input）⇒ 不会漂 ✓。
				const surface = url.searchParams.get('surface') === 'sideview' ? 'sideview' : 'editor';
				const render = surface === 'sideview' ? renderSideviewPage : renderDetailPage;
				// 渲染先于 writeHead：渲染抛错还能干净回 500（教训：顺序反了会切断 socket）
				const html = render({
					agents: shownAgents,
					summary: shownSummary,
					root,
					missing: scan.missing,
					diagnostics: state.diagnostics,
					roster: state.roster,
					errors: [...scan.errors, ...state.errors],
					liveRows,
					// Bot 主页（方案 A 第 2 步）：「会话」面板要逐条会话（标题/最近活跃/回合），不是聚合值 ✓
					sessionRows: live?.rows ?? [],
					// 未读角标（方案 A 收尾）：侧栏首屏就要带上（轮询是补新活动，不是补首屏 ✗）
					unread: live ? await unreadSnapshot(config, scan.agents, live.rows) : {},
					usage,
					assignments: await listAssignments(config),
					// 授权页签的模板清单（读失败按空 ⇒ 页面照出，模板区显示空 ✓）
					templates: await listApprovalTemplates(config).catch(() => ({ tools: [], templates: [] })),
					// 群聊页签（读失败按空 ⇒ 同上口径 ✓）
					groups: await listGroups(config).catch(() => ({ groups: [], keep: 0 })),
					// 授权页签的 outbox 队列（同口径 ✓）
					outbox: await outboxList(config).catch(() => ({ entries: [], keep: 0 })),
					// 新建向导（2026-10-16，方案 A）：模型候选 = 真实会话里跑过的 provider/model ✓；
					// 没配 defaultProvider 时裸模型名不可路由（口径 = toPresetDefinition）
					create: {
						modelCandidates: modelCandidatesOf(live?.rows, scan.agents),
						hasDefaultProvider: typeof config.defaultProvider === 'string' && config.defaultProvider.trim() !== '',
					},
					});
				// 压缩（2026-10-19）：页面 CSS/JS 全内联，实测 144KB → gzip 27KB（18%）。
				// 只改传输编码、不动页面结构；不支持 gzip 的客户端拿到原文（encodeBody 里判）。
				const encoded = encodeBody(req, html);
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...encoded.headers });
				res.end(encoded.body);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}

/**
 * 把 `denyTools` 里的模式展开成**具体工具名**（`ctx.tools.restrict()` 只认确切名字，不认通配 ✗）。
 *
 * 语法只有两种（刻意不做正则：模型/运维写错一个正则就能误伤半张工具面 ✗）：
 *   · `'exact.name'` —— 精确匹配；
 *   · `'prefix*'`    —— 末尾星号 = 前缀匹配（写 `'*'` 等于全藏，拒绝：那是把模型饿死，不是收敛）。
 *
 * 返回 `misses` 而不是静默丢弃：拼错一个字符就等于**这条没生效**，而"没生效"在界面上是看不见的
 * （工具还在、token 照付）⇒ 由调用方写进 Host 日志 ✓。
 */
export function expandDenyPatterns(patterns, names) {
	const list = (Array.isArray(patterns) ? patterns : [])
		.filter(pattern => typeof pattern === 'string' && pattern.trim())
		.map(pattern => pattern.trim());
	const known = new Set((Array.isArray(names) ? names : []).filter(entry => typeof entry === 'string' && entry));
	const deny = new Set();
	const misses = [];
	for (const pattern of list) {
		if (pattern === '*' || pattern === '**') {
			misses.push(`${pattern}（拒绝全藏：会让模型没有任何工具可用）`);
			continue;
		}
		if (pattern.endsWith('*')) {
			const prefix = pattern.slice(0, -1);
			let hit = 0;
			for (const name of known) {
				if (name.startsWith(prefix)) {
					deny.add(name);
					hit += 1;
				}
			}
			if (hit === 0) {
				misses.push(pattern);
			}
		} else if (known.has(pattern)) {
			deny.add(pattern);
		} else {
			misses.push(pattern);
		}
	}
	return { deny: [...deny], misses };
}

/** 角色 3：preset 内的"只挂工具"行（`config.toolsOnly: true`）。
 *  不注册 preset、不开页面、不注册人设段——只把四个生命周期工具挂进该 preset 作用域，
 *  这样 B1 ②（host 行让出工具）之后，选中我们 preset 的会话仍有这套工具。
 *  ⚠ 不读 `config.hostHalf`：hostHalf 管的是 host 面那一半，preset 面必须始终有工具。 */
function applyToolsOnly(ctx, config) {
	const state = { agents: undefined, sessionController: undefined, sessionQuery: undefined, approvalTemplates: templateGate(config) };
	ctx.inject(['agents'], child => child.effect(() => {
		state.agents = child.agents;
		return () => {
			state.agents = undefined;
		};
	}));
	ctx.inject(['sessionController'], child => child.effect(() => {
		state.sessionController = child.sessionController;
		return () => {
			state.sessionController = undefined;
		};
	}));
	ctx.inject(['sessionQuery'], child => child.effect(() => {
		state.sessionQuery = child.sessionQuery;
		return () => {
			state.sessionQuery = undefined;
		};
	}));
	ctx.effect(() => registerAgentTools(ctx, config, state));
	// ── 工具面预算（0 档收敛，2026-10-20）──────────────────────────────────────────────
	// 起因（真机量化）：本机一次请求直发 **197 个工具 / ≈42.3k schema token**，其中 `mcp__comfy-mcp__*`
	// 39 个占 **15.5k（36.6%）**，而默认会话里几乎用不到它们 ⇒ 模型选择面被无关节能摊薄。
	//
	// 为什么用 `ctx.tools.restrict({deny})` 而不是"别让 MCP 挂上"：
	//   · MCP 的挂载是 `dsh-mcp-client` 一台服务器一个组合行（`dsh-mcp-client/README.md:55-67` **没有**
	//     工具级 include/exclude）⇒ 只能整台砍，图像会话就一起失去能力 ✗；
	//   · `restrict` 是**可见性 mask**：服务器照连、工具照注册、审批照旧，只是不进模型目录 ✓
	//     （`dsh-tools` README:85「Restrict tools per agent」）。
	//
	// 三条实现纪律：
	//   ① **不拖垮预设**：作用域不对 / 名字还没注册都会抛 —— 一律 catch + 打日志（本仓踩过"插件 static inject
	//      太宽 ⇒ 整个 preset 不启动 ⇒ 该 preset 的会话全起不来"✗）。
	//   ② **等工具面长出来**：MCP 是异步连接的，preset 挂载那一刻 `mcp__…` 可能还没注册（`restrict` 对未知名字抛错）。
	//      所以订阅 `tools/change`（`dsh-tools/lib/index.js:2784` 每次注册/撤销都会 emit）重试 ✓。
	//   ③ **别抖动**：集合没变就不重装 mask（每换一次 mask 都可能影响请求前缀的可复用性）。
	ctx.inject(['tools'], child => child.effect(() => {
		const patterns = config?.denyTools;
		if (!Array.isArray(patterns) || patterns.length === 0) { return undefined; }
		let dispose;
		let applied = new Set();
		let warnedMisses = false;
		let warnedScope = false;
		// ★★ 2026-10-20（真机事故：聊天框永久「载入历史…」）—— 本段原实现是一个**振荡环**：
		//   Host 日志（agents 0.2.74 起每次启动 3k~23k 行）：`隐藏 1 个 ×562 / 隐藏 2 个 ×543 / … / 隐藏 21 个 ×659`
		//   ⇒ 掩码在"只藏新来的 1 个"与"全藏 21 个"之间来回切了 600 多轮：
		//     ① `schemas()` 只返回**可见**工具（被藏的不在里面）⇒ 新工具注册时可见集里只剩它 ⇒ deny=[它]
		//     ② 用 [它] **替换**旧掩码 ⇒ 之前藏的 20 个又露出来 ⇒ `restrict` 自身触发 tools/change
		//     ③ 重算看到 21 个 ⇒ 全藏 ⇒ 再触发 …… 无限循环
		//   每次 tools/change 都让 dsh 客户端连接"世代"失效 ⇒ 页面永远连不稳（retry #N）⇒ 历史永远载不出来 ✗✗
		//   三条修正：
		//     · **只增不减**：next = applied ∪ 本次命中（可见集看不到已藏的，不能拿它来"缩小"掩码）；
		//     · **防重入**：restrict 内部同步触发的 tools/change 不立即重算，记一笔、结束后再算一次；
		//     · **去抖**：MCP 一口气注册 20 个工具 ⇒ 合并成 1~2 次重算（不是 20 次换掩码）。
		let running = false;
		let rerun = false;
		let timer;
		const schedule = () => {
			if (timer) { return; }
			timer = setTimeout(() => { timer = undefined; sync(); }, 150);
			timer.unref?.();
		};
		const syncOnce = () => {
			let names;
			try {
				names = (child.tools.schemas?.() ?? []).map(schema => schema?.name).filter(Boolean);
			} catch {
				return; // 注册表还没就绪：等下一次 `tools/change`
			}
			const { deny, misses } = expandDenyPatterns(patterns, names);
			if (misses.length && !warnedMisses && applied.size === 0) {
				warnedMisses = true;
				console.warn(`[vssaros-agents] denyTools 里这些模式没命中任何工具（拼错就等于没生效）：${misses.join(', ')}`);
			}
			const next = new Set([...applied, ...deny]);
			// 只增不减 ⇒ 大小没变就是集合没变（不重装掩码 ⇒ 不再触发 tools/change ⇒ 环被切断）
			if (next.size === 0 || (dispose && next.size === applied.size)) { return; }
			try {
				const previous = dispose;
				dispose = child.tools.restrict({ deny: [...next] });
				const grewFrom = applied.size;
				applied = next;
				previous?.(); // 先装新的再撤旧的 ⇒ 隐藏连续，不会出现"空窗"让工具露出
				console.warn(`[vssaros-agents] 工具面收敛：本 preset 隐藏 ${next.size} 个工具（+${next.size - grewFrom}；${patterns.join(', ')}）`);
			} catch (error) {
				// 只报一次：作用域不对是**稳态**失败（每次 tools/change 都会抛），逐次刷屏会把真日志淹掉 ✓
				if (!warnedScope) {
					warnedScope = true;
					console.warn(`[vssaros-agents] denyTools 未生效（${String(error?.message ?? error)}）—— 只在作用域允许时才能收敛；此后再失败不再重复报`);
				}
			}
		};
		const sync = () => {
			if (running) { rerun = true; return; }
			running = true;
			try { syncOnce(); } finally { running = false; }
			if (rerun) { rerun = false; schedule(); }
		};
		sync();
		let off;
		try {
			off = child.on?.('tools/change', () => schedule());
		} catch {
			off = undefined; // 事件不可用 ⇒ 只按挂载那一刻算（不抛，别让收敛拖垮预设）
		}
		return () => {
			try { off?.(); } catch { /* 退订失败不值得打扰 ✓ */ }
			try { if (timer) { clearTimeout(timer); timer = undefined; } } catch { /* 同上 */ }
			try { dispose?.(); } catch { /* 同上 */ }
			dispose = undefined;
			applied = new Set();
		};
	}));
}

export function apply(ctx, config = {}) {
	// 角色判定：**带 `persona` 键** = 本包被某个 preset 再挂了一次（只做人设注入 + 工具 allowlist）。
	//
	// ⚠ 2026-10-20 修：判据从「persona 非空」改成「有这个键」。
	//   `toPresetDefinition` **无条件**生成人设行（正文允许为空），旧判定会把「正文为空」的行
	//   落到 `applyTopLevel`（在 preset 作用域里重跑顶层逻辑）⇒ 那条 preset 既没有记忆快照注入、
	//   **也没有 tools allowlist**。用户可见的症状正是：记忆页签写着「常驻注入 40 字符」，
	//   而 agent 完全读不到（人设 0 字的 agent 一定会踩）。
	//   安全性：顶层行（cordis.patch.yml）config 是 `{}`、toolsOnly 行是 `{ toolsOnly: true }`
	//   ⇒ 两者都不带该键 ✓。
	if (typeof config?.persona === 'string') {
		applyPersona(ctx, config);
		return;
	}
	// `config.toolsOnly` = preset 内的工具行（只挂工具）
	if (config?.toolsOnly === true) {
		applyToolsOnly(ctx, config);
		return;
	}
	applyTopLevel(ctx, config);
}
