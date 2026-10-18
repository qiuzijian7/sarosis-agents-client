// @vssaros/dsh-agents — 生命周期工具（ds-bot TEAM_TOOLS 的对等面，但只覆盖"运行时面"）。
//
// **定义面不在此处**：agent 是什么（名字/人设/模型/工具）仍由人写的 `.agent.md` 决定——
// 刻意**没有** `create_agent`（人设正文是持久化提示词，模型可写 = 持久注入面；要开就走
// 草稿区 + 审批 + 显式提升，与 skill 写工具同一判据，见 doc/dsh-shell-contract.html §8 ⑤）。
//
// 四个工具、两种闸位（判据 = "会不会改变运行中会话的行为/状态"，不是"名字像不像写"）：
//   agent_list            只读：名册 + 实况（projcache 聚合：会话数/token/最近活跃）；verbose 列出会话 id
//   agent_open_session    不过闸：建一条**空会话**（cwd + agentPreset）——等于"开新聊天"，不改用户数据
//   agent_switch_persona  过闸：切换**本会话**的人格（复用人格热切换：注入 durable inbox，下一回合生效）
//   agent_stop            过闸：停掉**另一个**会话正在跑的回合（agent.cancel；ds-bot stop_bot 同构）
//   agent_message         不过闸：给另一个 agent 的会话发消息（now=steer 插队 / queue=followup 排队；
//                         ds-bot message_bot 同构）。回复由 lib/relay.js 自动回传（P3.2 ✓）。
//                         hop 预算防无限接力（软约束 + 硬上限）。
//   agent_read_chat       只读：读/搜**本会话**的完整历史（P4——压缩只动模型表面、不动日志 ✓，
//                         所以被压缩掉的早期内容能找回来；ds-bot read_own_chat 同构，真源换成
//                         dsh 原生 `ctx.sessionQuery.filterEvents`，不自建索引 ✓）。
//
// 挂载角色（与 index.js 的三角色对应）：顶层角色注册（带 hostHalf 闸）+ toolsOnly 角色注册（preset 内）。
// persona 角色（每个 agent preset 里的那次挂载）**不注册**——v1 有意收紧：agent 自己的会话不给管理工具。

import { randomUUID } from 'node:crypto';
import { presetIdOf } from './core/agents.js';
import { checkCwdGrant } from './grants.js';
import { aggregateByPreset, liveForAgents } from './core/live.js';
import { personaSwitchMessage } from './core/persona.js';
import { AGENT_MESSAGE_KIND } from './core/relay.js';
import { readLiveSession, readLiveSessions } from './live.js';
import { notePendingReply } from './relay.js';
import { agentsRootOf, scanAgents } from './store.js';

/** 过闸工具（`tools/pre-execute` ⇒ ask）。名单由 `dshPluginPackages.test.ts` 逐名核对。 */
export const WRITE_TOOLS = ['agent_switch_persona', 'agent_stop'];

/** 全部工具名（探针/快照对账用；顺序 = 注册顺序）。 */
export const TOOL_NAMES = ['agent_list', 'agent_open_session', 'agent_switch_persona', 'agent_stop', 'agent_message', 'agent_read_chat'];

/** 消息接力跳数上限（ds-bot MAX_HOPS=6 同构）：模型传 hop 超过它就拒发——防 A→B→A 无限接力。 */
export const MAX_HOPS = 6;

/**
 * 按 id 或名字找 agent：id 精确 → 名字精确 → 名字忽略大小写。
 * 找不到/有歧义都返回 error 文案（列出可用的），**绝不猜**（猜错等于把别人的人格/会话当目标）。
 * （2026-10-16 导出：assignments 模块的委派创建用同一份查找逻辑，不另写 ✓）
 */
