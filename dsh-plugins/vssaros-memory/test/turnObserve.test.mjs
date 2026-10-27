/*---------------------------------------------------------------------------------------------
 *  turnObserve.test.mjs — **回合观测**（`mem:obs:*` 暂存层）从 IDE 搬到 dsh 侧（阶段③）
 *
 * ## 为什么搬
 * "边聊边记"的唯一自动入口原本是 IDE 渲染进程的 `memoryProvider.observe(...)`（4 处调用）
 * ⇒ 依赖「渲染进程存活 + 代理可用 + IDE 重启才生效」。
 * 而 dsh 插件本来就在同一个 `agent/turn-stopping` hook 上跑 distill（事件源完全相同）
 * ⇒ 搬进插件更稳，也少一处跨进程调用。
 *
 * ## 与 turnCandidatesOf 的分工（别混）
 *   · `buildTurnObservation` ⇒ **观测**（暂存层，每回合流水，引擎固化管线消费）
 *   · `turnCandidatesOf`     ⇒ **草稿**（需人工「提升」才进长期记忆）
 *
 * ## 本测试钉住
 *  ① 真实事件形状（`assistant/message` 的文本在 `data.message.content`）⇒ 能产观测
 *  ② 只有用户没助手 / 只有助手没用户 ⇒ **仍产**（观测是流水，不追求"值不值得记"）
 *  ③ 全空 ⇒ `null`（不写噪音）
 *  ④ 截断到上限（别把整段对话塞进暂存层）
 *  ⑤ 形状：`hookType='turn_end'`、`timestamp` 是 **ISO 字符串**、`data.source='dsh-plugin'`
 *  ⑥ **接线断言**：`index.js` 必须在 turn-stopping hook 里调 `observe`，且默认开启
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTurnObservation, TURN_OBS_HOOK_TYPE, TURN_OBS_USER_MAX, TURN_OBS_ASSISTANT_MAX } from '../lib/core/distill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'lib', 'index.js');

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

const user = text => ({ type: 'user/message', data: { content: text, source: { kind: 'user' } } });
const assistantReal = text => ({ type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] } });

check('① 真实形状（data.message.content）⇒ 能产观测', () => {
	const obs = buildTurnObservation([user('帮我看下记忆链路'), assistantReal('读取正常、注入空壳、存储通')], { sessionId: 's1', turn: 3, now: 1700000000000 });
	assert.ok(obs, '应产出一条观测');
	assert.equal(obs.data.user, '帮我看下记忆链路');
	assert.equal(obs.data.assistant, '读取正常、注入空壳、存储通');
	return `turn=${obs.data.turn}`;
});

check('② 只有用户（无助手）⇒ 仍产（观测是流水，不追求"值得记"）', () => {
	const obs = buildTurnObservation([user('只有一句话')], { sessionId: 's2', turn: 1 });
	assert.ok(obs, '只有用户内容也应产观测');
	assert.equal(obs.data.assistant, '');
	return 'ok';
});

check('②b 只有助手（无用户）⇒ 仍产', () => {
	const obs = buildTurnObservation([assistantReal('模型自己说了段话')], { sessionId: 's3' });
	assert.ok(obs);
	assert.equal(obs.data.user, '');
	return 'ok';
});

check('③ 全空 ⇒ null（不写噪音）', () => {
	assert.equal(buildTurnObservation([], {}), null);
	assert.equal(buildTurnObservation([user('   '), assistantReal('\n\n')], {}), null);
	return 'ok';
});

check('④ 超长输入 ⇒ 截断到上限', () => {
	const longUser = '需'.repeat(2000);
	const longAssistant = '答'.repeat(2000);
	const obs = buildTurnObservation([user(longUser), assistantReal(longAssistant)], {});
	assert.ok(obs.data.user.length <= TURN_OBS_USER_MAX + 1, `user 应截断到 ${TURN_OBS_USER_MAX}，实际 ${obs.data.user.length}`);
	assert.ok(obs.data.assistant.length <= TURN_OBS_ASSISTANT_MAX + 1, `assistant 应截断到 ${TURN_OBS_ASSISTANT_MAX}，实际 ${obs.data.assistant.length}`);
	return `u=${obs.data.user.length} a=${obs.data.assistant.length}`;
});

check('⑤ 形状：hookType / ISO 时间 / source 标记', () => {
	const obs = buildTurnObservation([user('x'), assistantReal('y')], { sessionId: 's4', turn: 2, now: 1700000000000 });
	assert.equal(obs.hookType, TURN_OBS_HOOK_TYPE);
	assert.equal(obs.sessionId, 's4');
	assert.match(obs.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'timestamp 必须是 ISO 字符串（引擎按它排序）');
	assert.equal(obs.data.source, 'dsh-plugin', '要能分辨是谁写的（排查"两条路径都写"时用）');
	return 'ok';
});

check('⑥ 接线：index.js 在 turn-stopping hook 里调 observe，且默认开启', () => {
	const src = fs.readFileSync(INDEX, 'utf8');
	assert.ok(src.includes("ctx.on('agent/turn-stopping'"), '必须挂在 turn-stopping（与 distill 同一事件源）');
	assert.ok(src.includes("providerCall(obsBase, 'observe'"), '必须真的调 /provider/observe');
	assert.ok(src.includes('buildTurnObservation(events'), '观测内容必须由 events 构建（不能空写）');
	assert.ok(src.includes('const observeOnTurn = config.observeOnTurn !== false;'), '默认必须开启（否等于没做）');
	assert.ok(src.includes('state.observe'), '必须有计数（否则"没写进去"看不出来）');
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 回合观测测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 回合观测（dsh 侧）测试通过（${results.length} 项）`);
