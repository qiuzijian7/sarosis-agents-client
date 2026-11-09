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
// ★ 2026-11-03 修「join is not defined」：applyPersona 的记忆提示里用 join() 拼 MEMORY.md 绝对路径，
//   但这个 import 从来没写过 —— 只在「bot 有记忆内容」时才走到那行，所以一直潜伏到本轮真机才炸。
import { join } from 'node:path';
import { askAssignment, cancelAssignment, createAssignment, installAssignmentTracker, listAssignments } from './assignments.js';
import { allowlistDenyOf, pickLazyEagerKeys, avatarColorOf, isDelegatableAgent, isShownAgent, presetIdOf, summarizeAgents, toPresetDefinition } from './core/agents.js';
import { agentModelRouteOf, applyModelSelection, prevalidateRoutes, setAgentModelRoutes } from './modelSelection.js';
import { botIdentityProjection } from './core/botIdentity.js';
import { writeBotIdentity } from './botIdentityWriter.js';
import { createAgentFromDraft, deleteAgent, previewAgentDraft, readAgentDraft, resetAgentModel, setAgentMemoryLimits, setAgentSubagent, updateAgentFromDraft } from './create.js';
import { draftFromAgentMd, modelCandidatesOf } from './core/create.js';
import { lineDiff } from './core/diff.js';
import { aggregateByPreset, liveForAgents, usageByAgent } from './core/live.js';
import { PERSONA_PROJECTION_KEY, personaProjection, personaSwitchMessage, switchedPersonaText } from './core/persona.js';
import { createToolNameSnapshot } from './core/toolNames.js';
// 群聊的派发/记账与 `@vssaros/dsh-loop` 共用同一份 work-item 判据（真源在 `@vssaros/dsh-workitem`）。
import { bindWorkItems } from './workItemRef.js';
// ★ 2026-10-22（工作台重构）：名册 JSON 接口复用**同一份**面板数据构建（页面与工作台不会各算一遍 ✓）
import { buildHomeData } from './home.js';
// 给某个 agent 找活会话（IM 渠道派发用；★ 2026-11-03 从 groups.js 抽出，群聊下线后仅此一处消费）
import { ensureAgentSession } from './agentSession.js';
import { readLiveSessions, recentSessionPresetIds } from './live.js';
import { markSeen, unreadSnapshot } from './seen.js';
// 从 AgentMemory 网关库拉一份 MEMORY.md **草稿**（只读；不落盘 —— 落盘仍走 write-memory 由人确认）
// 工作区记忆（2026-11-02）：记忆 = Bot × 工作区 两层；这里只用到注入、页面 API 两处
// 记忆偏好（2026-11-03）：「回合末自动提交」等开关，运行期可改、立刻生效
import { ensureOutboxLoaded, outboxList, outboxRetry } from './outbox.js';
/* IM 绑定（2026-10-27，P0）：每个 bot / 群可绑一个 IM 会话，双向流转。
   适配器端口与 `vssaros-channels/lib/core/ports.js` 同形 ⇒ 飞书适配器将来可直接搬。 */
import { allowDeadLetterSender, createBinding, createBindingHub, deleteBinding, dispatchImToAgent, listBindings, updateBinding } from './bindings.js';
import { createLoopbackAdapter } from './adapters/loopback.js';
import { createFeishuAdapter } from './adapters/feishu.js';
/* 入站（P2 骨架）：传输层注入 —— 装了官方 SDK 才能真连长连接，没装就如实 unavailable。 */
import { createFeishuGateway, createSdkTransport } from './adapters/feishuInbound.js';
/* ★ 2026-10-29：飞书入站默认走**自研 WS 协议**（protobuf 二进制帧 + ping/pong + ack 回执）。
   为什么不用官方 SDK 的 WSClient：2026-10-29 真机上它「握手完成但一条事件都不来」，
   而 SDK 默认**不打任何日志** ⇒ 分不清"没连上"与"连上了不推"；而 IDE 侧当年**手写**的
   这套协议（协议出处见 `feishuWsFrames.js` 头注释）是**真收到过事件**的。
   ⇒ 自研实现优先；`createSdkTransport` 保留在 `feishuInbound.js` 里，要切回改下面这一行即可。 */
import { createRawWsTransport } from './adapters/feishuRawWs.js';
/* Telegram 适配器（2026-10-27）：纯 HTTP 长轮询，不需要 SDK —— 用来证明"加渠道只写薄适配器"。 */
import { createHttpTransport, createTelegramAdapter, createTelegramGateway } from './adapters/telegram.js';
import { createDiscordAdapter, createDiscordGateway } from './adapters/discord.js';
import { createWecomAdapter, handleWecomCallback } from './adapters/wecom.js';
/* IM 应用凭据（**dsh 侧真源**，2026-10-27）：设置弹窗「渠道」页读写 `<dataRoot>/agent-im-accounts.json`；
   `config.feishu`（IDE 覆盖层）降级为兼容回落 —— 优先级 dsh 文件 → config → 环境变量。 */
import { describeFeishu, describeFeishuApps, describePlatforms, migrateLegacyFeishu, readBotFeishuApps, resolveFeishu, resolveFeishuApp, resolvePlatform, saveBotFeishuApp, saveFeishuApp, savePlatform } from './imCredentials.js';
/* 入站「上次是否在跑」的开关（2026-10-29）：重启 Host 后据此恢复，别让用户以为坏了。 */
import { readFeishuAppsEnabled, readInboundEnabled, setFeishuAppEnabled, setInboundEnabled } from './imInboundState.js';
/* ★ 2026-10-29：**跨 dataRoot 的入站长连接互斥锁**（见 imInboundLock.js 文件头）。
   飞书对同一应用只让一条长连接真正收到事件，而这台机器上可能同时有几个 Host
   （旧 Host 未被回收 / dev 版与正式版是两个 dataRoot、互相看不见）⇒ 必须在 home 下放锁，
   抢不到就不连。否则表现是「日志全绿 + 心跳正常 + 零事件」，极难查（今天就卡在这）。 */
import { releaseImLock, startImLockHeartbeat, tryAcquireImLock } from './imInboundLock.js';
import { acquireFeishuAppLock, describeFeishuHolder } from './imFeishuAppLock.js';
import { createFeishuAppInbounds } from './feishuAppInbounds.js';
import { appIdOfEvent, feishuEventBus } from './feishuEventBus.js';
import { createTeamService } from './team.js';
import { createTeamBot } from './teamCreate.js';
import { memoryBus } from './memoryBus.js';
import { decideSkillDraft, rememberStep } from './stepMemory.js';
import { distillRouteOf, makeStepDistiller } from './stepDistill.js';
import { externalBots, externalBotRow, teamBus } from './teamBus.js';
import { createRooms, installRooms, roomsApi } from './rooms.js';
import { roomProjection } from './core/rooms.js';
import { loadAppendPluginRecord } from './botIdentityWriter.js';
/* ★ 2026-10-29：**父进程看护** —— app 退出后 Host 自己退，避免孤儿 Host 继续占用
   会话写句柄与 IM 长连接（见 hostSelfWatch.js 文件头；真机上曾攒出 3 个 Host 抢飞书事件）。 */
import { startAppParentWatch } from './hostSelfWatch.js';
/* 每条 IM 绑定 ⇄ 一条 dsh 会话（2026-10-29）：否则派发会不断新建「未命名会话」。 */
import { getImSession, setImSession } from './imSessionMap.js';
/* 平台与字段定义（**单一真源**）：随 GET 发给客户端渲染表单，两端不各写一份 */
import { IM_PLATFORM_DEFS } from './imPlatforms.js';
/* DM 配对（OpenClaw 同构，2026-10-27）：`dmPolicy=pairing` 的码表 + 批准表。
   批准只写 **DM 白名单**，不碰群权限（群由 groupAllowFrom / rooms 单独管）。 */
import { approvePairing, approvedUserIds, listPairings, requestPairing, revokePairing } from './pairing.js';
/* 入站死信（OpenClaw `channels dead-letters` 同构）：被拒/失败的消息落盘，界面可列 */
import { clearDeadLetters, listDeadLetters, recordDeadLetter } from './deadLetters.js';
import { flushInboundSeen, markInboundSeen } from './imSeen.js';
import { encodeBody } from './gzip.js';
import { botFromSoulText, importDsbBot } from './importDsb.js';
import { exportAgent, importAgent, saveExport } from './pack.js';
import { installRelay } from './relay.js';

// ★ 2026-10-19：改用 `scanAgentsFromConfig` —— 它会扫**两个**根（内置 + 自定义）并合并
//   （同 id 时自定义优先）。此前只扫自定义根 ⇒ dsh 侧**列不出任何内置 agent** ✗。
// ⚠ 2026-10-19：`agentsRootOf` / `scanAgents` 已随扫描逻辑搬进 `store.js`，但请求处理里仍在用它们
// （页面分支的 `const root = agentsRootOf(config)`、以及 `/api/unread` 与首页分支的 `scanAgents(...)`）。
// 只导入 `scanAgentsFromConfig` 会让每个 `/x/agents/*` 请求抛 `ReferenceError` ⇒ `dsh-host-webserver`
// 的 catch 回**裸 400**（无 body）⇒ 侧栏整页白屏（用户报「agents 的 sideview 不可见」）。
// 教训：这类"搬模块漏 import"只有真跑一次请求才会暴露 ⇒ 由 p3-96（页面交互探针）看守。
import { agentsBuiltinRootOf, agentsRootOf, dataRootOf, scanAgents, scanAgentsFromConfig } from './store.js';
import { addApprovalTemplate, listApprovalTemplates, removeApprovalTemplate, templateGate } from './templates.js';
import { registerAgentTools } from './tools.js';

/**
 * 工具面收敛的**去抖窗口**（2026-10-29）。
 *
 * 为什么从 150ms 提到 800ms：
 *   · `tools/change` 在启动期会**成簇**到达（MCP 一口气注册 39 个工具）⇒ 150ms 的窗口把这一簇
 *     切成 **4 轮**（真机日志：同一 preset 收敛 4 次：59→61→100→39）。
 *   · 每一轮都要让**每个作用域**（30 个 preset + 每个 agent 的 allowlist）各算一次 ⇒
 *     轮数 × 作用域数 = 首启的十几秒（实测 Host 冷启动 24.3s 里有 ~18s 在这里）。
 *   · 窗口放大到 800ms ⇒ 成簇事件合并成 **1 轮** ⇒ 同样的工作量少跑 3/4。
 *
 * 为什么安全：
 *   · 振荡环（2026-10-20 那次"掩码来回切 600 轮"）是**同步**触发的，靠 `running` 防重入标志切断，
 *     **不依赖**去抖窗口大小 ⇒ 放大窗口不会让环复活 ✓；
 *   · 工具面收敛本来就是"稍晚一点生效"的东西（模型看到工具列表晚 0.8s 无感）✓。
 */
const TOOL_SURFACE_DEBOUNCE_MS = 800;

/**
 * lazy 注册（★ 2026-10-29，首启提速）：启动只注册少量 preset，其余 `LAZY_FILL_DELAY_MS` 后一次性补齐
 * （规则见 `syncPresets` 里那段注释）。默认开；回到全量：cordis 配置 `presetMode: eager` 或 `VSSAROS_DSH_PRESET_MODE=off`。
 */
const LAZY_FILL_DELAY_MS = 15_000;
/** 启动时按扫描顺序补足到这个数（委派清单引用的、最近会话用过的不受此限，必须先就位）。 */
const LAZY_EAGER_MAX = 3;
/** 当前还在 lazy 窗口里的那个 state（只有它需要"建会话前先补齐"）。 */
const lazyPresetHooks = { state: null };

/**
 * lazy 补齐：整个 state 只排一个定时器；到点（或有人要用还没注册的 preset 时）等在飞的那一轮跑完，再跑一次全量。
 * 走 `syncOnce` 而不是直接 `applyDesired`：全量那一轮还负责第一阶段、委派清单和撤掉已删除 agent 的 preset。
 */
function scheduleLazyFill(state, config, total) {
	if (state.lazyFill) {
		return;
	}
	let timer;
	let running;
	const fillNow = () => {
		if (running) {
			return running;
		}
		clearTimeout(timer);
		state.lazyFilled = true;
		running = (async () => {
			await syncSerial(state, state.presets, config);
			console.warn(`[vssaros-agents] lazy 补齐完成：preset 共 ${state.registered.size} 个`);
		})().catch((e) => {
			console.error(`[vssaros-agents] lazy 补齐 preset 失败：${String(e?.message ?? e)}`);
		}).finally(() => {
			// ★ 2026-11-03：给 HTTP 层一个"补齐已结束"的判据 —— Bots 页签据此自动重拉一次，
			//   否则它会一直显示启动早期那份"大量未注册"的快照（用户截图里 24 个未注册就是这么来的）。
			state.lazyFillDone = true;
			if (lazyPresetHooks.state === state) {
				lazyPresetHooks.state = null;
			}
		});
		return running;
	};
	state.lazyFill = { fillNow };
	lazyPresetHooks.state = state;
	timer = setTimeout(() => { void fillNow(); }, LAZY_FILL_DELAY_MS);
	console.warn(`[vssaros-agents] lazy 注册：启动注册 ${state.registered.size} 个 preset，其余 ${Math.max(0, total - state.registered.size)} 个 ${Math.round(LAZY_FILL_DELAY_MS / 1000)}s 后补齐`);
}

