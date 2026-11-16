// @vssaros/dsh-agents — 官方 Agent Teams → 本机 Bot 名册的**只读投影**（2026-11-12，Stage 1）。
//
// rc.2 源码核对（dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/）：
//   · dsh-agent-team/src/index.ts 的 TeamService **没有 roster / member 列表方法**（只有 isEnabled /
//     setEnabled / createTask / getTask / listTasks / updateTask）；官方 README 明说成员用标准 subagent
//     工具发现 ⇒ 唯一成员权威是 ctx.subagents 的 durable catalog。
//   · 枚举序列：ctx.agents.list() → ctx.subagents.rootOf(agent) → await listDescendants(root.id, signal)。
//   · 只有 Team 模式开启的会话才投影（ctx.agentTeams.isEnabled(root)）；dsh-base 默认加载服务但
//     defaultEnabled:false，普通 subagent 不该被塞进 Bot 名册。
//   · 官方成员名是裸 path（coder / reviewer），且 registerExternalBot 同 id/name 会顶替既有登记、
//     externalBotOf 按 id 或 name 匹配 ⇒ **必须加命名空间前缀**，否则会劫持 vssaros-* bot 与 superagent。
//   · onMessage 只读：返回 received:'filtered'，不转发 send_message —— 转发会唤醒 idle agent 起真实
//     回合（dsh-tool-subagent-control/src/index.ts:46），那就不是只读了。
//   · ★ 2026-11-12（Stage 2 修正版）：官方 `team_task_*` 工具本就是 host plane 全局注册，
//     本机 Bot 会话开启 Team 模式后可直接调用 ⇒ **不再重复注册代理工具**；这里只把 root 的
//     `listTasks()` 结果做只读摘要，附在外部 bot 的 description 上，让本机名册能看到任务板状态。
//     不写任务、不改 owner（官方 task-board.ts:135-151 的 owner 只认 exact live caller）。
//   · ★ 2026-11-12 加固：与官方 `dsh-tool-subagent-control/src/list-agents.ts:35` 同口径，
//     只投影 `mode === 'continuable'` 的后代；one-shot / external 不是可通信、可分派任务的成员
//     （task-board.ts:235 的 assignee 校验也只认 continuable）。
//
// 这个模块不改总线契约（version 仍为 1），只用 registerExternalBot 的既有入口；缺服务时 ctx.inject
// 的回调不执行，插件不会像静态 inject 那样永久 pending（见 lib/index.js:15-18 的历史教训）。

import { teamBus } from './teamBus.js';

/** 命名空间前缀：与 local `vssaros-*` bot、外部 bot `superagent` 都隔开。 */
export const OFFICIAL_TEAM_PREFIX = 'dsh-team';

/** root 任务板的只读摘要。`listTasks()` 返回 TeamTaskView[]，status 见官方 types.ts:77-91。 */
export function taskBoardSummary(tasks) {
	const list = Array.isArray(tasks) ? tasks : [];
	const count = status => list.filter(task => task?.status === status).length;
	return `任务板 ${list.length} 项（待办 ${count('pending')} / 进行中 ${count('in_progress')} / 完成 ${count('completed')}）`;
}

/** 一行 listDescendants 结果 → registerExternalBot 的 spec。纯函数，便于断言身份映射。 */
export function officialMemberSpec(rootId, row, index = 0, summary = '') {
	const rawId = String(row?.id ?? '').trim() || `member-${index}`;
	const path = String(row?.path ?? row?.name ?? rawId).trim() || rawId;
	const root = String(rootId ?? '').trim() || 'root';
	return {
		id: `${OFFICIAL_TEAM_PREFIX}:${root}:${rawId}`,
		name: `${OFFICIAL_TEAM_PREFIX}:${path}`,
		role: '官方智能体团队成员',
		description: [String(row?.label ?? path), summary].filter(Boolean).join(' · '),
		session: rawId,
		onMessage: () => ({ received: 'filtered' }),
	};
}

/**
 * 是否可投影：官方 list_agents 只返回 continuable 后代（list-agents.ts:35）。
 * 缺省 mode 时保留（兼容早期 catalog 行 / 测试假数据），显式 one-shot / external 一律跳过。
 */
