/*---------------------------------------------------------------------------------------------
 *  会话存储后端接缝（`common/chatSessionBackend.ts`）行为网
 *
 *  A1 方案第 1 步。为什么要先有这份网：**后端选错了 / 把不支持的动作当支持**，是本方案里
 *  最容易静默出错的两处（表现都是"点了没反应"）。第 2 步接路由层时直接依赖这里的判据。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { agentPresetIdOf, backendSupports, isDshSessionId, resolveSessionBackend, SUPPORTED_DSH, SUPPORTED_LOCAL, unsupportedError } from '../../common/chatSessionBackend.js';

/** 源码级断言：路径相对**仓库根**（runner 从仓库根跑 ✓）。 */
function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

suite('会话后端 · id 归属', () => {

	test('dsh 派生的 vssaros-chat-* 与官方 session-<uuid> 都算 dsh', () => {
		assert.strictEqual(isDshSessionId('vssaros-chat-chat-1792282803597-o61e4p'), true);
		assert.strictEqual(isDshSessionId('vssaros-chat-default--vssaros-standard--wt-sarosis-agents-client-42477a'), true);
		assert.strictEqual(isDshSessionId('session-360f1cd4-f93a-4ac7-bcd2-14a5ffd7e000'), true);
	});

	test('本地 sess_<base36>_<rand> 不算 dsh（两个命名空间不相交）', () => {
		assert.strictEqual(isDshSessionId('sess_mabc123_x7k2p9'), false);
		assert.strictEqual(isDshSessionId('sess_m0_000000'), false);
	});

	test('空 / undefined / 形态不明的 ⇒ false（不猜）', () => {
		assert.strictEqual(isDshSessionId(''), false);
		assert.strictEqual(isDshSessionId(undefined), false);
		assert.strictEqual(isDshSessionId(null), false);
		assert.strictEqual(isDshSessionId('session-'), false, '没有 uuid 段 ⇒ 不是 dsh 会话 id');
		assert.strictEqual(isDshSessionId('随便一个名字'), false);
	});
});

suite('会话后端 · 后端选择', () => {

	test('legacy 引擎 ⇒ 一律本地（dsh 可能根本没起）', () => {
		assert.strictEqual(resolveSessionBackend({ engine: 'legacy', sessionId: 'vssaros-chat-x' }), 'local');
		assert.strictEqual(resolveSessionBackend({ engine: undefined }), 'local');
	});

	test('dsh 引擎 + dsh 会话 id ⇒ dsh', () => {
		assert.strictEqual(resolveSessionBackend({ engine: 'dsh', sessionId: 'vssaros-chat-x' }), 'dsh');
		assert.strictEqual(resolveSessionBackend({ engine: 'dsh', sessionId: 'session-360f1cd4-f93a-4ac7-bcd2-14a5ffd7e000' }), 'dsh');
	});

	test('★ dsh 引擎 + **老会话**（sess_ 前缀）⇒ 仍是本地（迁移前建的还在本地）', () => {
		assert.strictEqual(resolveSessionBackend({ engine: 'dsh', sessionId: 'sess_mabc_x1' }), 'local');
	});

	test('dsh 引擎 + 没有 id（新建）⇒ 本地（第 4 步接通 create 后再切到 dsh）', () => {
		assert.strictEqual(resolveSessionBackend({ engine: 'dsh' }), 'local');
	});
});