/** lazy 窗口内要用一个还没注册的 preset 建会话 ⇒ 先补齐（否则 session.create 会报未知 preset）。 */
async function ensureLazyPreset(presetId) {
	const state = lazyPresetHooks.state;
	if (!state?.lazyFill || typeof presetId !== 'string' || !presetId) {
		return;
	}
	for (const entry of state.registered.values()) {
		if (entry.presetId === presetId) {
			return;
		}
	}
	await state.lazyFill.fillNow();
}

/** 已经探测过的 preset（每个只打一行，避免刷屏）。 */
const probedPresets = new Set();

/**
 * 会话建好之后，用**该会话的 agent 作用域**查一次可见工具名（2026-11-03，`unknown tool "pwsh"` / `"read"` 诊断）。
 *
 * 为什么必须用作用域而不是全局：这两个工具的**顶层 profile 行被官方 dsh-web-app 硬编码禁用**
 * （rc.2 `cordis.patch.yml:483`）⇒ 只能由 preset 行提供，工具注册在**preset 层**；
 * 全局视图（`tools.view()` 不带 scope）根本看不到它们 ⇒ 只有这个作用域能回答"这个会话到底有没有工具"。
 *
 * 只读、只记日志：任何一步失败都静默（诊断不该影响建会话）。
 */
export function probeToolScope(toolsOf, presetId, created) {
	try {
		const key = String(presetId ?? '(none)');
		if (probedPresets.has(key) || !toolsOf) {
			return;
		}
		// create 的返回值形状随版本变：agent 可能挂在 result / result.session 上，也可能就是 agent 本身。
		// ⚠ 不能无条件 fallback 到 `created`：空对象（或别的东西）会被当成 scope ⇒ 多打一行无意义的探测。
		const agent = created?.agent ?? created?.session?.agent ?? (created?.session ? created : undefined);
		if (!agent) {
			return;
		}
		const tools = toolsOf();
		const visible = tools?.view?.(agent)?.visible;
		if (!visible || typeof visible.keys !== 'function') {
			return;
		}
		probedPresets.add(key);
		const names = [...visible.keys()];
		const has = (n) => (names.includes(n) ? '在' : '缺');
		console.log(`[vssaros-agents] 作用域探测 (preset=${key})：可见工具 ${names.length} 个`
			+ ` ⇒ pwsh=${has('pwsh')} read=${has('read')} write=${has('write')} run_code=${has('run_code')}`
			+ `（shell 类里还有：${names.filter((n) => /pwsh|bash|shell|exec/.test(n)).slice(0, 6).join(',') || '无'}）`);
	} catch { /* 诊断永不抛 */ }
}

/** 给 sessionController 套一层：`create({ agentPreset })` 之前先确保那个 preset 已注册。 */
function withLazyPresetGuard(sc, toolsOf) {
	if (!sc || typeof sc.create !== 'function') {
		return sc;
	}
	return new Proxy(sc, {
		get(target, prop) {
			if (prop === 'create') {
				return async (options, ...rest) => {
					await ensureLazyPreset(options?.agentPreset);
					const created = await target.create(options, ...rest);
					probeToolScope(toolsOf, options?.agentPreset, created);
					return created;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

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
 * ⚠ 只影响「侧栏名册 / 编辑区页面 / `/api/agents`（聊天欢迎卡与选择器读它）」。
 *   2026-11-09：主助理已删除，且按用户决策不做存量会话兼容层；
 *   画布 Run 默认改为 `workflow-agent`。
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
		// Bot 身份投影（同 key + 同 stateVersion 的多次 register = ref-count 共享 ✓）
		child.sessionProjections.register(botIdentityProjection());
		// ★★ 2026-10-29 探针（③ 的可行性）：**effect 真正执行的时刻**（harness 会给这行打时间戳）。
		//   背景：apply() 本身只要 0~1ms，但两行 persona 之间恒定隔 ~400ms ⇒ 要分清
		//   「我们的注册本身慢」还是「dsh 在两行 composition 之间等」。
		//   若本行时间戳与 apply 入口同刻 ⇒ 我们的注册立即生效 ⇒ 那 400ms 全在 dsh 侧
		//   ⇒ ③（把 persona 注入延后）帮不上，只有 ②（减少行数）有效 ✓。
		console.warn(`[vssaros-agents] persona effect 执行（${config.agentId ?? config.presetId ?? '?'}）`);
		return () => {
			projections = undefined;
		};
	}));
	// ★ 2026-11-06「记忆收敛」S4：Bot 记忆由 @vssaros/dsh-memory 的 bot 轨注入（快照里的「本 Bot 的记忆」段），
	//   本插件的人设段只剩人设正文与「你的技能」。

	// ★ 17.1 P1（2026-11-09）：`skills:` 由 `toPresetDefinition` 进 preset 声明，这里登记给
	//   vssaros-skills 的进程内写服务 ⇒ 目录发布器按 agent scope 让它们绕过 tier 常驻可见。
	//   旧做法（每 60s 扫盘 + `ownedSkillsText` 拼进人设段）退出主链路：同一件事两条真源、
	//   定时改写 prompt 且能力包展开的技能被丢掉。服务不可用时（老版 skills 插件）静默降级，
	//   技能本身仍由官方 registry 提供，只是不额外置顶。
	const declaredSkills = Array.isArray(config.skills) ? config.skills.filter(s => typeof s === 'string' && s.trim()) : [];
	if (declaredSkills.length && config.agentId) {
		let svc = null;
		try { svc = ctx.get?.('vssarosSkills') ?? ctx.vssarosSkills ?? null; } catch { /* 假 ctx 会抛 */ }
		if (svc && typeof svc.pin === 'function') {
			try { svc.pin(config.agentId, declaredSkills); } catch { /* 登记失败不影响会话 */ }
		}
	}

	// 人设正文与记忆快照**都为空**时不注册这条 section（空段没有信息，只是给系统提示塞一个空块）。
	// 工具 allowlist 在下面独立注册，不受这个条件影响 ✓。
	const hasSectionText = Boolean(staticPersona.trim());
	if (hasSectionText) {
		ctx.inject(['systemPrompt'], child => child.effect(() => child.systemPrompt.section({
			name: PERSONA_SECTION_NAME,
			order: sectionOrderOf(child),
			// **函数形式**：每次装配按 `context.agent` 取该会话的当前人格（会话内切换过就是新的）；
			// 没切换过 / 取不到 → 退回 preset 自带人设，行为与从前完全一致。有记忆快照就追加 ✓。
			text: (context) => switchedPersonaText(projections, context) ?? staticPersona,
		})));
	}

	// 工具 allowlist（★ 2026-10-25 重写；真机：saroasis-studio 会话里只剩 `skill` + `subagent`）。
	// 旧实现两处错叠在一起：
	//   ① 在 **preset 作用域**里调 `child.tools.schemas()` —— 不传 scope 拿到的是**全局视图**，
	//      基座在 preset 层注册的 read / write / pwsh / web_search … 一个都看不到 ⇒ 全判"不认识"丢掉；
	//   ② 剩下的全局名（skill / codebase_* …）拿去 `restrict({ allow })`，挂在 **preset 层** ——
	//      agent 作用域的父链是 preset ⇒ 对 agent 而言 preset 层的工具是"继承来的"，被这张 allow 一起筛掉
	//      （dsh-tools `view()`：restriction filters what a scope inherits — global + every ancestor layer）。
	//   ⇒ 只要 tools 里有一个全局名，agent 就只剩那几个（saroasis-studio=skill；coder/tester=codebase_*）。
	// 新做法：口径不变（只收窄 host 层全局工具、基座官方工具始终可用），实现搬到 **agent 作用域**，用 deny。
	const wanted = Array.isArray(config.tools) ? config.tools.filter(t => typeof t === 'string' && t.trim()) : [];
	if (wanted.length) {
		installAllowlist(ctx, config, wanted);
	}
	// ★ 2026-11-03：会话绑定 = ① 身份记录（这个会话属于哪个 bot）② `.agent.md` 的 `model:` 会话级选择
	installSessionBinding(ctx, config);
}

/**
 * 本 preset 的会话（新建 / 恢复都会触发 `agent/created`）：
 *   ① 写 Bot 身份记录（plugin record，见 core/botIdentity.js / lib/botIdentityWriter.js；已写过不重复；
 *      恢复的老会话会被**补写**一条 ⇒ 老会话也逐步有记录）；
 *   ② 按 `.agent.md` 的 `model:` 选模型（见 lib/modelSelection.js 头注释的四条规则）。
 *
 * · 与 `installAllowlist` 同一挂法：preset 作用域订阅 `agent/created`，再核一次会话的 agentPreset 防误伤。
 * · 路由按 agentId 现查（`agentModelRouteOf`）⇒ 改了 `model:` **不需要**重挂 preset，新会话即生效。
 * · 模型：命中校验缓存时是**同步**提交（`applyModelSelection` 在第一个 await 之前完成）⇒ 调用方建完会话紧接着
 *   steer 也赶得上第一步装配。
 * · 身份记录：推到 `setImmediate` 再写 —— `agent/created` 可能在别的 append 发布过程中派发，
 *   dsh 禁止重入 append（"session append cannot reenter"）。
 */
function installSessionBinding(ctx, config) {
	const agentId = typeof config.agentId === 'string' ? config.agentId : '';
	const presetId = typeof config.presetId === 'string' ? config.presetId : '';
	if (!agentId) {
		return;
	}
	const deps = { sc: undefined, llm: undefined, projections: undefined };
	ctx.inject(['sessionController'], child => child.effect(() => {
		deps.sc = child.sessionController;
		return () => { deps.sc = undefined; };
	}));
	ctx.inject(['llm'], child => child.effect(() => {
		deps.llm = child.llm;
		return () => { deps.llm = undefined; };
	}));
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		deps.projections = child.sessionProjections;
		return () => { deps.projections = undefined; };
	}));
	const seen = new WeakSet();
	try {
		ctx.on('agent/created', ({ agent }) => {
			if (!agent?.session || seen.has(agent)) { return; }
			if (presetId && deps.projections) {
				let current;
				try { current = deps.projections.stateOf(agent.session, 'agentPreset'); } catch { current = undefined; }
				if (typeof current === 'string' && current && current !== presetId) { return; }
			}
			seen.add(agent);
			if (presetId) {
				setImmediate(() => {
					void writeBotIdentity({ projections: deps.projections }, agent, { botId: agentId, presetId }).then((result) => {
						if (!result.ok && result.reason !== 'already') {
							console.warn(`[vssaros-agents] agent ${agentId} 会话 ${agent.session?.header?.id ?? '?'} 身份记录没写上（${result.reason}）⇒ 按 preset 推断`);
						}
					});
				});
			}
			const route = agentModelRouteOf(agentId, 'main');
			if (!route) { return; }
			void applyModelSelection(deps, agent, route, { onlyIfBlank: true }).then((result) => {
				if (result.ok) {
					console.log(`[vssaros-agents] agent ${agentId} 新会话 ${agent.session?.header?.id ?? '?'} 模型 → ${result.selected.provider}/${result.selected.model}`);
				} else if (result.reason !== 'not-blank' && result.reason !== 'subagent') {
					console.warn(`[vssaros-agents] agent ${agentId} 的模型没选上（${result.reason}）⇒ 该会话跟随默认模型`);
				}
			});
		});
	} catch (error) {
		console.warn(`[vssaros-agents] agent ${agentId}：订阅 agent/created 失败，model 不生效（${String(error?.message ?? error)}）`);
	}
}

/**
 * 在**本 preset 的每个 agent** 的作用域里装 allowlist：`restrict({ deny: 全局名 − 声明 − 被遮蔽的同名 })`。
 *
 * · 为什么在 agent 作用域：`agent/created` 由 agent 的 carrier 派发，preset 作用域里的监听只收**后代** agent
 *   的事件（dsh-scope `scopeTarget`）；agent 的作用域 key 就是 agent 本身（dsh-agent-loop `createScope(loopCtx, this)`），
 *   所以 `tools.get(name, agent)` 能读到它真正看到的定义 —— 用来判"同名被基座遮蔽"（典型：skill）。
 * · 为什么 deny 只增不减 + 订阅 tools/change：MCP 等全局工具是异步注册的；deny 名单只看**全局视图**
 *   （不受本 agent 掩码影响）⇒ 不会出现 10-20 那次"掩码振荡"。
 * · 为什么再核一次会话的 agentPreset：事件准入是按作用域链判的，这里是防御 —— 万一收到别的 preset 的 agent，
 *   拿本 agent 的名单去收窄它就是事故。
 */
function installAllowlist(ctx, config, wanted) {
	const label = config.agentId ?? '(unknown)';
	const presetId = typeof config.presetId === 'string' ? config.presetId : '';
	let projections;
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		projections = child.sessionProjections;
		return () => { projections = undefined; };
	}));
	const attached = new WeakSet();
	const attach = (agent) => {
		if (!agent?.ctx || attached.has(agent)) { return; }
		if (presetId && projections && agent.session) {
			let current;
			try { current = projections.stateOf(agent.session, 'agentPreset'); } catch { current = undefined; }
			if (typeof current === 'string' && current && current !== presetId) { return; }
		}
		attached.add(agent);
		try {
			agent.ctx.inject(['tools'], runtime => runtime.effect(() => watchAllowlist(runtime, agent, label, wanted)));
		} catch (error) {
			console.warn(`[vssaros-agents] agent ${label} 的工具白名单没装上（${String(error?.message ?? error)}）`);
		}
	};
	try {
		ctx.on('agent/created', ({ agent }) => { attach(agent); });
	} catch (error) {
		console.warn(`[vssaros-agents] agent ${label}：订阅 agent/created 失败，工具白名单不生效（${String(error?.message ?? error)}）`);
	}
}