export function findAgent(agents, ref) {
	const wanted = String(ref ?? '').trim();
	if (!wanted) {
		return { error: '要给 agent 参数（id 或名字）。' };
	}
	const byId = agents.find(a => a.id === wanted);
	if (byId) {
		return { agent: byId };
	}
	const byName = agents.filter(a => a.name === wanted);
	const pool = byName.length ? byName : agents.filter(a => a.name.toLowerCase() === wanted.toLowerCase());
	if (pool.length === 1) {
		return { agent: pool[0] };
	}
	if (pool.length > 1) {
		return { error: `名字叫 ${wanted} 的 agent 有 ${pool.length} 个，改用 id：${pool.map(a => a.id).join(', ')}` };
	}
	return { error: `没有这个 agent：${wanted}。现有：${agents.map(a => `${a.name}(${a.id})`).join(', ') || '(空)'}` };
}

/** 审批理由：批准即所见（完整参数摆进去），随 `approval/asked` 进会话日志 = 顺带拿到审计。 */
function gateReason(name, args) {
	if (name === 'agent_stop') {
		const session = String(args.session ?? '').trim() || '(没给 session)';
		const why = String(args.reason ?? '').trim();
		return `agent_stop 停止会话 ${session} 的当前回合${why ? `（原因：${why}）` : ''}；排队中的消息会随回合一起丢弃`;
	}
	if (args.clear === true) {
		return 'agent_switch_persona 恢复本会话的 preset 自带人设（下一回合生效）';
	}
	return `agent_switch_persona 把本会话人格切换为 ${String(args.agent ?? '').trim() || '(没给 agent)'}（下一回合生效；工具与模型不变）`;
}

// ⚠ dsh 强制每个工具声明 `output { schema, render, … }`（`dsh-tools/lib/index.js` 的 register 校验，
// 缺 render ⇒ apply 直接抛 TypeError、整个插件不激活 ✗——p3-55 真机抓住的；进程内探针的 fake
// register 不校验 ⇒ 全绿照样爆 ✗ ⇒ p3-54 的 fake 已补同等校验 ✓）。render 形态照 ds-bot/dashboard。
const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

/**
 * 注册四个生命周期工具 + 审批闸。返回 dispose（撤销工具 + 摘闸）。
 * @param ctx 注入出的子上下文（要有 `tools`）
 * @param config 本行 config（数据根/agentsRoot 从这里解析）
 * @param state 运行时服务槽位 `{ agents?, sessionController? }`（由各自的 inject 填充；缺服务时工具如实报错）
 */