suite('会话后端 · 能力矩阵', () => {

	test('本地后端全部支持', () => {
		for (const cap of SUPPORTED_LOCAL) {
			assert.strictEqual(backendSupports('local', cap), true, cap);
		}
		assert.strictEqual(SUPPORTED_LOCAL.length, 11, '能力清单变了 ⇒ 这里要跟着复核 ✗');
	});

	test('★ dsh 后端**不支持**删除 / 追加消息 / 清空 / 截断 / 替换（事件流不可变 + 无删除 API）', () => {
		for (const cap of ['deleteSession', 'appendMessage', 'clearHistory', 'deleteMessagesAfter', 'replaceHistory'] as const) {
			assert.strictEqual(backendSupports('dsh', cap), false, `${cap} 在 dsh 侧没有对应能力 ✗`);
		}
	});

	test('dsh 后端支持 list / create / history / send / fork', () => {
		for (const cap of ['list', 'create', 'history', 'send', 'fork'] as const) {
			assert.strictEqual(backendSupports('dsh', cap), true, cap);
		}
		assert.strictEqual(SUPPORTED_DSH.length, 5);
	});

	test('unsupportedError 的消息带后端与动作（日志/通知能说清是哪半边不行）', () => {
		const e = unsupportedError('dsh', 'deleteSession');
		assert.ok(e.message.includes('dsh'), e.message);
		assert.ok(e.message.includes('deleteSession'), e.message);
	});
});

/**
 * IDE agent → dsh preset 的 id 派生（A1 第 4 步：侧栏新建会话要指定 preset）。
 *
 * ⚠ 真源在 dsh 插件里（`vssaros-agents/lib/core/agents.js` 的 `slugify` + `presetIdOf`），
 *   这里是**复制** ⇒ 两边漂移的表现是"选了 agent A、建的却是默认 preset 的会话"（静默 ✗）。
 */
suite('会话后端 · agent → preset 派生', () => {

	test('常规 id：小写 + 非字母数字折成单个连字符 + `vssaros-` 前缀', () => {
		assert.strictEqual(agentPresetIdOf('Saros Claw'), 'vssaros-saros-claw');
		assert.strictEqual(agentPresetIdOf('PPT专家'), 'vssaros-ppt', '中文/非 ASCII 整体被折掉（与插件同规则 ✓）');
		assert.strictEqual(agentPresetIdOf('a_b--c'), 'vssaros-a-b-c');
	});

	test('★ 空 / 纯符号 ⇒ 回退 `vssaros-agent`（不许拼出 `vssaros-` 这种空尾巴 ✗）', () => {
		assert.strictEqual(agentPresetIdOf(''), 'vssaros-agent');
		assert.strictEqual(agentPresetIdOf('!!!'), 'vssaros-agent');
	});
});

/**
 * 接线契约（源码级）：能力矩阵**只有被真正用上**才有效 ——
 * 否则就是一份没人读的文档（dsh 会话上的不支持动作仍会静默成功 ✗）。
 */
suite('会话后端 · 接线契约（源码级）', () => {

	// ⚠ 相对**仓库根**（runner 从仓库根跑 ⇒ 相对本文件的 `../../browser/…` 会解析到盘符根 ✗）
	const SERVICE = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';

	test('★ `agentChatService` 真的接了后端判据', () => {
		const src = read(SERVICE);
		assert.ok(src.includes('common/chatSessionBackend.js'), '服务必须 import 后端判据 ✗');
		assert.ok(src.includes('private _requireCapability('), '必须有能力闸门方法 ✗');
		assert.ok(src.includes('resolveSessionBackend({'), '闸门必须用它选后端 ✗');
	});

	test('★ 5 个「dsh 侧做不到」的动作**都**过了闸门（漏一个 = 静默成功 = 点了没反应）', () => {
		const src = read(SERVICE);
		for (const cap of ['appendMessage', 'clearHistory', 'replaceHistory', 'deleteMessagesAfter', 'deleteSession'] as const) {
			assert.ok(src.includes(`_requireCapability('${cap}'`), `动作 ${cap} 没过闸门 ✗`);
		}
	});

	test('闸门在**动作开头**（先判再落盘，别先改文件再报错 ✗）', () => {
		const src = read(SERVICE);
		const at = src.indexOf('async deleteAgentSession(');
		assert.ok(at > 0);
		const head = src.slice(at, at + 260);
		assert.ok(head.indexOf('_requireCapability') < head.indexOf('_resolveAgentPaths'),
			'删除会话：必须先判能力再解析路径 ✗');
	});
});