/** agent 作用域里的 deny 同步：只增不减、防重入、去抖（与 denyTools 同一套纪律）。 */
function watchAllowlist(runtime, agent, label, wanted) {
	const tools = runtime.tools;
	let dispose;
	let applied = new Set();
	let reported = false;
	let warnedScope = false;
	let running = false;
	let rerun = false;
	let timer;
	let mcpReported = false;   // ★ 2026-10-29：MCP 工具到位的计时只报一次
	// ★ 2026-10-29：工具名快照（按实例隔离 + 按 `tools/change` 版本失效）。
	const nameSnapshot = createToolNameSnapshot();
	const shadowed = (name) => {
		const mine = tools.get?.(name, agent);
		return mine !== undefined && mine !== tools.get?.(name);
	};
	const syncOnce = () => {
		// ★ 2026-10-29：原来每次都 `tools.schemas()`（每个可见工具一次 parameters 深拷贝）
		//   ⇒ 这里每个 agent 一份、每轮一次 ⇒ 首启的大头。改成"只要名字"+按实例版本失效的快照。
		const globalNames = nameSnapshot.namesOf(tools);
		if (!globalNames) {
			return;   // 注册表还没就绪：等下一次 `tools/change`
		}
		// ★ 2026-10-29 计时探针：MCP 客户端连上时工具会**成簇**多出几十个（实测 +39，`mcp__comfy-mcp__*` 等）。
		//   这一簇出现的时刻 ≈ MCP 服务器 spawn + 握手完成的时刻 ⇒ 记一行相对 Host 启动的耗时，
		//   好判断那 8 秒静默期是不是 MCP。hostStartedAt 取进程启动时刻（`process.uptime()` 反推）。
		if (!mcpReported) {
			const mcpCount = globalNames.filter((name) => name.startsWith('mcp__')).length;
			if (mcpCount > 0) {
				mcpReported = true;
				const hostStartedAt = Date.now() - Math.round(process.uptime() * 1000);
				console.warn(`[vssaros-agents] MCP 工具到位：host 启动后 ${Date.now() - hostStartedAt}ms，共 ${mcpCount} 个`);
			}
		}
		const next = new Set([...applied, ...allowlistDenyOf(wanted, globalNames, shadowed)]);
		if (next.size === 0 || (dispose && next.size === applied.size)) { return; }
		try {
			const previous = dispose;
			dispose = tools.restrict({ deny: [...next] });
			applied = next;
			previous?.();
			if (!reported) {
				reported = true;
				console.warn(`[vssaros-agents] agent ${label} 工具白名单：隐藏 ${next.size} 个 host 层工具（保留声明的 ${wanted.length} 个 + 基座官方工具）`);
			}
		} catch (error) {
			if (!warnedScope) {
				warnedScope = true;
				console.warn(`[vssaros-agents] agent ${label} 工具白名单未生效（${String(error?.message ?? error)}）`);
			}
		}
	};
	const schedule = () => {
		if (timer) { return; }
		timer = setTimeout(() => { timer = undefined; sync(); }, TOOL_SURFACE_DEBOUNCE_MS);
		timer.unref?.();
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
		// 工具注册/撤销 ⇒ 可见集变了 ⇒ 快照作废（否则新工具会漏藏，且没有下一次事件来补 ✗）。
		off = runtime.on?.('tools/change', () => { nameSnapshot.invalidate(); schedule(); });
	} catch { off = undefined; }
	return () => {
		try { off?.(); } catch { /* 退订失败不影响收尾 */ }
		try { if (timer) { clearTimeout(timer); timer = undefined; } } catch { /* 同上 */ }
		try { dispose?.(); } catch { /* 同上 */ }
		dispose = undefined;
		applied = new Set();
	};
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
	// ★ 2026-11-02 启动计时探针（只记录，不改行为）：拆 syncPresets 内部各段耗时。
	const syncT0 = Date.now();
	const mark = (label) => console.log(`[vssaros-agents] 计时 syncPresets ${label}：+${Date.now() - syncT0}ms（进程启动后 ${Math.round(process.uptime() * 1000)}ms）`);
	mark('开始');
	const scan = await scanAgentsFromConfig(config, undefined);
	mark(`扫描完成（${scan.agents.length} 个 agent）`);
	const provider = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim() : '';
	const errors = [...scan.errors];
	const diagnostics = [];
	// ★ 2026-11-03：一个 agent **只对应一个** preset。原来写了 `model-assignment` 的 agent 还会派生一条
	//   `<preset>-assign`（只差一行 default-model）——那一行在 dsh API 会话里没有消费方，从未生效，已移除。
	//   模型改为会话级选择：这里刷新路由表，会话创建时由 `installModelApply` / 委派入口按它选（lib/modelSelection.js）。
	//   `state.registered` 的 key = `agentId`（不用 presetId，免得与"源文件消失"判据打架）。
	setAgentModelRoutes(scan.agents, provider);
	void prevalidateRoutes({ sc: state.rawSessionController, llm: state.llm });

	/**
	 * 按扫描结果构造要注册的定义。
	 * @param allowedAgentPresets `null` = 不挂 `tool-subagent`（第一阶段）；数组 = 挂上动态清单。
	 */
	const buildDesired = (allowedAgentPresets) => {
		const desired = scan.agents.map((agent) => ({
			key: agent.id,
			agent,
			...toPresetDefinition(agent, {
				provider,
				...(allowedAgentPresets ? { allowedAgentPresets } : {}),
			}),
		}));
		return desired;
	};

	// ★ 2026-11-03 诊断（只记录）：真机 `Error: unknown tool "pwsh"` / `"read"` 排查用。
	//   这两个工具由 `@deepseek-ai/dsh-tool-pwsh` / `dsh-tool-fs` 注册，而**顶层 profile 行被官方
	//   dsh-web-app patch 硬编码 `disabled: true`**（rc.2 `cordis.patch.yml:483`）⇒ 只能由 preset 提供。
	//   我们的基座里这两行的 `disabled` 是 `{ __jsExpr: "process.platform !== 'win32'" }` 标记对象
	//   （`core/presetBase.generated.js`），本应由 cordis loader 求值 ⇒ 把**注册出去的实际形态**打出来：
	//   · 仍是对象 / 字符串 ⇒ 求值没发生（truthy ⇒ 工具被禁 ✗）
	//   · false / 缺省 ⇒ 正常启用 ✓
	{
		const sample = scan.agents[0];
		if (sample) {
			try {
				// ⚠ `toPresetDefinition` 返回的是 `{ definition, notes }`（见 `buildDesired` 的展开）——
				//   直接取 `.plugins` 会拿到 undefined，误报"基座里没有这两行"（第一版就是这个假警报）。
				const rows = (toPresetDefinition(sample, { provider })?.definition?.plugins ?? [])
					.filter((row) => row && /^tool-(pwsh|fs)$/.test(String(row.id ?? '')));
				const desc = rows.length
					? rows.map((row) => `${row.id}.disabled=${row.disabled === undefined ? '(缺省=启用)' : JSON.stringify(row.disabled)}`).join('  ')
					: '（基座里没有 tool-pwsh / tool-fs 行！）';
				console.log(`[vssaros-agents] 诊断 shell 工具行（以 ${sample.id} 的 preset 为例）：${desc}`);
			} catch (e) {
				console.log('[vssaros-agents] 诊断 shell 工具行失败：' + String(e?.message ?? e));
			}
		}
	}

	/**
	 * @param allowedAgentPresets `null` = 不带清单（第一阶段）；数组 = 带清单
	 * @param record 是否写诊断（只有最后一轮记，免得同一个 agent 记两条）
	 * @param only 只处理这些 key（`undefined` = 全部）。第一阶段用它把影响面收窄到"新增的 preset"。
	 */
	const applyDesired = async (allowedAgentPresets, record, only, phase = '?') => {
		// ★ 2026-11-02 启动计时探针（只记录，不改行为）：拆清楚 dsh 侧 `register` / `dispose` 的真实耗时。
		//   为什么需要：主进程日志里 Host 行的时间戳是 supervisor **每 400ms 轮询** host 日志时打的
		//   （dshHostSupervisor `setInterval(…, 400)`）⇒ 相邻 persona 恰好隔 400/414ms 是量化假象，
		//   既不能证明也不能否定上面"每个 preset 挂载约 0.4s"的说法。这里用 Host 进程内的
		//   `Date.now()` 直接计时 ⇒ 不受轮询影响。
		const phaseT0 = Date.now();
		let regCount = 0;
		let regMs = 0;
		let dispCount = 0;
		let dispMs = 0;
		const uptimeMs = () => Math.round(process.uptime() * 1000);
		for (const { key, agent, definition, notes } of buildDesired(allowedAgentPresets)) {
			if (only && !only.has(key)) {
				continue;
			}
			// 指纹直接取定义本身（含子代理清单）——比手写字段清单更不容易漏
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
				const disposeT0 = Date.now();
				try {
					await existing.dispose();
				} catch (e) {
					errors.push(`撤销旧定义失败（${key}）：${String(e?.message ?? e)}`);
				}
				const disposeTook = Date.now() - disposeT0;
				dispCount++;
				dispMs += disposeTook;
				console.log(`[vssaros-agents] dispose ${existing.presetId} 用时 ${disposeTook}ms（${phase}；进程启动后 ${uptimeMs()}ms）`);
				state.registered.delete(key);
			}
			const registerT0 = Date.now();
			try {
				const dispose = await presets.register(definition);
				const registerTook = Date.now() - registerT0;
				regCount++;
				regMs += registerTook;
				console.log(`[vssaros-agents] register ${definition.id} 用时 ${registerTook}ms（${phase}；进程启动后 ${uptimeMs()}ms）`);
				state.registered.set(key, { presetId: definition.id, fingerprint, dispose });
				if (record) {
					diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: true });
				}
			} catch (e) {
				const registerTook = Date.now() - registerT0;
				regCount++;
				regMs += registerTook;
				console.log(`[vssaros-agents] register ${definition.id} 失败，用时 ${registerTook}ms（${phase}；进程启动后 ${uptimeMs()}ms）`);
				// 注册失败要看得见（dsh 侧自己的花名册也会留一条带诊断的失败行，但那是它的口径）
				errors.push(`注册 preset 失败（${definition.id}）：${String(e?.message ?? e)}`);
				if (record) {
					diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes: [...notes, '注册失败'], changed: true });
				}
			}
		}
		if (regCount || dispCount) {
			console.log(`[vssaros-agents] applyDesired(${phase}) 合计 ${Date.now() - phaseT0}ms：`
				+ `register ×${regCount} = ${regMs}ms，dispose ×${dispCount} = ${dispMs}ms（进程启动后 ${uptimeMs()}ms）`);
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
	// ★★ 2026-10-29 lazy 注册（默认开；回到全量：cordis 配置 `presetMode: eager`，或环境变量 `VSSAROS_DSH_PRESET_MODE=off`）。
	//   为什么有效：dsh 的 preset discovery 每次注册都全量重扫 roots（官方源码
	//   `packages/preset/agent-presets/src/discovery.ts`："re-reads the roots on every call"）⇒ 耗时随 preset 数平方增长；
	//   实测 30 个 preset ≈ 13s；lazy 下端到端（start → mux 可用）从 30.7–33.0s 降到 20.6–21.8s。
	//   语义不变：每个 agent 仍有自己的 presetId，只把注册时机推后。三条规则：
	//     ① 委派清单引用的、最近会话用过的必须先注册（见 `pickLazyEagerKeys`）；
	//     ② 阶段 2 也用同一批 key 门控（否则会把全部注册回去）；
	//     ③ 补齐走 `syncOnce`（等在飞的一轮结束后再跑一次全量），整个 state 只排一个定时器（见 `scheduleLazyFill`）。
	//   ⚠ 曾误判"补齐从不执行"：keepAlive 下 harness 在 ready 后不再读 Host 日志，补齐日志只在 `dsh-run/host-*.log`
	//     （supervisor 已改为 ready 后继续读）。
	const lazyRequested = config?.presetMode !== 'eager' && process.env.VSSAROS_DSH_PRESET_MODE !== 'off';
	const lazyMode = lazyRequested && !state.lazyFilled;
	const recentPresets = (lazyMode ? await recentSessionPresetIds(config, { limit: 8 }) : []);
	mark(`定义构造 + 最近会话读取完成（wanted ${wantedKeys.length}，missing ${missingKeys.length}，recent ${recentPresets.length}）`);
	const eagerKeys = lazyMode
		? pickLazyEagerKeys(wantedKeys, { delegatable: delegatablePresetIds, recent: recentPresets, max: LAZY_EAGER_MAX })
		: undefined;
	const gate = (keys) => (eagerKeys ? keys.filter((key) => eagerKeys.has(key)) : keys);
	const isDelegatableKey = (key) => delegatablePresetIds.has(presetIdOf(key));
	const needFirstPass = missingKeys.some(isDelegatableKey);
	if (needFirstPass) {
		// ★ 2026-10-29：第一阶段**只注册会被清单引用的**（可委派的）。原来把全部缺失 key 都先注册一遍，
		//   第二阶段带清单时指纹变了又全部撤掉重注册 ⇒ 每个 preset 注册两次（eager 实测 59 次 ≈ 30×2）。
		//   不可委派的 preset 不在任何清单里，第二阶段注册一次就够。
		await applyDesired(null, false, new Set(gate(missingKeys).filter(isDelegatableKey)), lazyMode ? 'phase1/lazy' : 'phase1');
	}
	const okPresetIds = [...state.registered.entries()]
		.filter(([key]) => shownIds.has(key))
		.map(([, entry]) => entry.presetId)
		.sort();
	// 第二阶段：带动态清单（已一致的 preset 指纹相同 ⇒ 直接跳过，不会重复注册）
	// ⚠ lazy 下必须传 `eagerKeys` 作为 only：否则这一轮会把刚省下的 preset 全部注册回去
	// ★ 2026-10-29：lazy 下再进一步——**可委派的那几个不做第二阶段**（它们保持"无清单"的形态）：
	//   每个 preset 挂载约 0.4s（挂 33 行基座 + dsh 重扫 30 个 agent.md）⇒ 5 个可委派各挂两遍就是 ~4s。
	//   代价：这 5 个 agent 在补齐（15s）之前不能派生子代理；其余 agent 不受影响（它们的清单引用的是
	//   这 5 个，引用已就位 ⇒ 仍可立即派生子代理）✓。
	const phase2Only = lazyMode ? new Set([...eagerKeys].filter((key) => !isDelegatableKey(key))) : eagerKeys;
	await applyDesired(okPresetIds, true, phase2Only, lazyMode ? 'phase2/lazy' : (state.lazyFilled ? 'phase2/fill' : 'phase2'));
	state.subagentListSig = okPresetIds.join('|');
	mark('两阶段注册完成');
	if (lazyMode) {
		scheduleLazyFill(state, config, wantedKeys.length);
	}
	const seenKeys = new Set(wantedKeys);
	// 源文件消失的 preset：撤掉（只增不删会让花名册里留幽灵）
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
		diagnostics.push({ agentId: key, presetId: entry.presetId, rows: 0, notes: ['源文件已消失 → 已注销该 preset'], changed: true });
	}
	try {
		const roster = await presets.list();
		state.roster = roster.map(p => p.id).filter(id => typeof id === 'string').sort();
	} catch (e) {
		errors.push(`读取花名册失败：${String(e?.message ?? e)}`);
	}
	mark('结束（含撤销消失的 preset + 读花名册）');
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