export const isProjectableMember = row => row?.mode === undefined || row.mode === 'continuable';

/** 把一组官方成员登记进总线；返回只撤销这一组的函数。纯函数，不碰 cordis。 */
export function projectOfficialMembers(bus, rootId, rows, summary = '') {
	const withdraw = [];
	const list = Array.isArray(rows) ? rows : [];
	for (const [index, row] of list.entries()) {
		if (!isProjectableMember(row)) { continue; }
		const off = bus.registerExternalBot(officialMemberSpec(rootId, row, index, summary));
		if (typeof off === 'function') { withdraw.push(off); }
	}
	return () => { for (const off of withdraw) { off(); } };
}

/**
 * 对账一次：只投影「Team 模式已开启」的根会话的后代。
 * 服务缺失 / 抛错一律静默跳过 —— 只读适配器不能影响 Host 启动或正常会话。
 */
export async function syncOfficialTeamMembers({ subagents, agentTeams, agents, bus }) {
	const withdraw = [];
	let live = [];
	try { if (typeof agents?.list === 'function') { live = agents.list(); } }
	catch { live = []; } // 服务抛错不能影响宿主
	const roots = new Map();
	for (const agent of Array.isArray(live) ? live : []) {
		try {
			const root = typeof subagents?.rootOf === 'function' ? subagents.rootOf(agent) : undefined;
			if (root?.id) { roots.set(String(root.id), root); }
		} catch { /* 单个 agent 解析失败不挡其它根 */ }
	}
	for (const [rootId, root] of roots) {
		let enabled = false;
		try { enabled = typeof agentTeams?.isEnabled === 'function' && agentTeams.isEnabled(root) === true; }
		catch { enabled = false; }
		if (!enabled) { continue; }
		let rows = [];
		try {
			if (typeof subagents?.listDescendants === 'function') { rows = await subagents.listDescendants(rootId); }
		} catch { rows = []; }
		// 只读：listTasks 要 exact live caller，root 来自 ctx.agents.list() → rootOf()，符合官方要求。
		// 缺服务 / 抛错一律降级为空摘要，绝不影响成员投影本身。
		let summary = '';
		try {
			if (typeof agentTeams?.listTasks === 'function') { summary = taskBoardSummary(agentTeams.listTasks(root)); }
		} catch { summary = ''; }
		withdraw.push(projectOfficialMembers(bus, rootId, rows, summary));
	}
	return () => { for (const off of withdraw) { off(); } };
}

/** 成员出现 / 消失时重列；subagent/end ≠ 成员消失（durable catalog），所以一律重新对账。 */
const MEMBER_EVENTS = ['agent/created', 'agent/disposed', 'subagent/start', 'subagent/end'];

/**
 * 安装适配器。`ctx.inject` 是**可选注入**：组合里没挂 dsh-agent-team / dsh-subagent 时回调不执行，
 * 不会像静态 inject 那样让插件永久 pending。返回 child 作用域，卸载时随 effect 一起撤销。
 */
export function installOfficialTeamAdapter(ctx, bus = teamBus()) {
	return ctx.inject(['agentTeams', 'subagents', 'agents'], child => child.effect(() => {
		let off = () => undefined;
		let busy = false;
		const refresh = async () => {
			if (busy) { return; } // 事件风暴时丢掉的更新由下一次事件补上
			busy = true;
			try {
				const next = await syncOfficialTeamMembers({
					subagents: child.subagents, agentTeams: child.agentTeams, agents: child.agents, bus,
				});
				off();
				off = next;
			} catch { /* 只读投影出错不影响宿主 */ }
			finally { busy = false; }
		};
		const offs = [];
		for (const name of MEMBER_EVENTS) {
			try {
				const dispose = child.on(name, () => { void refresh(); });
				if (typeof dispose === 'function') { offs.push(dispose); }
			} catch { /* 某些组合没有该事件 */ }
		}
		void refresh();
		return () => {
			off();
			for (const dispose of offs) { try { dispose(); } catch { /* 忽略 */ } }
		};
	}));
}
