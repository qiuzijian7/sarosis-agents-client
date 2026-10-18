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
import { avatarColorOf, presetIdOf, summarizeAgents, toPresetDefinition } from './core/agents.js';
import { createAgentFromDraft, previewAgentDraft, resetAgentModel } from './create.js';
import { draftFromAgentMd, modelCandidatesOf } from './core/create.js';
import { aggregateByPreset, liveForAgents, usageByAgent } from './core/live.js';
import { PERSONA_PROJECTION_KEY, personaProjection, personaSwitchMessage, switchedPersonaText } from './core/persona.js';
import { renderDetailPage } from './detail.js';
import { createGroup, deleteGroup, installGroupTracker, listGroups, postGroupMessage } from './groups.js';
import { readLiveSessions } from './live.js';
import { markSeen, unreadSnapshot } from './seen.js';
import { enableGit, gitLogOf, gitStatusOf, listMemoryFiles, readMemoryFile, readMemorySnapshot, snapshotGit } from './memory.js';
import { ensureOutboxLoaded, outboxList, outboxRetry } from './outbox.js';
import { installRelay } from './relay.js';
import { renderSideviewPage } from './sideview.js';
import { agentsRootOf, scanAgents } from './store.js';
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
	// 记忆快照注入（2026-10-16，二期）：MEMORY.md 前 2KB 追加在人设段后。装配是同步的 ⇒
	// 快照走缓存（挂载即刷 + 每分钟定时刷）；口径 = 冻结快照，最多滞后一个刷新周期 ✓。
	let memoryCache = '';
	const refreshMemory = () => {
		readMemorySnapshot(config, config.agentId).then(text => {
			memoryCache = text;
		}).catch(() => {
			memoryCache = '';
		});
	};
	refreshMemory();
	const memoryTimer = setInterval(refreshMemory, 60_000);
	memoryTimer.unref?.();
	ctx.effect(() => () => clearInterval(memoryTimer));

	ctx.inject(['systemPrompt'], child => child.effect(() => child.systemPrompt.section({
		name: PERSONA_SECTION_NAME,
		order: sectionOrderOf(child),
		// **函数形式**：每次装配按 `context.agent` 取该会话的当前人格（会话内切换过就是新的）；
		// 没切换过 / 取不到 → 退回 preset 自带人设，行为与从前完全一致。有记忆快照就追加 ✓。
		text: (context) => {
			const base = switchedPersonaText(projections, context) ?? staticPersona;
			return memoryCache ? base + memoryCache : base;
		},
	})));

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
	};
}

/** 撤销本次挂载注册的全部 preset（幂等）。 */
async function disposeAllPresets(state) {
	const entries = [...state.registered.values()];
	state.registered.clear();
	state.roster = [];
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
	const scan = await scanAgents(agentsRootOf(config), undefined);
	const provider = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim() : '';
	const errors = [...scan.errors];
	const diagnostics = [];
	const seen = new Set();
	for (const agent of scan.agents) {
		seen.add(agent.id);
		const { definition, notes } = toPresetDefinition(agent, { provider });
		const fingerprint = `${agent.file}:${agent.name}:${agent.model ?? ''}:${agent.persona.length}:${agent.tools.length}`;
		const existing = state.registered.get(agent.id);
		if (existing && existing.fingerprint === fingerprint) {
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: false });
			continue;
		}
		if (existing) {
			// 定义变了：先撤旧的再注册（`register` 对重名会失败，不能直接覆盖）
			try {
				await existing.dispose();
			} catch (e) {
				errors.push(`撤销旧定义失败（${agent.id}）：${String(e?.message ?? e)}`);
			}
			state.registered.delete(agent.id);
		}
		try {
			const dispose = await presets.register(definition);
			state.registered.set(agent.id, { presetId: definition.id, fingerprint, dispose });
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: true });
		} catch (e) {
			// 注册失败要看得见（dsh 侧自己的花名册也会留一条带诊断的失败行，但那是它的口径）
			errors.push(`注册 preset 失败（${definition.id}）：${String(e?.message ?? e)}`);
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes: [...notes, '注册失败'], changed: true });
		}
	}
	// 源文件消失的 agent：撤掉（只增不删会让花名册里留幽灵）
	for (const [agentId, entry] of [...state.registered]) {
		if (seen.has(agentId)) {
			continue;
		}
		try {
			await entry.dispose();
		} catch {
			/* 已失效即目标 */
		}
		state.registered.delete(agentId);
		diagnostics.push({ agentId, presetId: entry.presetId, rows: 0, notes: ['源文件已消失 → 已注销该 preset'], changed: true });
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
	const scan = await scanAgents(agentsRootOf(config));
	// 两种指定方式：`personaId`（= agent id，直接命中）/ `presetId`（= 花名册 id，经 `presetIdOf` 反查）。
	const target = personaId
		? scan.agents.find(a => a.id === personaId)
		: scan.agents.find(a => presetIdOf(a.id) === presetId);
	if (!target) {
		throw new Error(personaId ? `未知人格：${personaId}` : `未知 preset：${presetId}`);
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
									: (() => { throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 create/message/delete）`), { httpStatus: 400 }); })();
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
					const agentId = String(url.searchParams.get('agent') ?? '').trim();
					if (!agentId) {
						throw Object.assign(new Error('需要 agent 参数'), { httpStatus: 400 });
					}
					if (req.method === 'GET') {
						const file = url.searchParams.get('file');
						const [listing, git, log] = await Promise.all([
							listMemoryFiles(config, agentId),
							gitStatusOf(config, agentId),
							gitLogOf(config, agentId),
						]);
						const content = file ? await readMemoryFile(config, agentId, file) : null;
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ agent: agentId, ...listing, git, log: log.log, content }));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						const action = typeof body?.action === 'string' ? body.action.trim() : '';
						const target = String(body?.agent ?? '').trim();
						if (!target) {
							throw Object.assign(new Error('需要 agent'), { httpStatus: 400 });
						}
						const result = action === 'enable-git' ? await enableGit(config, target)
							: action === 'snapshot' ? await snapshotGit(config, target, body?.message)
								: (() => { throw Object.assign(new Error(`未知 action：${action || '(空)'}（支持 enable-git/snapshot）`), { httpStatus: 400 }); })();
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
			try {
				// 每次请求都做增量同步（新加/改动/删掉 agent 不必重启 Host）。同步失败不影响读页面。
				const scan = state.presets
					? await syncPresets(state, state.presets, config).catch(e => {
						state.errors = [...state.errors, `同步 preset 失败：${String(e?.message ?? e)}`];
						return scanAgents(root, undefined);
					})
					: await scanAgents(root, undefined);
				const summary = summarizeAgents(scan.agents);
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
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ counts }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
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
						count: summary.count,
						summary,
						// 与 dsh 的花名册对齐：每个 agent 是否真的注册成功
						agents: scan.agents.map(a => ({
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
					agents: scan.agents,
					summary,
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
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
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
}

export function apply(ctx, config = {}) {
	// 角色判定：`config.persona` 非空 = 本包被某个 preset 再挂了一次（只做人设注入）
	if (typeof config?.persona === 'string' && config.persona.trim()) {
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