/**
 * 排队同步（★ 2026-10-29）：先等在飞的那一轮跑完，再跑**新的一轮**（不会像 `syncOnce` 那样直接复用旧结果）。
 *
 * 给"刚改了东西、必须看到改动"的调用者用（启动首轮、`rescan`、lazy 补齐）。
 * 为什么首轮也要走这里：首轮原来直接调 `syncPresets`、不登记 `state.syncing` ⇒ 页面请求经 `syncOnce`
 * 看不到它在飞 ⇒ 并发再起一轮 ⇒ 实测 lazy 下首批 7 个 preset 被注册了 4 遍（多花 ~5s）。
 */
async function syncSerial(state, presets, config) {
	try { await state.syncing; } catch { /* 上一轮失败不影响这一轮 */ }
	return syncOnce(state, presets, config);
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

/**
 * 读**原始字节**（2026-10-26，群聊附件上传用）。
 *
 * 为什么不用 `readJsonBody`：附件是二进制，塞 JSON 要么 base64（体积 ×1.33 + 巨型字符串），
 * 要么 multipart（要自己写解析器）。直接收字节最省。
 * 超过 `limit` 立刻抛 413 —— 不把内存撑爆（前端也会按同一上限先拦一次）。
 */
async function readRawBody(req, limit) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limit) {
			throw Object.assign(new Error(`请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB`), { httpStatus: 413 });
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
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

	/* ── IM 绑定（2026-10-27，P0）──────────────────────────────────────────────
	   装配顺序很重要：Hub 先建好挂到 state 上，回合结束的回复回收才能在结束那一刻
	   把 IM 那条答复推回去（回收器读 `state.bindingHub`）。
	   `loopback` 适配器是**进程内模拟器**：没有飞书凭据也能把整条链路跑通（演练/自测）。 */
	const loopbackAdapter = createLoopbackAdapter();
	state.bindingHub = createBindingHub({
		config,
		/* 2026-11-04 多飞书应用：绑定/消息的应用为空时都按当前默认应用算（老绑定行为不变） */
		defaultFeishuAppId: async () => (await resolveFeishu(config)).appId,
		/* ★ 2026-11-09：Bot 设置页选的应用要真正承接 —— 入站路由与出站身份都以它为回落。 */
		botApps: async () => readBotFeishuApps(config),
		log: (level, msg) => {
			try { (level === 'warn' ? console.warn : console.info)(`[vssaros-agents][im] ${msg}`); } catch { /* 忽略 */ }
		},
		scanAgents: (cfg) => scanAgentsFromConfig(cfg),
		/* 幂等跨重启（imSeen.js）：飞书会重投事件，只靠内存去重会在 Host 重启后失效
		   —— 表现是"同一条消息被回两遍"，很容易被当成重复 bot。 */
		seen: { mark: (key) => markInboundSeen(config, key) },
		/* 配对（2026-10-27）：Hub 在 `pairing-required` 时登记请求 + 回码；
		   准入判定把**已批准的人**并入白名单（与 config allowFrom 合并）。 */
		pairing: {
			approvedFor: (platform, appId) => approvedUserIds(config, platform, appId),
			request: (input) => requestPairing(config, input),
		},
		/* 死信：只在"被拒/失败"时记（duplicate / pairing-required 不记，见 deadLetters.js 头） */
		deadLetters: { record: (entry) => recordDeadLetter(config, entry) },
		dispatchAgent: (cfg, binding, msg) => dispatchImToAgent(cfg, state, binding, msg, {
			scanAgents: (c) => scanAgentsFromConfig(c),
			ensureSession: (c, st, agent) => ensureAgentSession(c, st, agent),
			/* ★ 2026-10-29：**每条绑定固定一条会话**（否则每次派发都可能新建一条「未命名会话」，
			   用户在 Bots 页/工作区里认不出哪条是飞书来的）。映射单独存盘，见 imSessionMap.js。 */
			imSessions: {
				get: (c, bindingId) => getImSession(c, bindingId),
				set: (c, bindingId, sessionId) => setImSession(c, bindingId, sessionId),
			},
			/* 新会话起名（`飞书 · VsSaros知识库`）：dsh 只有 sessionController.rename 能真改名，
			   老版本没有该服务 ⇒ 静默跳过（派发不受影响）。 */
			renameSession: async (sessionId, title) => {
				const sc = state.sessionController;
				if (!sc || typeof sc.rename !== 'function') { return; }
				await sc.rename({ sessionId, title });
			},
		}),
	});
	state.bindingHub.register(loopbackAdapter);
	state.loopbackAdapter = loopbackAdapter;
	/* 飞书**出站**：两条通道（2026-10-28）。
	   ① 绑定里填了 `webhookUrl` ⇒ 自定义机器人（不消耗应用权限）；
	   ② 没填 ⇒ **应用模式**：用「设置 → 渠道」里的 App ID / App Secret 换 tenant_access_token，
	      `im/v1/messages?receive_id_type=chat_id` ⇒ **填个 chat_id 就能发**（用户就是这么预期的）。
	   `resolveApp` 现取而不是启动快照 ⇒ 在设置里填完立刻生效，不用重启 Host。 */
	state.bindingHub.register(createFeishuAdapter({ resolveApp: (appId) => resolveFeishuApp(config, appId) }));
	/* 飞书**入站**（P2）：长连接。传输层用官方 SDK；没装/没凭据 ⇒ start() 抛 unavailable，
	   由 API 如实回报（不假装"正在连接"）。这里**不自动 start** —— 没凭据时反复重连只是噪音。
	   ★ 2026-10-27「数据源统一到 dsh 侧」：凭据真源改为 `<dataRoot>/agent-im-accounts.json`
	     （dsh 设置弹窗「渠道」页直接读写），`config.feishu`（IDE 覆盖层）降级为兼容回落。
	     ⇒ transport 不再吃**启动时快照**，而是每次 `start()` 现取（`resolve`）——
	       用户在设置里填完点「启动入站」就生效，不用重启 Host。 */
	/* ★ 2026-10-27「数据源统一」：把**旧位置**（IDE 设置 → `--patch` 覆盖层 → `config.feishu`）
	   的凭据**一次性**搬进 `<dataRoot>/agent-im-accounts.json`。
	   为什么先搬再下线：用户可能已经在 IDE 里填过 —— 直接删旧链路会让他"配过却显示未配置"，
	   而原值被删掉的 UI 挡住、拿不回来。搬一次之后，dsh 侧文件是唯一真源。
	   ⚠ `apply` 是同步函数 ⇒ fire-and-forget；迁移失败只记日志，绝不能影响插件装配。 */
	migrateLegacyFeishu(config)
		.then((r) => {
			if (r && r.migrated) {
				console.info(`[vssaros-agents][im] 已把 IDE 覆盖层里的飞书凭据迁到 dsh 侧（${r.appIdMasked}）`);
			}
		})
		.catch(() => undefined);

	state.feishuInbound = createFeishuGateway({
		/* ★ 2026-10-29：默认**自研协议**实现（理由见上面 import 处注释）。
		   要切回官方 SDK：把下面换成 `createSdkTransport({ resolve: () => resolveFeishu(config), importSdk: state.feishuImportSdk })`。 */
		transport: createRawWsTransport({
			resolve: () => resolveFeishu(config),
		}),
		/* ★ 2026-11-09：默认网关也必须**打上连接身份**。原来只传 msg（无 appId），
		   路由把空应用折成「当前实时默认应用」；用户把默认应用 A 改成 B 但没重启连接时，
		   A 连接收到的事件会被派给 B 的绑定并用 B 的 token 回复（串台）。
		   现在注入 start 成功的快照 ⇒ A 的事件只认 A 的绑定，认不上就 unbound（fail-closed）。 */
		onMessage: (msg) => state.bindingHub.handleInbound({
			...msg,
			appId: String(msg?.appId ?? '').trim() || (state.feishuApps ? state.feishuApps.defaultAppId() : ''),
		}),
		/* ★ 2026-11-09：原始事件一律按**这条连接**的身份扇出；事件头里的 app_id 只用来校验，
		   不再拿它决定投给谁（否则与连接不符时会把事件发给另一个应用的订阅者）。 */
		onRaw: (payload) => {
			const mine = state.feishuApps ? state.feishuApps.defaultAppId() : '';
			const claimed = appIdOfEvent(payload);
			if (claimed && mine && claimed !== mine) {
				console.warn(`[vssaros-agents][im-in] header.app_id=${claimed} 与连接身份 ${mine} 不符，按连接身份扇出`);
			}
			feishuEventBus().publish(mine, payload);
		},
		log: (level, msg) => {
			try { (level === 'warn' ? console.warn : console.info)(`[vssaros-agents][im-in] ${msg}`); } catch { /* 忽略 */ }
		},
	});

	/* ★ 2026-11-04 多飞书应用：每个额外应用一个网关、一把按应用的锁；消息打上 appId 再进路由。
	   默认应用仍是上面的 `state.feishuInbound`（只是启停改走管理器，以便统一加锁）。 */
	const imLockRoot = () => String((config && config.dataRoot) || process.env.VSSAROS_DATA_ROOT || '');
	state.feishuApps = createFeishuAppInbounds({
		defaultGateway: state.feishuInbound,
		makeGateway: (appId) => createFeishuGateway({
			transport: createRawWsTransport({ resolve: () => resolveFeishuApp(config, appId) }),
			onMessage: (msg) => state.bindingHub.handleInbound({ ...msg, appId }),
			onRaw: (payload) => feishuEventBus().publish(appId, payload),
			log: (level, msg) => {
				try { (level === 'warn' ? console.warn : console.info)(`[vssaros-agents][im-in][${appId}] ${msg}`); } catch { /* 忽略 */ }
			},
		}),
		resolveDefaultAppId: async () => (await resolveFeishu(config)).appId,
		acquire: (appId, opts) => acquireFeishuAppLock(appId, opts),
		describeHolder: describeFeishuHolder,
		dataRoot: imLockRoot,
		bus: feishuEventBus(),
		log: (level, msg) => {
			try { (level === 'warn' ? console.warn : console.info)(`[vssaros-agents][im] ${msg}`); } catch { /* 忽略 */ }
		},
	});

	/* Telegram（2026-10-27）：出站 `sendMessage` + 入站长轮询。
	   凭据从 **dsh 侧**（`agent-im-accounts.json` 的 telegram.botToken）现取 ⇒ 设置里改完不必重启 Host。
	   ⚠ 适配器的 id 必须与绑定里的 platform 同值（telegram），否则出站会 no-adapter。 */
	state.bindingHub.register(createTelegramAdapter({
		getCreds: () => resolvePlatform(config, 'telegram'),
	}));
	state.telegramInbound = createTelegramGateway({
		transport: createHttpTransport({ getCreds: () => resolvePlatform(config, 'telegram') }),
		onMessage: (msg) => state.bindingHub.handleInbound(msg),
		log: (level, msg) => {
			try { (level === 'warn' ? console.warn : console.info)(`[vssaros-agents][im-in] ${msg}`); } catch { /* 忽略 */ }
		},
	});

	/* Discord（2026-10-27）：出站 REST + 入站 Gateway WebSocket（Node 22 自带 WebSocket，无依赖）。
	   与飞书/Telegram 同一条纪律：凭据**每次 start 现取** ⇒ 设置里改完不必重启 Host。
	   ⚠ MESSAGE_CONTENT 是 privileged intent，必须在 Discord 开发者后台开启，
	     否则事件里 content 为空（症状：消息收到了但内容全空）。 */
	state.bindingHub.register(createDiscordAdapter({
		resolve: () => resolvePlatform(config, 'discord'),
	}));
	state.discordInbound = createDiscordGateway({
		resolve: () => resolvePlatform(config, 'discord'),
		onMessage: (msg) => state.bindingHub.handleInbound(msg),
		log: (msg) => {
			try { console.info(`[vssaros-agents][im-in] discord：${msg}`); } catch { /* 忽略 */ }
		},
		onError: (e) => {
			try { console.warn(`[vssaros-agents][im-in] discord 错误：${String((e && e.message) || e)}`); } catch { /* 忽略 */ }
		},
	});

	/* 企业微信（2026-10-27）：出站 REST（换 token + message/send）；入站是**被动回调**，
	   没有 start/stop —— 由 `/api/wecom/callback` 路由接（需要公网反代）。
	   凭据每次现取：设置里改完不必重启 Host。 */
	state.bindingHub.register(createWecomAdapter({
		resolve: () => resolvePlatform(config, 'wecom'),
	}));

	/* 锁里只用来"记一下是谁占着"：取值口径与 dataRoot 一致即可（读不到给空串，不影响判活）。 */
	const lockRoot = () => String((config && config.dataRoot) || process.env.VSSAROS_DATA_ROOT || '');

	/* ★ 2026-10-29：**父进程（app）退出后本 Host 自动退出**。
	   孤儿 Host 会一直攥着会话写句柄与 IM 长连接，而同一飞书应用的多条长连接**互相抢事件**
	   （真机上攒出过 3 个 Host 同时活着，表现是"日志全绿 + 心跳正常 + 零事件"）。 */
	startAppParentWatch({ log: (m) => console.info(`[vssaros-agents]${m}`) });

	/* ★ 2026-10-29：**按上次状态恢复入站**（见 imInboundState.js）。
	   用户点过「启动入站」⇒ 重启 Host 后自动恢复；没点过 ⇒ 仍然不自动连（不制造重连噪音）。
	   延迟 3s：先让 Host 把会话/服务装好，别和启动抢资源；失败只记日志，绝不能拖垮装配。 */
	setTimeout(() => {
		void (async () => {
			const enabled = await readInboundEnabled(config).catch(() => ({}));
			/* ★ 2026-11-04：飞书按**应用**加锁恢复（默认应用 + 每个记过「已启动」的额外应用）。
			   锁被占 ⇒ 管理器抛 409，这里只记一条"谁占着"，与原来的跳过语义相同。 */
			const feishuKeys = [...(enabled.feishu ? [''] : []), ...Object.keys(await readFeishuAppsEnabled(config).catch(() => ({})))];
			for (const appId of feishuKeys) {
				try {
					const st = await state.feishuApps.start(appId);
					console.info(`[vssaros-agents][im] 已按上次状态恢复入站：feishu${appId ? ' · ' + appId : ''}（${st && st.status}）`);
				} catch (e) {
					console.warn(`[vssaros-agents][im] 跳过恢复入站（feishu${appId ? ' · ' + appId : ''}）：${String((e && e.message) || e).slice(0, 240)}`);
				}
			}
			const gateways = {
				telegram: state.telegramInbound,
				discord: state.discordInbound,
			};
			for (const platform of Object.keys(gateways)) {
				const gw = gateways[platform];
				if (!enabled[platform] || !gw) { continue; }
				/* ⚠ 恢复前必须抢到**入站锁**（imInboundLock.js）：抢不到说明另一实例正占着这条长连接，
				   连上去只会把事件抢走一半（飞书只投给一条）⇒ 宁可这一边不连，并写明谁占着。 */
				const lock = await tryAcquireImLock(platform, { dataRoot: lockRoot() }).catch(() => ({ ok: false, holder: null }));
				if (!lock.ok) {
					const h = lock.holder || {};
					console.warn(`[vssaros-agents][im] 跳过恢复入站（${platform}）：另一实例（pid ${h.pid ?? '?'}，dataRoot=${h.dataRoot || '?'}）正占用该平台长连接 —— 同一应用多条连接会互相抢事件`);
					continue;
				}
				try {
					await gw.start();
					state.imLockStops = state.imLockStops || {};
					state.imLockStops[platform] = startImLockHeartbeat(platform);
					console.info(`[vssaros-agents][im] 已按上次状态恢复入站：${platform}`);
				} catch (e) {
					await releaseImLock(platform).catch(() => undefined);
					console.warn(`[vssaros-agents][im] 恢复入站失败（${platform}）：${String((e && e.message) || e).slice(0, 200)}`);
				}
			}
		})();
	}, 3000);

	// 会话投影（顶层再注册一份，与 preset 作用域那份共享同一个单元）——切换后 UI/诊断按 sessionId 读它。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		state.projections = child.sessionProjections;
		child.sessionProjections.register(personaProjection());
		// Bot 身份投影（带 wire ⇒ 页面 projectionValues["vssaros-bot"] 可读；判据见 core/botIdentity.js）
		child.sessionProjections.register(botIdentityProjection());
		// ★ 2026-11-05 群标记投影（projectionValues["vssaros-room"]：群会话 / 成员影子会话；见 core/rooms.js）
		child.sessionProjections.register(roomProjection());
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
		state.sessionController = withLazyPresetGuard(child.sessionController, () => {
			// 诊断用：apply 的 ctx 静态 inject 了 tools ⇒ 这里一定有；取不到就放弃探测
			try { return ctx.tools; } catch { return undefined; }
		});
		// 会话级模型选择要用官方内部入口 `agents.selectForNextRequest`（见 lib/modelSelection.js）
		state.rawSessionController = child.sessionController;
		return () => {
			state.sessionController = undefined;
			state.rawSessionController = undefined;
		};
	}));
	// 模型校验（与官方 selectModel 同口径：`llm.resolveCallConfig`）；到位后预热一次校验缓存
	ctx.inject(['llm'], child => child.effect(() => {
		state.llm = child.llm;
		void prevalidateRoutes({ sc: state.rawSessionController, llm: state.llm });
		return () => {
			state.llm = undefined;
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
	// ★ 2026-11-04 团队总线（superagent 主管组团 T0/T2）：只在顶层角色提供（委派、跟踪、建 bot 都在这里）；
	//   卸载时撤销，总线上的订阅表保留（见 lib/teamBus.js）。
	const teamService = createTeamService(config, state);
	ctx.effect(() => teamBus().provide({
		...teamService,
		createBot: async (input) => createTeamBot(config, input, async () => {
			if (state.presets) await syncPresets(state, state.presets, config);
		}),
	}));
	// ★ 2026-11-06 契约修订 2：describeBot(ref) = 名册卡片（含 model / preset / 工作区），按 id 或名字找（见 lib/teamBus.js）。
	ctx.effect(() => teamBus().provideDescribe(async (ref) => {
		const key = String(ref ?? '').trim().toLowerCase();
		if (!key) { return undefined; }
		return (await teamService.listBots()).find(bot => bot.id.toLowerCase() === key || bot.name.toLowerCase() === key);
	}));
	// ★ 2026-11-05 多 bot 群聊（用户要求恢复；设计移植 DeepSeek-Bot 的 room，见 lib/rooms.js 文件头）：
	//   群 = 一条专属会话 + 成员名单；群会话不调模型（llm/stream 合成 group_relay），成员在各自的影子会话里回答。
	//   与 2026-11-03 下线的旧群聊（groups.js / agent-groups.json）互不相干。
	ctx.inject(['workspaceRegistry'], child => child.effect(() => {
		state.workspaceRegistry = child.workspaceRegistry;
		return () => { state.workspaceRegistry = undefined; };
	}));
	/**
	 * ★ 2026-11-09：群变更的 SSE 广播。`/x/agents/api/rooms-events` 挂着浏览器订阅者，
	 *   rooms.create / reuseRoom 成功 ⇒ onChanged ⇒ 立刻推一帧，侧栏不必等 2s 轮询。
	 *   Set 只存 res（响应对象），断开时 req.on('close') 自己摘掉 ⇒ 不泄漏。
	 */
	const roomEventClients = new Set();
	const broadcastRoomChange = (kind, view) => {
		const frame = `event: rooms-changed\ndata: ${JSON.stringify({ kind, room: { id: view?.id ?? '', name: view?.name ?? '' } })}\n\n`;
		for (const res of [...roomEventClients]) {
			try { res.write(frame); } catch { roomEventClients.delete(res); }
		}
	};
	state.rooms = createRooms({
		file: join(dataRootOf(config), 'agent-rooms.json'),
		fallbackCwd: dataRootOf(config),
		roster: async () => (await scanAgentsFromConfig(config)).agents.filter(isShownAgent).map(a => ({ id: a.id, name: a.name ?? a.id })),
		presetOf: presetIdOf,
		sessions: () => state.sessionController,
		agents: () => state.agents,
		workspaces: () => state.workspaceRegistry,
		append: () => loadAppendPluginRecord(),
		onChanged: broadcastRoomChange,
	});
	ctx.effect(() => installRooms(ctx, state.rooms));
	ctx.effect(() => teamBus().provideGroups(state.rooms));
	// ★ 2026-11-04 记忆总线（superagent v2 P4）：团队步骤结束后的执行证据落到该 bot 的记忆 / 技能草稿区。
	//   ★ 2026-11-06：技能草稿由模型提炼（一次性 llm.stream，不开会话），相似去重出新版本，风险分级（lib/stepDistill.js）。
	const distill = makeStepDistiller({
		// llm 适配器注册在应用根；隔离作用域里的 ctx.llm 可能缺适配器（vssaros-memory 评审员踩过 NO_ADAPTER）
		llm: () => { try { return ctx.get?.('root')?.get?.('llm') ?? state.llm; } catch { return state.llm; } },
		route: distillRouteOf({ config, agents: () => state.agents, botRoute: (botId) => agentModelRouteOf(botId) }),
	});
	ctx.effect(() => memoryBus().provide({
		rememberStep: async (evidence) => rememberStep(config, evidence, { distill }),
		decideSkillDraft: async (name, decision) => decideSkillDraft(config, name, decision),
	}));

	/* Host 退出前把 IM 幂等表落盘（写盘是去抖的，不 flush 会丢最后几条 ⇒ 重启后重复处理） */
	ctx.effect(() => () => { void flushInboundSeen(config); });
	// Outbox 读回（2026-10-16 二期）：启动即把盘上"等回收"的条目读回内存——relay/群聊的 tracker
	// 按 messageId 从 outbox 取 pending ⇒ 重启后回收自动续上 ✓（读失败按空队列，不炸激活 ✓）。
	ctx.effect(() => {
		void ensureOutboxLoaded(config);
		return undefined;
	});

	// ★ 2026-11-02 启动计时探针（只记录）：apply 到 agentPresets 服务就绪之间等了多久。
	//   实测 kb apply（2.8s）→ 第一次 register（5.9s）之间有 ~3.1s 未归因；这一行判"是不是在等服务"。
	const agentsApplyAt = Math.round(process.uptime() * 1000);
	ctx.inject(['agentPresets'], child => child.effect(() => {
		console.log(`[vssaros-agents] 计时 agentPresets 就绪（进程启动后 ${Math.round(process.uptime() * 1000)}ms；apply 于 ${agentsApplyAt}ms）`);
		state.presets = child.agentPresets; // ← 回调内取服务对象（子 ctx 事后就 inactive 了）
		// 注册是异步的（`register` 返回 Promise<disposer>）：登记 in-flight，卸载时先等它落地再撤销，
		// 否则会出现"卸载后又注册回来"的泄漏。
		const inflight = (async () => {
			try {
				await syncSerial(state, state.presets, config);
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

	/**
	 * ★ 2026-10-26：对外暴露 `vssarosAgents` 服务，让**其它插件**能触发重扫。
	 *
	 * ## 为什么需要
	 * preset **只在本插件启动时扫一次** `<数据根>/agents/<id>/.agent.md`。
	 * 任何"装插件时才创建 agent 文件"的场景（例如商城插件自动落 `marketplace-bot`）
	 * 都赶不上那次扫描 ⇒ 用户必须**重启两次**才看得到新 agent ✗
	 * （实测时间线：Host 16:25:52 启动 → 文件 16:26:00 才被创建 ⇒ 扫不到）
	 *
	 * ## 为什么现在才补
	 * `vssaros-marketplace` 早就写了 `ctx.inject(['vssarosAgents'], s => state.agentsRescan = s.rescan)`
	 * 并做好了失败兜底 —— 但本插件一直**没 provide**，那段是死代码。
	 *
	 * ## 语义
	 * `rescan()` = 重扫目录 + **增量**注册（`syncPresets` 本来就是增量的：
	 * 新 agent 注册、消失的撤销、没变的跳过）⇒ **可重复调用、幂等** ✓
	 */
	ctx.provide('vssarosAgents', {
		/**
		 * 重扫 agent 目录并增量注册 preset。
		 * @returns {Promise<{ ok: boolean, agentsRoot: string, registered: number }>}
		 * @throws 服务还没就绪时抛（调用方按"重启兜底"处理，不静默）
		 */
		rescan: async () => {
			if (!state.presets) {
				throw new Error('agentPresets 服务还没就绪（Host 还在启动）');
			}
			await syncSerial(state, state.presets, config);
			return {
				ok: true,
				agentsRoot: agentsRootOf(config),
				registered: state.registered ? state.registered.size : 0,
			};
		},
		/** 本插件实际扫描的目录（调用方排查"文件放错地方"时很有用）。 */
		agentsRoot: () => agentsRootOf(config),
		/**
		 * ★ 2026-11-08 换架构：把「按 preset 查 agent 声明」这一个真源暴露给技能侧，
		 *   避免 `vssaros-skills` 自己再拼一遍双根路径（原来只读 `<dataRoot>/agents/`，
		 *   **21 个内置 agent 的 `skills[]`/`capabilities[]` 因此永远读不到**）。
		 *   返回 `{ agentId, capabilities, skills, declared }`；查不到 ⇒ declared:false。
		 */
		attachmentsOf: async (preset) => {
			const text = String(preset ?? '').trim();
			const agentId = text.startsWith('vssaros-') ? text.slice('vssaros-'.length).trim() : '';
			const empty = { agentId: '', capabilities: [], skills: [], declared: false };
			if (!agentId || agentId === 'agent') { return empty; }
			try {
				const scan = await scanAgentsFromConfig(config);
				const hit = scan.agents.find(a => String(a?.id ?? '') === agentId || String(a?.agent?.id ?? '') === agentId);
				if (!hit) { return { ...empty, agentId }; }
				const rec = hit.agent ?? hit;
				return {
					agentId,
					capabilities: Array.isArray(rec.capabilities) ? rec.capabilities : [],
					skills: Array.isArray(rec.skills) ? rec.skills : [],
					declared: (rec.capabilities?.length ?? 0) > 0 || (rec.skills?.length ?? 0) > 0,
				};
			} catch (error) {
				console.warn(`[vssaros-agents] attachmentsOf(${preset}) 失败：${String(error?.message ?? error)}`);
				return { ...empty, agentId };
			}
		},
		/** 诊断：内置根有没有注入（换架构后 21 个内置 agent 的声明全靠它）。 */
		agentsBuiltinRoot: () => agentsBuiltinRootOf(config) ?? '',
	});

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

			/* ══ 真聊天（2026-10-23）：把宿主的 `sessionController` 转发成三条路由 ══════════════
			   为什么要这三条：工作台中间栏要「真聊天」，而聊天需要的三件事 dsh 全有，只是插件拿不到 HTTP 面：
			     · 首屏 + 定稿帧 + assistant 流式帧 = `sessionController.follow()` 的三种帧
			       （`SessionFollowFrame = {type:'snapshot'} | SessionEventEntry | {type:'assistant-stream'}`，
			        见 dsh-api-session-controller/types.d.ts:539-550 —— 与 DSB 的 channel/message+channel/draft 同构）
			     · 发消息 = `sessionController.prompt()`（`SessionPromptRequest{requestId,sessionId,mode,content}`）
			     · 停止 = `sessionController.cancel()`
			   ⚠ 服务名是实测出来的：`ctx.sessionController`（该包 `super(ctx, "sessionController", …)`）。
			   ⚠ 宿主没装 / 没就绪 ⇒ **如实 501**，不静默（静默会让工作台显示"没有会话"，比报错更难查）。 */
			const sessionController = () => {
				try {
					const viaReflect = page.reflect && typeof page.reflect.get === 'function' ? page.reflect.get('sessionController') : undefined;
					return viaReflect || page.sessionController || null;
				} catch { return null; }
			};
			const sseHead = (res) => {
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					connection: 'keep-alive',
					'x-accel-buffering': 'no',
				});
			};

			// ① GET /api/live?session=<id> —— SSE：snapshot / event(定稿) / assistant-stream(流式)
			if (pathname === `${ROUTE_PREFIX}/api/live` && req.method === 'GET') {
				const sid = String(url.searchParams.get('session') || '');
				const ctl = sessionController();
				if (!ctl) {
					res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '宿主的 sessionController 服务不可用（Host 版本太旧或该插件被禁用）' }));
					return;
				}
				if (!sid) {
					res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '缺 session 参数' }));
					return;
				}
				sseHead(res);
				const ac = new AbortController();
				req.on('close', () => ac.abort());
				// 心跳：SSE 过代理/空闲会被掐断（15s 一次注释帧，浏览器不会当数据）
				const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 15_000);
				const send = (event, data) => {
					try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 已断开 */ }
				};
				try {
					for await (const frame of ctl.follow({ address: { kind: 'session', sessionId: sid }, assistantStream: true }, ac.signal)) {
						const kind = frame && typeof frame === 'object' && typeof frame.type === 'string' ? frame.type : 'frame';
						send(kind, frame);
					}
				} catch (e) {
					if (!ac.signal.aborted) { send('error', { message: String((e && e.message) || e) }); }
				} finally {
					clearInterval(beat);
					try { res.end(); } catch { /* 已断开 */ }
				}
				return;
			}

			// ①.5 POST /api/session { agentPreset?, cwd? } —— 开一个新会话（工作台「发起会话」用）
			if (pathname === `${ROUTE_PREFIX}/api/session` && req.method === 'POST') {
				const ctl = sessionController();
				if (!ctl) {
					res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '宿主的 sessionController 服务不可用' }));
					return;
				}
				const body = await readJsonBody(req).catch(() => ({}));
				try {
					// 只透传白名单字段（`sessionId` 不透传：新会话就让它自己生成，避免与已有会话撞名）
					// ★ 2026-11-02：`workspaceId` 与 `cwd` **互斥**（官方 `session.create` 两个都给会 400）。
					//   只给 `cwd` ⇒ 会话有目录但**不登记进工作区账本** ⇒ 官方 hero 判 `chipTitle === undefined`
					//   ⇒ 输入框被禁用（用户截图「bot 聊天框无法输入」）；给 `workspaceId` ⇒ 官方建完会
					//   `workspace.attachSession(sid)` ⇒ 登记 ✓。优先 workspaceId。
					const wantWs = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined;
					const out = await ctl.create({
						agentPreset: typeof body.agentPreset === 'string' && body.agentPreset ? body.agentPreset : undefined,
						...(wantWs
							? { workspaceId: wantWs }
							: { cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined }),
					});
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, sessionId: out && out.sessionId, agentPreset: out && out.agentPreset }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
				}
				return;
			}

			// ①.7 GET /api/page?session=<id>&throughSeq=<n>&maxMessages=<n> —— **历史首屏**
			//   ⚠ 为什么需要它：`follow()` 的 snapshot 只给"从当前游标往前一小段"，**不含完整历史**
			//     ⇒ 中间栏接上一个有历史的会话时会是空的（只有增量）。DSB 的对应做法是
			//     `loadOpeningTimeline`（RPC 拉首屏）+ SSE（推增量）两段 ⇒ 这里补齐第一段。
			//   ⚠ `throughSeq` 是必填（类型注释：inclusive log cut obtained from the follow opening frame）
			//     ⇒ 客户端拿到 snapshot 帧的 `cursor` 再回填到这里。
			if (pathname === `${ROUTE_PREFIX}/api/page` && req.method === 'GET') {
				const ctl = sessionController();
				if (!ctl) {
					res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '宿主的 sessionController 服务不可用' }));
					return;
				}
				const sid = String(url.searchParams.get('session') || '');
				// ⚠ 不能用 `Number(null)` —— 那是 0，会被当成合法 throughSeq（缺参不报错 ✗，p3-176 抓到过）
				const rawSeq = url.searchParams.get('throughSeq');
				const throughSeq = rawSeq === null || rawSeq.trim() === '' ? Number.NaN : Number(rawSeq);
				const maxMessages = Number(url.searchParams.get('maxMessages')) || 60;
				if (!sid || !Number.isFinite(throughSeq) || throughSeq < 0) {
					res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '缺 session 或 throughSeq（throughSeq 取自 follow 的 snapshot.cursor）' }));
					return;
				}
				try {
					const page = await ctl.page({ address: { kind: 'session', sessionId: sid }, throughSeq, maxMessages }, new AbortController().signal);
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, records: (page && page.records) || [], hasMore: !!(page && page.hasMore) }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
				}
				return;
			}

			// ② POST /api/prompt { sessionId, text, mode? } —— 真发一条消息
			if (pathname === `${ROUTE_PREFIX}/api/prompt` && req.method === 'POST') {
				const ctl = sessionController();
				if (!ctl) {
					res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '宿主的 sessionController 服务不可用' }));
					return;
				}
				const body = await readJsonBody(req).catch(() => ({}));
				const sid = String(body.sessionId || '');
				const text = String(body.text || '');
				if (!sid || !text.trim()) {
					res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '缺 sessionId 或 text' }));
					return;
				}
				const ac = new AbortController();
				req.on('close', () => ac.abort());
				try {
					const out = await ctl.prompt({
						// requestId 是**幂等键**（客户端铸一次，重试复用 ⇒ 不会发两条）
						requestId: String(body.requestId || ('wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))),
						sessionId: sid,
						mode: body.mode === 'steer' ? 'steer' : 'queue',
						content: [{ type: 'text', text }],
						clientTimeZone: typeof body.clientTimeZone === 'string' ? body.clientTimeZone : undefined,
					}, ac.signal);
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, value: out ?? null }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
				}
				return;
			}

			// ③ POST /api/cancel { sessionId } —— 停掉当前回合（不清待办队列）
			if (pathname === `${ROUTE_PREFIX}/api/cancel` && req.method === 'POST') {
				const ctl = sessionController();
				if (!ctl) {
					res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '宿主的 sessionController 服务不可用' }));
					return;
				}
				const body = await readJsonBody(req).catch(() => ({}));
				const sid = String(body.sessionId || '');
				if (!sid) {
					res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: '缺 sessionId' }));
					return;
				}
				try {
					const out = typeof ctl.cancel === 'function' ? ctl.cancel({ sessionId: sid }) : null;
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, value: out ?? null }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
				}
				return;
			}

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
			/* IM 绑定（2026-10-27，P0）：每个 bot / 群 ⇄ 一个 IM 会话。
			   GET  = 绑定表 + 适配器清单 + 模拟器发件记录（自测用）
			   POST = create / update / delete / **inbound**（模拟一条 IM 入站，无需真实平台）
			   ⚠ 只有人能增删改（`assertHuman`）；`inbound` 只在本机演练/探针里用。 */
			/* 会话重命名（2026-10-27，用户要求「会话条目右键 → 重命名」）。
			   ⚠ 转发给 **dsh 的 `sessionController.rename`**（真改名，会话窗口里也变）；
			     不做"插件本地别名"—— 别名只在本页生效，用户会以为改了没生效。
			   ⚠ 版本兼容：老 dsh 没这个服务 ⇒ 503 且说清原因，不静默失败。 */
			if (pathname === `${ROUTE_PREFIX}/api/session-rename`) {
				try {
					if (req.method !== 'POST') {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
						res.end('POST');
						return;
					}
					const body = await readJsonBody(req);
					const sessionId = String(body?.sessionId ?? '').trim();
					const title = String(body?.title ?? '').trim();
					if (!sessionId) { throw Object.assign(new Error('缺少 sessionId'), { httpStatus: 400 }); }
					if (!title) { throw Object.assign(new Error('标题不能为空'), { httpStatus: 400 }); }
					if (title.length > 200) { throw Object.assign(new Error('标题太长（最多 200 字）'), { httpStatus: 400 }); }
					const sc = state.sessionController;
					if (!sc || typeof sc.rename !== 'function') {
						throw Object.assign(new Error('当前 dsh 未提供 sessionController.rename（版本不支持）'), { httpStatus: 503 });
					}
					const r = await sc.rename({ sessionId, title });
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						ok: true,
						/* Host 会做 normalize（比如裁空白/限长）⇒ 回它认可的那个值，前端据此提示 */
						title: (r && typeof r.title === 'string') ? r.title : title,
						seq: (r && Number.isFinite(r.seq)) ? r.seq : undefined,
					}));
				} catch (e) {
					const status = Number.isInteger(e?.httpStatus) ? e.httpStatus : 400;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}

			if (pathname === `${ROUTE_PREFIX}/api/bindings`) {
				try {
					const deps = {
						scanAgents: (cfg) => scanAgentsFromConfig(cfg),
						/* 平台是否已配好应用凭据（`bindings.assertTransport` 用）：飞书没填 webhook 时
						   改为要求「设置 → 渠道」里已有 App ID/Secret（应用模式），否则 400 —— 
						   这样既不会拦掉"填个 chat_id 就能用"的正路，也不会让人建出一条永远发不出去的绑定。 */
						appConfigured: async (platform, appId) => platform === 'feishu' && appId
							? (await resolveFeishuApp(config, appId)).configured
							: (await resolvePlatform(config, platform)).configured,
						/* 2026-11-04：等于默认应用的 appId 存成空（"空 = 默认"） */
						defaultFeishuAppId: async () => (await resolveFeishu(config)).appId,
					};
					if (req.method === 'GET') {
						const out = await listBindings(config, deps);
						const loop = state.loopbackAdapter;
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({
							...out,
							adapters: state.bindingHub?.adapters?.() ?? [],
							/* 演练档：模拟器"发出去的东西"也返回，方便自测整条链路（没注册就没有这段） */
							...(loop ? { loopbackSent: loop.sent.slice(-20) } : {}),
							/* 入站（P2）：状态 + 是否配了凭据。UI 据此显示「未配置 / 未安装 SDK / 已连接」。 */
							inbound: state.feishuInbound ? state.feishuInbound.state() : null,
							/* 各平台入站状态（飞书 WS / Telegram 长轮询 / Discord Gateway）—— 配置页按平台分别显示。
							   ⚠ 这里**漏一个平台**的后果是：那个平台在配置页永远显示"未启动"、按钮点了也没反馈
							   （discord 2026-10-28 就漏过一次）。企业微信是被动回调 ⇒ 没有网关、也没有"启动"这一步。 */
							inbounds: {
								feishu: state.feishuInbound ? state.feishuInbound.state() : null,
								telegram: state.telegramInbound ? state.telegramInbound.state() : null,
								discord: state.discordInbound ? state.discordInbound.state() : null,
								/* 2026-11-04：额外飞书应用各自的长连接状态 `{ [appId]: state }`（默认应用仍是上面的 feishu） */
								feishuApps: state.feishuApps ? state.feishuApps.appStates() : {},
							},
							feishu: await describeFeishu(config),
							/* 2026-11-04：全部飞书应用（默认在前），绑定按 appId 选；secret 只以 hasSecret 出现 */
							feishuApps: await describeFeishuApps(config),
							/* ★ 2026-11-09：每个 Bot 选用的飞书应用（botId → appId；空 = 默认应用）。
							   Bot 设置页的「飞书配置」下拉消费这份映射，secret 不在这里。 */
							botFeishuApps: await readBotFeishuApps(config),
							/* 多渠道（2026-10-27）：每平台的掩码状态 + 字段定义。
							   ⚠ secret 只以 `hasSecret` 出现，明文永不出这个进程。 */
							channels: await describePlatforms(config),
							channelDefs: IM_PLATFORM_DEFS,
							/* 待批准的配对请求 + 已批准名单（设置页「渠道」里直接批） */
							pairings: await listPairings(config),
							/* 最近被拒/失败的消息（新的在前；含 reason 与发送者，直接显示） */
							deadLetters: await listDeadLetters(config, { limit: 20 }),
							/* 最近出现过的 IM 会话 id（帮用户拿到 Telegram chat_id 之类） */
							recentChats: state.bindingHub && typeof state.bindingHub.recentChats === 'function'
								? state.bindingHub.recentChats() : [],
						}));
					} else if (req.method === 'POST') {
						const body = await readJsonBody(req);
						/* ★ 2026-10-27 多渠道入站：按 `body.platform` 选网关（缺省 feishu，向后兼容）。
						   飞书是 WS 长连接、Telegram 是 HTTP 长轮询 —— 上层只认 `state()/start()/stop()` 这组接口。 */
						const inboundOf = (b) => {
							const p = String((b && b.platform) || 'feishu').trim().toLowerCase();
							/* 用映射而不是三元链：每加一个渠道都要改这里一次，但三元链改到第四个就无法阅读了 */
							const map = {
								feishu: state.feishuInbound,
								telegram: state.telegramInbound,
								discord: state.discordInbound,
							};
						if (p === 'wecom') {
							throw Object.assign(new Error(
								'企业微信是**被动回调**（企业微信服务器来连我们），没有「启动入站」这一步；'
								+ '填好回调 Token / EncodingAESKey，并把公网地址反代到 /x/agents/api/wecom/callback 后自动收消息。',
							), { httpStatus: 400 });
						}
							const gw = map[p];
							if (!gw) {
								throw Object.assign(
									new Error(`平台 ${p} 的入站网关不可用（适配器未装配：当前支持 ${Object.keys(map).join(' / ')}）`),
									{ httpStatus: 400 },
								);
							}
							return gw;
						};
						const action = typeof body?.action === 'string' && body.action.trim() ? body.action.trim() : 'create';
						const result = action === 'create' ? await createBinding(config, body, deps)
							: action === 'update' ? await updateBinding(config, body, deps)
								: action === 'delete' ? await deleteBinding(config, body)
									/* 写飞书应用凭据（2026-10-27）：真源在 dsh 侧。`appSecret` 缺省 = 保留原值。 */
									/* 写凭据（多平台，2026-10-27）：`platform` 缺省 = feishu（向后兼容）。
									   平台与字段由 `IM_PLATFORM_DEFS` 定义 ⇒ 新增平台只改那一个文件。 */
									/* 配对批准（2026-10-27）：只加 DM 白名单；撤销同理。 */
									: action === 'pairing-approve' ? await approvePairing(config, body)
										: action === 'pairing-revoke' ? await revokePairing(config, body)
										: action === 'dead-letters-clear' ? await clearDeadLetters(config)
										/* ★ 2026-10-29：把死信里的发送者**一键加进该绑定的白名单**。
										   "我发了消息 bot 没反应"最常见的答案就是"白名单没加我"；
										   让用户抄 open_id 再回绑定页粘贴，链路太长。 */
										: action === 'dead-letter-allow' ? await allowDeadLetterSender(config, body)
									: action === 'credentials' ? await savePlatform(
										config,
										(body && body.platform) || 'feishu',
										{ ...(body || {}), actor: body?.actor },
									)
									: action === 'inbound' ? await state.bindingHub.handleInbound(body.message ?? body)
										/* 入站长连接启停（P2）：没装 SDK / 没凭据时会抛 unavailable，错误原样返回。
										   ★ 2026-10-29：**记住用户点过启动**（start 成功后才写），
										     重启 Host 时据此恢复 —— 否则"点了启动、重启后又静默回到未启动"，
										     用户只会看到"消息没反应"（见 imInboundState.js 头注释）。 */
									: action === 'inbound-start' ? await (async () => {
										const platform = String((body && body.platform) || 'feishu').trim().toLowerCase();
										/* ★ 2026-11-04：飞书按**应用**启动并加锁（以前手动启动不加锁 ⇒ 两个客户端都点了就会抢事件） */
										if (platform === 'feishu' && state.feishuApps) {
											const key = await state.feishuApps.keyOf(body && body.appId);
											const st = await state.feishuApps.start(key);
											await (key ? setFeishuAppEnabled(config, key, true) : setInboundEnabled(config, 'feishu', true)).catch(() => undefined);
											return st;
										}
										const gw = inboundOf(body);
										await gw.start();
										await setInboundEnabled(config, platform, true).catch(() => undefined);
										return gw.state();
									})()
									: action === 'inbound-stop' ? await (async () => {
										const platform = String((body && body.platform) || 'feishu').trim().toLowerCase();
										if (platform === 'feishu' && state.feishuApps) {
											const key = await state.feishuApps.keyOf(body && body.appId);
											const st = await state.feishuApps.stop(key);
											await (key ? setFeishuAppEnabled(config, key, false) : setInboundEnabled(config, 'feishu', false)).catch(() => undefined);
											return st;
										}
										const gw = inboundOf(body);
										await gw.stop();
										await setInboundEnabled(config, platform, false).catch(() => undefined);
										return gw.state();
									})()
									/* ★ 2026-11-04：增改/删除一个**额外**飞书应用（`{ appId, appSecret?, name?, remove? }`）。
									   删除时先停掉它的长连接并放锁，再清掉「上次已启动」记录。 */
									: action === 'feishu-app' ? await (async () => {
										if (body && body.remove === true && state.feishuApps) {
											await state.feishuApps.forget(body.appId);
											await setFeishuAppEnabled(config, body.appId, false).catch(() => undefined);
										}
										return { feishuApps: await saveFeishuApp(config, { ...(body || {}), actor: body?.actor }) };
									})()
									/* 测试发送（2026-10-27）：用**真实适配器**给这条绑定发一条消息 ——
									   "配完了到底通不通"不必再等真跑一次对话；失败原因原样返回。 */
									/* ★ 2026-11-09：设置某个 Bot 用哪个飞书应用（botId → appId，空 = 默认）。
									   应用凭据本身仍由 credentials / feishu-app 管，这里只写映射。 */
									: action === 'set-bot-app' ? await (async () => ({
										botFeishuApps: await saveBotFeishuApp(config, { ...(body || {}), actor: body?.actor }),
									}))()
									: action === 'test' ? await state.bindingHub.testBinding(body?.id)
										: (() => { throw Object.assign(new Error(`未知 action：${action}（支持 create/update/delete/inbound/inbound-start/inbound-stop/credentials/feishu-app/set-bot-app/test）`), { httpStatus: 400 }); })();
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
			// ★ 2026-11-05 多 bot 群聊（lib/rooms.js）：
			//   GET  /api/rooms                         → { rooms: RoomView[] }（侧栏 Bots 页签）
			//   GET  /api/rooms?id=<群 id>               → { room }
			//   GET  /api/rooms?progress=<callId>        → { progress }（群聊工具卡跑的过程中轮询）
			//   POST { action:'create', members, name?, notice?, admin?, mode?, workspaceId?, cwd? }
			//   POST { action:'update', id, name?, notice?, admin?, mode?, members? }
			//   POST { action:'flags', id, pinned?, hidden? } / { action:'delete', id }
			// ★ 2026-11-09：群变更 SSE（建群成功即时通知侧栏）。浏览器用 fetch 订阅，
			//   断线自行重连；旧版 Host 没这个端点 ⇒ 404，客户端静默回落 2s 轮询。
			if (pathname === `${ROUTE_PREFIX}/api/rooms-events` && req.method === 'GET') {
				sseHead(res);
				res.write(`event: ready\ndata: {}\n\n`);
				roomEventClients.add(res);
				const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 15_000);
				req.on('close', () => { clearInterval(beat); roomEventClients.delete(res); try { res.end(); } catch { /* 已断开 */ } });
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/api/rooms`) {
				const body = req.method === 'POST' ? await readJsonBody(req).catch(() => ({})) : undefined;
				const out = await roomsApi(state.rooms, { method: req.method, query: url.searchParams, body });
				res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(out.body));
				return;
			}
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
			// 记忆 API（2026-10-16，二期）：GET ?agent= 文件+Git 状态（&file= 读内容）/ POST enable-git·snapshot。
			// 写口只有「启用 Git」与「提交快照」两个（git 子进程）；模型没有记忆 CRUD 工具 ✗（拍板点 ③⑤）。
			/* AgentMemory 候选（2026-10-27，记忆页签的只读块）——
			   独立端点而不是塞进 /api/memory：网关可能离线（5s 超时），不能让主接口跟着慢。
			   返回 `state` 三态（online / offline / unconfigured），**不抛** —— 它是可选增强。 */
			/* 企业微信回调（2026-10-27）：GET = URL 验证，POST = 消息推送。
			   ⚠ 入站是**别人来连我们** ⇒ 没有"启动/停止"这一步；要公网反代到这条路由。
			   ⚠ GET 验证必须回**纯文本**（明文 echostr），不能包 JSON —— 企业微信会逐字比对。 */
			if (pathname === `${ROUTE_PREFIX}/api/wecom/callback`) {
				try {
					const q = {};
					for (const [k, v] of url.searchParams.entries()) { q[k] = v; }
					const rawBody = req.method === 'POST' ? await readRawBody(req, 256 * 1024) : '';
					const wc = await resolvePlatform(config, 'wecom');
					const out = await handleWecomCallback({
						token: String(wc.callbackToken ?? ''),
						encodingAesKey: String(wc.encodingAesKey ?? ''),
						corpId: String(wc.corpId ?? ''),
						onMessage: (msg) => state.bindingHub.handleInbound(msg),
						log: (m) => { try { console.info('[vssaros-agents][im-in] wecom：' + m); } catch { /* 忽略 */ } },
					}, { method: req.method, query: q, body: rawBody });
					res.writeHead(out.status, {
						'content-type': out.plain ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
						'cache-control': 'no-store',
					});
					res.end(out.plain ? String(out.body) : JSON.stringify({ ok: out.status === 200, ...out }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
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
			// POST { action: 'validate', draft } ⇒ 只校验，返回 errors / warnings / 序列化原文
			//   （2026-11-09 起由聊天框侧栏「新建 Bot」表单在提交前调用；旧 SSR 向导已下线，别再找 createPage.js）；
			// POST { action: 'create', draft } ⇒ 写盘 + 立刻增量同步 preset（不用重启 Host），
			//   回 registered + syncError ⇒ 客户端必须据此给反馈，不许无条件提示「已新建」。GET 仍走下面的花名册。
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
						let syncError = '';
						if (state.presets) {
							await syncPresets(state, state.presets, config).catch(e => {
								syncError = `同步 preset 失败：${String(e?.message ?? e)}`;
								state.errors = [...state.errors, syncError];
							});
						}
						// ★ 2026-11-09：同步失败不再只塞进 state.errors（前端只读 HTTP 200 会提示「已新建」，
						//   而列表按 registered 把未注册 bot 隐藏 ⇒ 用户看到成功却找不到）。现在把原因一并回给调用方。
						result = {
							...created,
							registered: state.roster.includes(created.presetId),
							...(syncError ? { syncError } : {}),
						};
					} else if (action === 'update') {
						/* 改已有 Agent 的元数据（2026-10-25，给 dsh 侧设置页用）。
						   与 create 同一条序列化/校验链，改完立刻重注册 preset（人设变化要马上生效）。 */
						const updated = await updateAgentFromDraft(config, body?.id, body?.draft);
						let updateSyncError = '';
						if (state.presets) {
							await syncPresets(state, state.presets, config).catch(e => {
								updateSyncError = `同步 preset 失败：${String(e?.message ?? e)}`;
								state.errors = [...state.errors, updateSyncError];
							});
						}
						result = {
							...updated,
							registered: state.roster.includes(updated.presetId),
							...(updateSyncError ? { syncError: updateSyncError } : {}),
						};
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
						/* ★ 2026-10-31：`&history=1` ⇒ 把记忆仓库的 Git 历史（bundle）一起打包。
						   默认不带 —— 历史里还留着删掉过的内容，属于比当前记忆更敏感的数据。 */
						const pack = await exportAgent(config, id, {
							includeMemory: url.searchParams.get('memory') !== '0',
							includeHistory: url.searchParams.get('history') === '1',
						});
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
						const saved = await saveExport(config, body?.id, {
						includeMemory: body?.memory !== false,
						includeHistory: body?.history === true,
					});
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
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ counts }));
				} catch (e) {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
				return;
			}
			/* 读**单个** Agent 的完整草稿：`GET /api/agents?id=<id>`
			   （2026-10-25，给设置页的 System Prompt 页签回填 —— `/api/home` 只有 personaBytes 字数）。
			   ⚠ 必须放在下面"全量列表"分支**之前**，否则 `?id=` 会被那个分支吞掉。 */
			if (pathname === `${ROUTE_PREFIX}/api/agents` && req.method === 'GET' && url.searchParams.get('id')) {
				try {
					const one = await readAgentDraft(config, url.searchParams.get('id'));
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, ...one }));
				} catch (e) {
					const status = Number(e?.httpStatus) || 500;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
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
							// 聊天框欢迎卡（方案 A 第 3 步，chat-surface 的 client.welcome.js）要的字段：
							// 角色标签、技能、头像底色（底色只有服务端会算 ⇒ 直接给，前端不再抄一份公式 ✓）
							role: a.role ?? null,
							skills: a.skills ?? [],
							// ★ 2026-11-04 主管组团：created-by: supervisor 的 bot 留在名册里、标「主管创建」。
							createdBy: a.createdBy === 'supervisor' ? 'supervisor' : null,
							/*
							 * ★ 2026-10-27（真机：所有内置 agent 的欢迎卡都是同一套通用按钮）：
							 *   `core/agents.js` 早就把 `.agent.md` 的 `suggestions:` 解析进 agent 对象了，
							 *   但**这份行映射漏了它** ⇒ 前端 `cardModel()` 拿到 undefined
							 *   ⇒ `suggestionsOf()` 一路兜到最底层的通用三条，于是每个 agent 长得一模一样。
							 *   空数组也要给：让前端的三级兜底（自带 → preset 表 → 通用）正常生效。
							 */
							suggestions: a.suggestions ?? [],
							color: avatarColorOf(a.id),
							model: a.model,
							tools: a.tools,
							personaBytes: Buffer.byteLength(a.persona, 'utf8'),
							presetId: presetIdOf(a.id),
							registered: state.roster.includes(presetIdOf(a.id)),
							live: liveOf.get(a.id) ?? null,
						// ★ 2026-11-04：外部 bot（SuperAgent 主管）只登记在名册里，不写 .agent.md、不注册 preset。
						})).concat(externalBots().map(externalBotRow)),
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
				// ★ 2026-11-03：Bots 工作台整体下线（用户要求）⇒ 不再有承载页 / SSR 页；
				// 本路由只剩 `/api/*`（名册 / home / 会话 / 记忆 / 渠道 …）。页面入口一律在聊天框侧栏「Bots」页签。
				// 实况 + 用量（P1/P5）：projcache 读不到就降级为"没有这两块"（页面主体不受影响 ✓）
				const live = await readLiveSessions(config).catch(() => null);
				const liveRows = live ? liveForAgents(scan.agents, aggregateByPreset(live.rows)).rows : [];
				/** agentId → 实况行（名册 JSON 每行带自己的实况 ✓；与 `/api/agents` 那条的 `liveOf` 同口径）。 */
				const liveRowsByAgent = new Map(liveRows.map(row => [row.agentId, row]));
				const usage = live ? usageByAgent(scan.agents, live.rows) : null;
				// 双表面分派（2026-10-16，方案 D；与 kanban 同惯例）：宿主在**侧栏**承载时带
				// `?surface=sideview` ⇒ 名册摘要版（lib/sideview.js）；其余（编辑区完整页、探针的默认
				// 请求）⇒ 完整页（lib/detail.js）。两个表面吃同一份数据（上面这一份 input）⇒ 不会漂 ✓。
				// ★ 2026-10-22（工作台重构 §5 步骤 2）：这几份数据**只取一次** ⇒ SSR 页与 React 工作台共用 ✓
				//   （各取一遍 ⇒ 迟早出现"页面说有 3 条委派、工作台说 2 条"这种分叉 ✗）
				const assignmentsData = await listAssignments(config);
				const templatesData = await listApprovalTemplates(config).catch(() => ({ tools: [], templates: [] }));
				const outboxData = await outboxList(config).catch(() => ({ entries: [], keep: 0 }));
				const unreadData = live ? await unreadSnapshot(config, scan.agents, live.rows) : {};
				// 新建向导（2026-10-16，方案 A）：模型候选 = 真实会话里跑过的 provider/model ✓；
				// 没配 defaultProvider 时裸模型名不可路由（口径 = toPresetDefinition）
				const createData = {
					modelCandidates: modelCandidatesOf(live?.rows, scan.agents),
					hasDefaultProvider: typeof config.defaultProvider === 'string' && config.defaultProvider.trim() !== '',
				};
				// ★ 2026-10-22（工作台重构 §5 步骤 2）：**名册面的 JSON 接口**（React 工作台用）。
				//   载荷 = 名册行 + 每个 agent 的「会话 / 需要处理 / 运行中 / 收件箱」（现成的 `buildHomeData` ✓）
				//   + 摘要 + 实况 + 未读。**其余页签（用量 / 委派 / 授权 / 群聊 / 记忆 / 演化）仍在 SSR 页** ✓
				//   —— 这一刀只迁名册面（用户口径同知识库：先迁主面，其余给明确入口）。
				if (url.pathname === `${ROUTE_PREFIX}/api/home`) {
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						ok: true,
						root,
						summary: shownSummary,
						roster: state.roster,
						// ★ 2026-11-03：lazy 补齐还没结束（preset 正在陆续注册）⇒ 前端据此自动重拉，
						//   否则 Bots 页签会一直显示启动早期那份"大量未注册"的快照。
						presetsPending: !!state.lazyFill && state.lazyFillDone !== true,
						diagnostics: state.diagnostics,
						errors: [...scan.errors, ...state.errors],
						missing: scan.missing ?? '',
						agents: shownAgents.map(a => ({
							id: a.id,
							name: a.name,
							description: a.description ?? '',
							icon: a.icon ?? '',
							role: a.role ?? null,
							skills: a.skills ?? [],
							createdBy: a.createdBy === 'supervisor' ? 'supervisor' : null,
							// 与 GET /api/agents 同口径：欢迎卡要读它（漏了就会退回通用三条）
							suggestions: a.suggestions ?? [],
							color: avatarColorOf(a.id),
							model: a.model ?? '',
							presetId: presetIdOf(a.id),
							registered: state.roster.includes(presetIdOf(a.id)),
							toolCount: Array.isArray(a.tools) ? a.tools.length : 0,
							personaBytes: Buffer.byteLength(a.persona ?? '', 'utf8'),
							live: liveRowsByAgent.get(a.id) ?? null,
						})),
						live: live ? { dir: live.dir, sessions: live.rows.length, truncated: live.truncated === true, errors: live.errors, ...(live.missing ? { missing: live.missing } : {}) } : null,
						usage,
						unread: unreadData,
						home: buildHomeData({ agents: shownAgents, sessionRows: live?.rows ?? [], assignments: assignmentsData }),
						/* 2026-10-26 用户要求「模型改成下拉框」：
						   候选来源与 `GET /api/agents` 同一份（`modelCandidatesOf` 只收**合法**的
						   `provider/model` 引用 ⇒ `claude-sonnet-4-20250514` 这种裸名进不来 ✓）。
						   放在 home 里是省一次请求：设置页本来就要读 home。 */
						modelCandidates: modelCandidatesOf(live?.rows, scan.agents),
						hasDefaultProvider: typeof config.defaultProvider === 'string' && config.defaultProvider.trim() !== '',
					}));
					return;
				}
				// ★ 2026-11-03：Bots 工作台（SSR 双表面）已下线 ⇒ /x/agents/ 下除 /api/* 与记忆演化页之外，
				// 不再有 HTML 页面。bots 只在聊天框侧栏「Bots」页签里用。
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('Not Found');
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
		state.sessionController = withLazyPresetGuard(child.sessionController, () => {
			// 诊断用：apply 的 ctx 静态 inject 了 tools ⇒ 这里一定有；取不到就放弃探测
			try { return ctx.tools; } catch { return undefined; }
		});
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
		// ★ 2026-10-29（首启慢的大头）：`child.tools.schemas()` 会对每个可见工具做一次 parameters 的
		//   JSON 深拷贝（197 个工具）⇒ 30 个 preset × 每轮 `tools/change` ⇒ 十几秒白烧。
		//   这里改成"只要名字"（内部 `view()` 零深拷贝）+ **按实例隔离、按事件版本失效**的快照。
		const nameSnapshot = createToolNameSnapshot();
		const schedule = () => {
			if (timer) { return; }
			timer = setTimeout(() => { timer = undefined; sync(); }, TOOL_SURFACE_DEBOUNCE_MS);
			timer.unref?.();
		};
		const syncOnce = () => {
			// 工具注册/撤销会让可见集变化 ⇒ 快照必须失效（否则新工具漏藏，且没有下一次事件来补 ✗）。
			const names = nameSnapshot.namesOf(child.tools);
			if (!names) {
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
				// ★ 2026-10-29 加计时：这一行是"preset 级工具面"的变化点。MCP 客户端连上时工具会成簇多出
			//   （实测 61 → 100，+39）⇒ 本行的时刻 ≈ MCP 服务器 spawn + 握手完成的时刻 ⇒ 记相对 Host 启动的耗时。
			const hostStartedAt = Date.now() - Math.round(process.uptime() * 1000);
			console.warn(`[vssaros-agents] 工具面收敛：本 preset 隐藏 ${next.size} 个工具（+${next.size - grewFrom}；${patterns.join(', ')}）｜host 启动后 ${Date.now() - hostStartedAt}ms`);
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
			// 工具注册/撤销 ⇒ 可见集变了 ⇒ 快照作废（否则新工具会漏藏，且没有下一次事件来补 ✗）。
			off = child.on?.('tools/change', () => { nameSnapshot.invalidate(); schedule(); });
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
	// ★★ 2026-10-29（首启慢定位）：**每个 preset 一行 ⇒ 这里被调 N 次**（实测 N≈30）。
	//   对照实验（只切换"是否注入 21 个内置 agent 根"）：注入 ⇒ `ready in 22919 ms`，
	//   不注入 ⇒ `ready in 11784 ms` ⇒ **21 个 preset 多花 13.4s ⇒ 每个 ≈0.6s**。
	//   这里打一行计时，把"**apply 本身**"与"dsh 侧实例化 preset"分开：
	//   若 apply 很快 ⇒ 瓶颈在 dsh 侧（我们只能少注册 / 延后注册）；否则是我们自己的代码 ✗。
	// 绑定 work item 内核（2026-10-31）：群聊的派发/记账与 `vssaros-loop` 共用同一份判据
	// （去重 / 退避 / 完成契约 / #task / 风暴预算 / 回环闸门），真源在 `@vssaros/dsh-workitem`。
	// 与 foundation 同款两条路：同步直读 + 可选注入；**没绑上不降级**（调用时抛带指引的错 ——
	// 静默回退本地实现正是"两份判定"复活的入口）。
	// ⚠ 放在 persona / toolsOnly 分支**之前**：记账是群聊运行期的共用能力，与角色无关。
	{
		let ready = null;
		try {
			ready = ctx.get?.('vssarosWorkItems') ?? ctx.vssarosWorkItems ?? null;
		} catch {
			// 探针的假 ctx 对未知属性抛错 ⇒ 当不存在
		}
		if (ready) {
			bindWorkItems(ready);
		}
		ctx.inject(['vssarosWorkItems'], child => {
			let svc = null;
			try {
				svc = child.vssarosWorkItems ?? null;
			} catch {
				// 同上
			}
			if (svc) {
				bindWorkItems(svc);
			}
		});
	}
	const __applyT0 = Date.now();
	const __who = config?.presetId || config?.agentId || '(top)';
	try {
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
	} finally {
		console.warn(`[vssaros-agents] preset apply 用时 ${Date.now() - __applyT0}ms（${__who}${config?.toolsOnly ? ' / toolsOnly' : ''}${typeof config?.persona === 'string' ? ' / persona' : ''}）`);
	}
}

