/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 守卫：**已被 dsh 侧接管的 op 不许再走 IDE 反向调用**（★ 2026-10-22）。
 *
 * 背景：商城能力按 S1/S2/S2c 搬进 dsh 侧后，IDE 侧的 `runMarketplaceAction` 里那些分支
 *   就成了"死代码"。死代码本身不危险，**危险的是它还可能被执行**：
 *   两套逻辑都活着时，谁都不知道实际生效的是哪一套（台账、备份、落点语义还都不一样）✗
 *   ⇒ 入口加了下线闸，本守卫钉住它：
 *     · `list` / `detail` / `installed` / `publish` / `delete*` ⇒ **必须抛错**
 *     · `skill` / `workflow` 的 install/uninstall/upgrade ⇒ **必须抛错**
 *     · `agent` / `workbench` 的 install/uninstall/upgrade ⇒ **必须放行**（这两类 IDE 才做得了）
 *
 * 反向突变：把下线闸删掉 ⇒ 本守卫变红 ✓
 */

import * as assert from 'assert';

import { runMarketplaceAction, type IMarketplaceActionHost, type IMarketplaceActionRequest } from '../../browser/marketplaceActionService.js';

/** 最小假宿主：任何真实调用都算失败（本测试只关心"闸门是否先拦住"）。 */
function fakeHost(calls: string[]): IMarketplaceActionHost {
	const boom = (label: string) => {
		calls.push(label);
		throw new Error(`不该走到真实实现：${label}`);
	};
	return {
		marketplace: {
			ensureLoggedIn: async () => { boom('ensureLoggedIn'); },
			listPackages: async () => { boom('listPackages'); },
			getPackage: async () => { boom('getPackage'); },
			getInstalled: async () => { boom('getInstalled'); },
			checkUpgrades: async () => { boom('checkUpgrades'); },
		} as unknown as IMarketplaceActionHost['marketplace'],
		installPluginSpec: async () => { boom('installPluginSpec'); },
		installExternalTarball: async () => { boom('installExternalTarball'); },
		removePlugin: async () => { boom('removePlugin'); },
		logService: { info: () => { }, warn: () => { }, error: () => { }, trace: () => { }, debug: () => { } } as unknown as IMarketplaceActionHost['logService'],
	};
}

/** 跑一次，返回抛出的错误消息（没抛就是空串）。 */
async function throwsOf(req: IMarketplaceActionRequest): Promise<string> {
	const calls: string[] = [];
	try {
		await runMarketplaceAction(fakeHost(calls), req);
		return '';
	} catch (e) {
		// 必须抛在"下线闸"（文案含"已由 dsh 侧自持"），不能是别的原因 ✓
		const msg = String((e as Error)?.message ?? e);
		assert.strictEqual(calls.length, 0, `闸门没拦住，真实实现被调用了：${calls.join(', ')}`);
		return msg;
	}
}

suite('marketplace 下线闸（已被 dsh 侧接管的 op 不许再走 IDE）', () => {

	test('只读面：list / detail / installed 必须被拒（dsh 侧自持）', async () => {
		for (const op of ['list', 'detail', 'installed'] as const) {
			const msg = await throwsOf({ op });
			assert.ok(msg.includes('已由 dsh 侧自持'), `${op} 应被下线闸拒绝，实际：${msg || '(没抛错)'}`);
		}
	});

	test('下架：deletePackage / deleteVersion 必须被拒（纯 HTTP，不分 kind）', async () => {
		for (const op of ['deletePackage', 'deleteVersion'] as const) {
			const msg = await throwsOf({ op, slug: 'x', version: '1.0.0' });
			assert.ok(msg.includes('已由 dsh 侧自持'), `${op} 应被下线闸拒绝，实际：${msg || '(没抛错)'}`);
		}
	});

	test('发布：skill / workflow 必须被拒；**agent 必须放行**（包格式 agent.json 只有 IDE 会组装）', async () => {
		for (const kind of ['skill', 'workflow']) {
			const msg = await throwsOf({ op: 'publish', kind, localId: 'x', version: '1.0.0' });
			assert.ok(msg.includes('已由 dsh 侧自持'), `${kind} 的 publish 应被拒，实际：${msg || '(没抛错)'}`);
		}
		let agentMsg = '';
		try {
			await runMarketplaceAction(fakeHost([]), { op: 'publish', kind: 'agent', localId: 'x', version: '1.0.0' });
		} catch (e) {
			agentMsg = String((e as Error)?.message ?? e);
		}
		assert.ok(
			!agentMsg.includes('已由 dsh 侧自持'),
			`agent 的 publish 被误拦了（它必须留在 IDE：包格式是 agent.json）：${agentMsg}`,
		);
	});

	test('skill / workflow 的装升卸必须被拒（dsh 侧直接落数据根）', async () => {
		for (const kind of ['skill', 'workflow']) {
			for (const op of ['install', 'upgrade', 'uninstall'] as const) {
				const msg = await throwsOf({ op, kind, slug: 'x' });
				assert.ok(msg.includes('已由 dsh 侧自持'), `${kind}/${op} 应被下线闸拒绝，实际：${msg || '(没抛错)'}`);
			}
		}
	});

	test('agent / workbench 的装升卸**必须放行**（IDE 才做得了：.agent.md 序列化 / dsh plugin add）', async () => {
		// 这两类会走到真实实现 ⇒ 假宿主抛"不该走到真实实现" ⇒ 用它来证明"闸门放行了" ✓
		for (const kind of ['agent', 'workbench']) {
			for (const op of ['install', 'uninstall'] as const) {
				let msg = '';
				try {
					await runMarketplaceAction(fakeHost([]), { op, kind, slug: 'x' });
				} catch (e) {
					msg = String((e as Error)?.message ?? e);
				}
				assert.ok(
					!msg.includes('已由 dsh 侧自持'),
					`${kind}/${op} 被下线闸误拦了（它必须留在 IDE 侧）：${msg}`,
				);
			}
		}
	});
});
