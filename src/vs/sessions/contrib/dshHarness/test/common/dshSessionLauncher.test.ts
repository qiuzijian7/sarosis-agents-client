/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `dshSessionLauncher` 单测：钉住「中立层钩子 + 控制桥入参拼装」。
 *
 * 为什么必须有：IDE 后台入口改走控制桥后，拼错 cwd、丢 sessionId、漏 preset 都只会在
 * 真机上表现为「会话空转 / 历史串台」，而且 dsh 的 `create({sessionId})` 在 live 会话上
 * 会另铸一条空会话 ✗ ⇒ 确定性 id 派生与参数透传必须做成机器断言。
 *
 * ⚠ 宿主实现在 `electron-browser`，会拉进 browser 层依赖（node 无 `window` ✗），
 *   所以这里只测 `common/` 的纯函数与中立层钩子；宿主接线用源码断言（最后一条）补上。
 */

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDshSessionLauncher, setDshSessionLauncher } from '../../../../common/dshSessionLauncher.js';
import {
	deriveLaunchSessionId, resolveLaunchCwd,
	toSessionRunArgs, toSessionStartArgs,
} from '../../common/dshSessionLauncherCore.js';

const repoRoot = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const hostSource = readFileSync(join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-browser', 'dshSessionLauncher.ts'), 'utf8');
const contributionSource = readFileSync(join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-browser', 'dshHarness.contribution.ts'), 'utf8');
const bridgeSource = readFileSync(join(repoRoot, 'dsh-plugins', 'vssaros-bridge', 'lib', 'index.js'), 'utf8');

const folder = (p: string) => ({ uri: { fsPath: p } });

suite('dshHarness / dshSessionLauncher', () => {

	test('中立层钩子：注册后可取到，注销后不残留全局实现', () => {
		setDshSessionLauncher(undefined);
		assert.strictEqual(getDshSessionLauncher(), undefined);
		const stub = { start: async () => ({ sessionId: 'x' }), runTurn: async () => ({}) };
		setDshSessionLauncher(stub as never);
		assert.strictEqual(getDshSessionLauncher(), stub);
		setDshSessionLauncher(undefined);
		assert.strictEqual(getDshSessionLauncher(), undefined);
	});

	test('resolveLaunchCwd：取第一个工作区根；没有工作区时如实抛错', () => {
		assert.strictEqual(resolveLaunchCwd([folder('/ws/root'), folder('/ws/other')]), '/ws/root');
		assert.throws(() => resolveLaunchCwd([]), /cwd|工作区/);
	});

	test('deriveLaunchSessionId：chatId 清洗 / preset 后缀 / 显式 id 优先', () => {
		assert.strictEqual(deriveLaunchSessionId({ chatId: 'My Chat_X' }), 'vssaros-chat-my-chat-x');
		assert.strictEqual(deriveLaunchSessionId({ chatId: 'c1', agentPreset: 'PTC' }), 'vssaros-chat-c1--ptc');
		assert.strictEqual(deriveLaunchSessionId({ sessionId: 'explicit', chatId: 'ignored' }), 'explicit');
		assert.strictEqual(deriveLaunchSessionId({}), undefined);
	});

	test('toSessionStartArgs：cwd / 派生 id / preset / 首条 prompt 完整透传', () => {
		assert.deepStrictEqual(
			toSessionStartArgs('/ws/root', { chatId: 'c1', agentPreset: 'PTC', prompt: '你好' }),
			{ cwd: '/ws/root', sessionId: 'vssaros-chat-c1--ptc', agentPreset: 'PTC', prompt: '你好' },
		);
		assert.deepStrictEqual(
			toSessionStartArgs('/ws/root', {}),
			{ cwd: '/ws/root', sessionId: undefined, agentPreset: undefined, prompt: undefined },
		);
	});

	test('toSessionRunArgs：prompt / approval / timeout 透传（deny-by-default 不被破坏）', () => {
		assert.deepStrictEqual(
			toSessionRunArgs('/ws/root', {
				prompt: '生成笔记', chatId: 'kb-build', timeoutMs: 5000,
				approval: { allow: ['read'] },
			}),
			{
				cwd: '/ws/root', prompt: '生成笔记', sessionId: 'vssaros-chat-kb-build',
				agentPreset: undefined, timeoutMs: 5000, approval: { allow: ['read'] },
				attachments: undefined,
			},
		);
	});

	test('★ toSessionRunArgs：调用方可覆盖 cwd（worktree 隔离），缺省/空串回退工作区根', () => {
		// ① 显式 cwd 优先，且不影响其它参数
		assert.deepStrictEqual(
			toSessionRunArgs('/ws/root', { prompt: '执行工作流节点', cwd: '/ws/.worktrees/task-42', timeoutMs: 9000 }),
			{
				cwd: '/ws/.worktrees/task-42', prompt: '执行工作流节点', sessionId: undefined,
				agentPreset: undefined, timeoutMs: 9000, approval: undefined,
				attachments: undefined,
			},
		);
		// ② 未给 / 空串 / 纯空白都回退到默认根（绝不能把空 cwd 传给桥，runs 会直接拒）
		for (const override of [undefined, '', '   ']) {
			assert.strictEqual(toSessionRunArgs('/ws/root', { prompt: 'x', cwd: override }).cwd, '/ws/root');
		}
	});

	test('★ toSessionRunArgs：内嵌附件完整透传（不静默丢内容）', () => {
		const atts = [{ name: 'spec.md', text: '# 规格' }, { name: 'notes.txt', text: '补充' }];
		assert.deepStrictEqual(
			toSessionRunArgs('/ws/root', { prompt: '生成笔记', attachments: atts }),
			{
				cwd: '/ws/root', prompt: '生成笔记', sessionId: undefined,
				agentPreset: undefined, timeoutMs: undefined, approval: undefined,
				attachments: atts,
			},
		);
	});

	test('★ 宿主接线：控制桥三方法在位，且 launcher 被注册、复用纯函数核心', () => {
		// ① 桥插件真的分发了这三个方法（不靠文档口头承诺）
		for (const method of ['session.start', 'session.run', 'session.cancel']) {
			assert.ok(bridgeSource.includes(`case '${method}'`), `桥插件缺少 ${method} 分发 ✗`);
		}
		// ② 宿主实现注册钩子 + 走 IDshHarnessService 的两个包装 + 复用纯函数核心
		assert.ok(hostSource.includes('setDshSessionLauncher(impl)'), '宿主必须注册中立层钩子 ✗');
		assert.ok(hostSource.includes('this.dsh.startSession('), 'start 必须走控制桥包装 ✗');
		assert.ok(hostSource.includes('this.dsh.runSession('), 'runTurn 必须走控制桥包装 ✗');
		assert.ok(hostSource.includes('toSessionStartArgs(') && hostSource.includes('toSessionRunArgs('),
			'宿主必须复用 common 纯函数核心（否则单测测不到真实拼装逻辑 ✗）');
		// ★ 取消能力：abort → 控制桥 session.cancel，且回合结束后移除监听（不泄漏）
		assert.ok(hostSource.includes('this.dsh.cancelSession('),
			'runTurn 的 signal 取消必须走控制桥 cancelSession（否则 Promise.race 超时无法中止 ✗）');
		assert.ok(hostSource.includes("removeEventListener('abort'"),
			'取消监听必须在 finally 里移除（否则 AbortSignal 上会累积闭包 ✗）');
		// ③ 工作台贡献链注册在恢复阶段
		assert.ok(contributionSource.includes('registerWorkbenchContribution2(DshSessionLauncherContribution.ID'),
			'launcher 贡献未注册 ⇒ 运行时钩子永远为空 ✗');
	});
});
