// @vssaros/dsh-agents — 团队服务（2026-11-04，superagent 主管组团 T0）
//
// 把本插件已有的能力包成团队总线（lib/teamBus.js）的实现，给同一 Host 里的 dsh-superagent 主管用：
//   listBots  名册 → 能力卡片（不含隐藏 bot；`delegatable` 原样带上，由调用方决定怎么用）
//   delegate  复用委派台账 createAssignment（开会话 → 选模型 → steer 任务；并发上限仍是 MAX_CONCURRENT）
//   get / cancel  委派台账的读 / 中断
// 结束通知由 lib/assignments.js 在回合结束 / 中断时发布到总线（只发终态）。
//
// 与 HTTP 委派的两点不同：
//   ① 名册扫「内置 + 自定义」两个根（HTTP 委派历史上只扫自定义根，见 groups.js 的同一个坑）；
//   ② 不登记 relay 回传：主管要的是结构化的「这条委派结束了」，由总线送达；再走 relay 会在主管会话里多一份回复。

import { assignmentView, cancelAssignment, createAssignment, getAssignment } from './assignments.js';
import { isDelegatableAgent, isShownAgent, presetIdOf } from './core/agents.js';
import { scanAgentsFromConfig } from './store.js';

const list = (value) => (Array.isArray(value) ? value.map(v => String(v)).filter(Boolean) : []);

/** 一张能力卡片（主管挑人用；不含 persona 正文）。 */
export function botCard(agent) {
	return {
		id: String(agent.id),
		name: String(agent.name ?? agent.id),
		role: agent.role ? String(agent.role) : undefined,
		description: String(agent.description ?? ''),
		skills: list(agent.skills),
		tools: list(agent.tools),
		model: agent.model ? String(agent.model) : undefined,
		delegatable: isDelegatableAgent(agent),
		...(agent.createdBy === 'supervisor' ? { origin: 'supervisor' } : {}),
		source: agent.source === 'builtin' ? 'builtin' : 'custom',
		preset: presetIdOf(agent.id),
		workspaces: agent.workspaces && typeof agent.workspaces === 'object'
			? { read: list(agent.workspaces.read), write: list(agent.workspaces.write) }
			: undefined,
	};
}

/**
 * 团队服务实现（交给 teamBus().provide）。
 * @param config 顶层行 config
 * @param state 顶层角色状态（sessionController / agents / llm / projections 由 ctx.inject 填）
 */
export function createTeamService(config, state) {
	const scan = (cfg) => scanAgentsFromConfig(cfg);
	return {
		async listBots() {
			const { agents } = await scan(config);
			return (agents ?? []).filter(isShownAgent).map(botCard);
		},
		/**
		 * @param input `{ bot, task, cwd?, fromName? }`：`bot` 是 id 或名字（歧义报错、不猜）
		 */
		async delegate(input) {
			const record = await createAssignment(config, state, {
				agent: input?.bot,
				task: input?.task,
				cwd: input?.cwd,
				fromName: String(input?.fromName ?? '').trim() || 'SuperAgent 主管',
			}, { scan });
			return assignmentView(record);
		},
		async get(id) {
			const record = await getAssignment(config, id);
			return record ? assignmentView(record) : undefined;
		},
		async cancel(id, reason) {
			return assignmentView(await cancelAssignment(config, state, { id, reason }));
		},
	};
}
