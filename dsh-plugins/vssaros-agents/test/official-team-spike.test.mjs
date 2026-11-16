// @vssaros/dsh-agents — 官方 Agent Teams 执行树 spike（默认关闭、只读、零写入）。
//
// VSSAROS_OFFICIAL_TEAM_SPIKE=1 时，由外部 CDP 脚本把运行中的 remote 传入 officialTeamSpike(remote)：
// 它只调用 remote.agentPresets.list() 读清单、动态推导 allowedAgentPresets，并核对
// remote.agentTeams / remote.subagents 的公开方法面。CI 默认不连 Host、不传 remote。
//
// ★ 结论：P1 gate=BLOCKED —— 客户端没有「按 Bot preset 创建 continuable 后代」的公开接口，
//   随包 dsh-base 默认未开放 allowedAgentPresets。因此不迁移存量群、不双写任务板、不伪造 owner/caller。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SPIKE_FLAG = 'VSSAROS_OFFICIAL_TEAM_SPIKE';
const CONCLUSION = 'P1 gate=BLOCKED';

/**
 * 只读推导：preset 清单必须是动态取的（不能手抄内置 Bot 名单），
 * 且不创建任何后代 / 任务 / 消息，也不读写群聊账本。
 */
export async function officialTeamSpike(remote) {
	const agentPresets = remote?.agentPresets;
	const presets = agentPresets && typeof agentPresets.list === 'function' ? await agentPresets.list() : [];
	const ids = (Array.isArray(presets) ? presets : [])
		.map(item => String(item?.id ?? item?.name ?? '')).filter(Boolean);
	const allowedAgentPresets = ids.filter(id => id.startsWith('vssaros-'));
	return {
		allowedAgentPresets,
		presetCount: ids.length,
		agentTeams: Object.keys(remote?.agentTeams ?? {}),
		subagents: Object.keys(remote?.subagents ?? {}),
		conclusion: CONCLUSION,
	};
}

test('P1 spike 默认关闭：无 remote 时零清单、零写入、结论仍是 P1 gate=BLOCKED', async () => {
	const probe = await officialTeamSpike(undefined);
	assert.deepEqual(probe.allowedAgentPresets, []);
	assert.equal(probe.presetCount, 0);
	assert.equal(probe.conclusion, 'P1 gate=BLOCKED');
	assert.deepEqual(Object.keys(probe), ['allowedAgentPresets', 'presetCount', 'agentTeams', 'subagents', 'conclusion'],
		`${SPIKE_FLAG} 默认关闭：探针只返回只读观察值，不含任何任务/消息写口`);
});

test('P1 spike 只读推导：动态过滤 preset，且不触碰官方执行树写口', async () => {
	const probe = await officialTeamSpike({
		agentPresets: { list: async () => [
			{ id: 'vssaros-coder' }, { id: 'builtin-general' }, { name: 'vssaros-designer' },
		] },
		agentTeams: { setEnabled() {} },
		subagents: { prompt() {}, interruptByUser() {} },
	});
	assert.deepEqual(probe.allowedAgentPresets, ['vssaros-coder', 'vssaros-designer']);
	assert.equal(probe.presetCount, 3, '清单里也有非 Bot preset，不能写死名单');
	assert.deepEqual(probe.agentTeams, ['setEnabled'], '官方 Team 公开面只有开关');
	assert.deepEqual(probe.subagents, ['prompt', 'interruptByUser'], '没有按 preset 建 continuable 后代的公开方法');
	assert.equal(probe.conclusion, 'P1 gate=BLOCKED');
});