export function registerAgentTools(ctx, config, state) {
	const agentsSvc = () => state.agents;

	const defs = [
		{
			name: 'agent_list',
			description: '列出全部 agent（`.agent.md` 定义）及其运行情况：每个 agent 的 preset 注册状态、模型、会话数、token 累计与最近活跃时间（来自 dsh 会话投影缓存，只读）。verbose=true 时另外列出每个 agent 最近的会话 id（agent_stop 的 session 参数从这里取）。',
			parameters: {
				type: 'object',
				properties: {
					verbose: { type: 'boolean', description: 'true 时每个 agent 附带最近 5 条会话的 id 与标题（默认 false）' },
				},
			},
			output: textOutput,
			isConcurrencySafe: true,
			async execute(args) {
				const scan = await scanAgents(agentsRootOf(config));
				const live = await readLiveSessions(config).catch(() => null);
				const byPreset = aggregateByPreset(live?.rows ?? []);
				const { rows, unmatched } = liveForAgents(scan.agents, byPreset);
				const verbose = args?.verbose === true;
				const sessionsBy = new Map();
				if (verbose) {
					for (const row of live?.rows ?? []) {
						if (!row.presetId) { continue; }
						const list = sessionsBy.get(row.presetId) ?? [];
						list.push(row);
						sessionsBy.set(row.presetId, list);
					}
					for (const list of sessionsBy.values()) {
						list.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
					}
				}
				const fmtTokens = n => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
				const fmtTime = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');
				const lines = rows.map(row => {
					const agent = scan.agents.find(a => a.id === row.agentId);
					const head = `- ${agent?.name ?? row.agentId}（${row.presetId}）${agent?.model ? ` model ${agent.model}` : ''}`;
					const liveText = row.sessions > 0
						? `会话 ${row.sessions} · token ${fmtTokens(row.tokens)} · ${row.turns} 回合 · 最近 ${fmtTime(row.lastActiveAt)}`
						: '还没有会话';
					const tail = [];
					if (verbose && row.sessions > 0) {
						const recent = (sessionsBy.get(row.presetId) ?? []).slice(0, 5)
							.map(s => `    · ${s.id}${s.title ? ` — ${s.title}` : ''}（${fmtTime(s.lastActiveAt)}）`);
						tail.push(...recent);
					}
					return [head, `  ${liveText}`, ...tail].join('\n');
				});
				if (lines.length === 0) {
					return '还没有 agent（每个子目录需要一个带 name 的 .agent.md）。';
				}
				const notes = [];
				if (unmatched.length > 0) {
					notes.push(`有会话但源文件已删的 preset：${unmatched.join(', ')}`);
				}
				if (live?.errors?.length) {
					notes.push(`实况读取有 ${live.errors.length} 条坏记录（已跳过）：${live.errors[0]}`);
				}
				if (scan.errors.length) {
					notes.push(`定义读取有 ${scan.errors.length} 条问题：${scan.errors[0]}`);
				}
				return [...lines, ...notes].join('\n');
			},
		},
		{
			name: 'agent_open_session',
			description: '为某个 agent 开一条新会话（按其 preset：人设 + 模型 + 工具白名单），返回会话 id。只建空会话、不发消息；要它干活，开完后到那条会话里说话。',
			parameters: {
				type: 'object',
				properties: {
					agent: { type: 'string', description: 'agent 的 id 或名字（agent_list 能列出来）' },
					cwd: { type: 'string', description: '会话工作目录（可空 = dsh 默认工作区）' },
				},
				required: ['agent'],
			},
			output: textOutput,
			async execute(args) {
				const scan = await scanAgents(agentsRootOf(config));
				const { agent, error } = findAgent(scan.agents, args?.agent);
				if (error) { return error; }
				const sc = state.sessionController;
				if (typeof sc?.create !== 'function') {
					return '这个 dsh 组合里没有 sessionController 服务，开不了会话（dsh 版本不匹配？）。';
				}
				const cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
				// Workspace Grant 闸（2026-10-16 二期）：显式 cwd 必须在 .agent.md 的 workspaces-read 里 ✓
				const refusal = checkCwdGrant(agent, cwd);
				if (refusal) { return refusal; }
				const want = presetIdOf(agent.id);
				const created = await sc.create({ ...(cwd ? { cwd } : {}), agentPreset: want });
				if (created?.agentPreset && created.agentPreset !== want) {
					return `会话已建（id ${created.sessionId}），但实际跑的是 preset ${created.agentPreset} 而不是 ${want}——该 agent 的 preset 可能没注册成功（看 /x/agents 页的诊断）。`;
				}
				return `已为 ${agent.name} 开好新会话（id ${created?.sessionId}，preset ${created?.agentPreset ?? want}）。到会话列表里找它。`;
			},
		},
		{
			name: 'agent_switch_persona',
			description: '切换**本会话**的人格为另一个 agent 的人设（下一回合生效；工具与模型不变——要换能力只能用 agent_open_session 开对应 preset 的新会话）。clear=true 恢复本会话自带人设。改的是提示词内容，所以这条要用户批准。',
			parameters: {
				type: 'object',
				properties: {
					agent: { type: 'string', description: '目标人格的 agent id 或名字（其 .agent.md 必须有人设正文）' },
					clear: { type: 'boolean', description: 'true = 恢复本会话 preset 自带人设（此时不需要 agent）' },
				},
			},
			output: textOutput,
			async execute(args, exec) {
				const selfId = exec?.agent?.id;
				if (!selfId) {
					return '拿不到当前会话身份，无法切换（这个工具只能在会话里用）。';
				}
				const live = agentsSvc()?.get?.(selfId);
				if (!live || typeof live.inject !== 'function') {
					return '当前会话不在运行或不支持 inject（dsh 版本不匹配？）。';
				}
				if (args?.clear === true) {
					live.inject(personaSwitchMessage(null, { clear: true, uuid: randomUUID }));
					return '已注入"恢复自带人设"（下一回合生效）。';
				}
				const scan = await scanAgents(agentsRootOf(config));
				const { agent, error } = findAgent(scan.agents, args?.agent);
				if (error) { return error; }
				if (!agent.persona) {
					return `该 agent 没有人设正文，切不了：${agent.id}`;
				}
				live.inject(personaSwitchMessage(agent, { uuid: randomUUID }));
				return `已注入人格切换 → ${agent.name}（下一回合生效；工具与模型不变）。`;
			},
		},
		{
			name: 'agent_stop',
			description: '停掉**另一个**会话正在跑的回合（agent.cancel；它排队中的消息会随回合一起丢弃）。不能停自己所在的会话。session 参数从 agent_list verbose 里取。打断别人的工作，所以这条要用户批准。',
			parameters: {
				type: 'object',
				properties: {
					session: { type: 'string', description: '要停的会话 id（agent_list verbose=true 能列出来）' },
					reason: { type: 'string', description: '为什么停（写进审批与日志）' },
				},
				required: ['session'],
			},
			output: textOutput,
			async execute(args, exec) {
				const sessionId = String(args?.session ?? '').trim();
				if (!sessionId) {
					return '要给 session 参数（agent_list 的 verbose=true 能列出会话 id）。';
				}
				if (sessionId === exec?.agent?.id) {
					return '不能停自己所在的会话——你就在它里面跑；要停下就结束当前回合。';
				}
				const target = agentsSvc()?.get?.(sessionId);
				if (!target) {
					return `会话不在运行：${sessionId}（只有加载中的会话能停；已结束的不用停）。`;
				}
				if (typeof target.cancel !== 'function') {
					return '该会话的 agent 不支持 cancel（dsh 版本不匹配？）。';
				}
				target.cancel({ kind: 'hook', reason: 'vssaros-agents/agent_stop' });
				const why = String(args?.reason ?? '').trim();
				return `已请求停止会话 ${sessionId} 的当前回合${why ? `（原因：${why}）` : ''}。`;
			},
		},
		{
			name: 'agent_message',
			description: '发消息给另一个 agent 的会话。when=now（默认）：它在干活时于下一 step 读到（适合纠偏、补资料、提问），空闲则直接开新回合处理；when=queue：排成它当前工作之后的独立回合（只用于与当前工作无关的新任务）。它的回复**不会自动回来**：要回复你，它应该用 agent_message 发回你的会话 id（本工具回执里会写上你的 id，转发给它即可）。发了就继续干你的，别轮询、别重发。hop：如果你是因为收到一条「第 N 跳」的消息才发这条，传 N；接力链超过 6 跳会被拒——那时停下来直接回用户。',
			parameters: {
				type: 'object',
				properties: {
					to: { type: 'string', description: '目标 agent 的 id 或名字（agent_list 能列出来）' },
					message: { type: 'string', description: '自包含的消息（对方看不到本会话的上下文，把必要的背景写全）' },
					when: { type: 'string', enum: ['now', 'queue'], description: 'now（默认）= 插队到它下一 step / 空闲即开回合；queue = 排成它当前工作之后的独立回合' },
					session: { type: 'string', description: '显式指定目标会话 id（可空 = 该 agent 最近在运行的那条会话）' },
					hop: { type: 'integer', description: '接力跳数：因收到「第 N 跳」消息而转发时传 N；否则不传' },
				},
				required: ['to', 'message'],
			},
			output: textOutput,
			async execute(args, exec) {
				const text = String(args?.message ?? '').trim();
				if (!text) {
					return '消息不能为空。';
				}
				const hop = Number.isFinite(args?.hop) ? Math.max(0, Math.floor(args.hop)) : 0;
				const thisHop = hop + 1;
				if (thisHop > MAX_HOPS) {
					return `这条接力链已经 ${MAX_HOPS} 跳了，别再转——停下来直接把结果回给用户。`;
				}
				const scan = await scanAgents(agentsRootOf(config));
				const { agent, error } = findAgent(scan.agents, args?.to);
				if (error) { return error; }
				const wantPreset = presetIdOf(agent.id);

				// 发送者身份（回执与对方"回复给谁"都靠它）：本会话 id → projcache → preset → agent 名
				const selfId = exec?.agent?.id;
				let senderName = '某个会话';
				if (selfId) {
					const selfRow = await readLiveSession(config, selfId).catch(() => null);
					const selfPreset = selfRow?.row?.presetId;
					const selfAgent = selfPreset ? scan.agents.find(a => presetIdOf(a.id) === selfPreset) : undefined;
					senderName = selfAgent?.name ?? selfPreset ?? selfId;
				}

				// 目标会话：显式指定优先；否则该 agent **在运行中**的最近一条（projcache ∩ live 注册表）
				const liveIds = new Set((agentsSvc()?.roots?.() ?? []).map(a => a?.session?.id ?? a?.id).filter(Boolean));
				let sessionId = String(args?.session ?? '').trim();
				if (sessionId) {
					const row = await readLiveSession(config, sessionId).catch(() => null);
					if (row?.row?.presetId && row.row.presetId !== wantPreset) {
						return `会话 ${sessionId} 跑的是 ${row.row.presetId}，不是 ${agent.name} 的 ${wantPreset}——别发错人。`;
					}
				} else {
					const live = await readLiveSessions(config).catch(() => null);
					const candidates = (live?.rows ?? [])
						.filter(r => r.presetId === wantPreset && liveIds.has(r.id))
						.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
					if (candidates.length === 0) {
						return `${agent.name} 当前没有在运行的会话。先用 agent_open_session 给它开一条，再发消息。`;
					}
					sessionId = candidates[0].id;
				}
				if (sessionId === selfId) {
					return '不能发给自己所在的会话——你就在它里面。';
				}
				const target = agentsSvc()?.get?.(sessionId);
				if (!target) {
					return `会话不在运行：${sessionId}（只能发给加载中的会话）。`;
				}

				// 头协议（ds-bot 的 [Message from …] 同构）：署名 + 我方会话 id（对方回复的地址）+ 跳数。
				const header = `[Message from ${senderName}（其会话 id：${selfId ?? '未知'}）· 第 ${thisHop} 跳]\n要回复它：用 agent_message 发到会话 ${selfId ?? '?'}${selfId ? '' : '（发送者会话 id 未知，没法回）'}，hop 传 ${thisHop}；别自动转发给第三方。\n`;
				const message = {
					id: randomUUID(),
					role: 'user',
					content: [{ type: 'text', text: `${header}\n${text}` }],
					source: { kind: AGENT_MESSAGE_KIND, from: selfId ?? null, hop: thisHop, to: agent.id },
				};
				if (args?.when === 'queue') {
					if (typeof target.followup !== 'function') {
						return '该会话的 agent 不支持 followup（dsh 版本不匹配？）。';
					}
					target.followup(message);
					// 登记 pending ⇒ 它的回合结束时回复自动回传（lib/relay.js + outbox 落盘，2026-10-16 起重启不丢 ✓）
					notePendingReply(config, sessionId, { messageId: message.id, from: selfId ?? null, fromName: senderName, hop: thisHop });
					return `已排队给 ${agent.name}（会话 ${sessionId}）：它当前工作结束后作为独立回合处理；它回完后，回复会自动送回你的会话（Host 重启会丢未回传的——重要的事自己跟进）。`;
				}
				if (typeof target.steer !== 'function') {
					return '该会话的 agent 不支持 steer（dsh 版本不匹配？）。';
				}
				target.steer(message);
				notePendingReply(config, sessionId, { messageId: message.id, from: selfId ?? null, fromName: senderName, hop: thisHop });
				return `已发给 ${agent.name}（会话 ${sessionId}）：它在干活则下一 step 读到，空闲则直接开回合；它回完后，回复会自动送回你的会话（Host 重启会丢未回传的——重要的事自己跟进）。别轮询、别重发。`;
			},
		},
		{
			name: 'agent_read_chat',
			description: '读/搜本会话的完整历史（以会话日志为准——压缩只动模型表面、不动日志，所以被压缩掉的早期内容也能找回来）。query 给关键词做字面搜索（不区分大小写）；不给就返回最近几条。每行的 #数字是事件序号。找不到就直说，别凭记忆补细节。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '字面关键词（可空 = 返回最近几条）；多个词按整串匹配' },
					limit: { type: 'integer', description: '返回条数上限，1–50（默认 12；超出会被夹到边界）' },
				},
			},
			output: textOutput,
			isConcurrencySafe: true,
			async execute(args, exec) {
				const sessionId = exec?.agent?.id;
				if (!sessionId) {
					return '拿不到当前会话身份（这个工具只能在会话里用）。';
				}
				const sq = state.sessionQuery;
				if (typeof sq?.filterEvents !== 'function') {
					return '这个 dsh 组合里没有 sessionQuery 服务，读不了历史（dsh 版本不匹配？）。';
				}
				const query = String(args?.query ?? '').trim();
				const limit = Math.max(1, Math.min(50, Number.isInteger(args?.limit) ? args.limit : 12));
				// 字面子句由服务端执行（`SessionEventResultFilter` 的 kind:'text' ✓），不整读日志到本地 ✓
				const filters = query ? [{ kind: 'text', text: query }] : [];
				let docs;
				try {
					docs = await sq.filterEvents(sessionId, filters);
				} catch (e) {
					return `读历史失败：${String(e?.message ?? e)}`;
				}
				if (!Array.isArray(docs) || docs.length === 0) {
					return query ? `没搜到含「${query}」的历史记录。` : '还没有历史记录。';
				}
				const total = docs.length;
				const shown = docs.slice(-limit); // 文档按 seq 正序返回 ✓；取尾部 = 最近的
				const lines = [];
				let chars = 0;
				const CHAR_BUDGET = 8000; // 总输出上限：历史检索不该把上下文灌爆 ✓
				for (const d of shown) {
					const text = String(d?.text ?? '').replace(/\s+/g, ' ').trim();
					const line = `#${d?.seq ?? '?'} [${d?.type ?? '?'}] ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
					if (chars + line.length > CHAR_BUDGET) {
						lines.push(`（输出到上限了，剩下 ${shown.length - lines.length} 条没列——加 query 缩小范围）`);
						break;
					}
					lines.push(line);
					chars += line.length;
				}
				const more = total > shown.length ? `\n（另有 ${total - shown.length} 条没列出——加 query 缩小范围，或提高 limit）` : '';
				return `${query ? `含「${query}」的 ${total} 条` : `最近 ${shown.length} 条`}（按时间正序）：\n${lines.join('\n')}${more}`;
			},
		},
	];

	const disposers = defs.map(definition => ctx.tools.register(definition));
	const offGate = ctx.on('tools/pre-execute', async (exec, next) => {
		if (!exec || !WRITE_TOOLS.includes(exec.name)) {
			return next(); // agent_list / agent_open_session 与其它插件的工具 ⇒ 放行
		}
		// 审批模板（2026-10-16，P2）：命中 ⇒ 自动放行。模板只覆盖 WRITE_TOOLS 这两个工具、
		// 工具名级粒度（lib/templates.js 头注释 ①②）；读模板失败按"没有" ⇒ 照常问（宁可多问 ✗ 关闭闸）。
		try {
			if (await state.approvalTemplates?.has?.(exec.name)) {
				return next();
			}
		} catch {
			/* 读模板失败 ⇒ 照常问 ✓ */
		}
		// ⚠ 参数在 `exec.arguments`（官方 ToolExecutionInput.arguments），不是 args —— 写错会静默放行。
		return { kind: 'ask', reason: gateReason(exec.name, exec.arguments ?? {}) };
	});
	return () => {
		offGate();
		for (const dispose of disposers) {
			dispose();
		}
	};
}
