/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 商城能力（`marketplace`）的契约守卫（★ 2026-10-22）。
 *
 * 覆盖四件事：
 *  1. **白名单四处一致**：类型联合 / 常量 / 清单校验 / 执行端 —— 漏一处 ⇒ 授权/清单/执行对不上 ✗；
 *  2. **op 契约**：能力层认识的 op 集合 == 执行面认识的 op 集合（两边错开 ⇒ 点了没反应 ✗）；
 *  3. **写类 op 必须先问用户**（fail-closed）—— 界面点击没有 agent 回合 ⇒ 走 Host 审批服务会被当场拒 ✗；
 *  4. **读类 op 不问**（无副作用）✓。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { IIdeCapabilityEnv, executeIdeCapability } from '../../common/dshIdeCapabilities.js';
import { VSSAROS_IDE_CAPABILITIES, VssarosIdeCapability } from '../../common/vssarosPluginManifest.js';

/** 从 cwd 往上找仓库根。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) { return dir; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

/** 能力层的 env 夹具（只需要商城通道 + 确认框）。 */
function envOf(opts: { readonly consent?: boolean; readonly hasAction?: boolean }): IIdeCapabilityEnv {
	const consents: { title: string; detail: string }[] = [];
	const actions: unknown[] = [];
	const base = {
		activeResource: () => undefined,
		readMarkers: () => [],
		activeSelection: () => undefined,
		dashboardSummary: () => undefined,
		marketList: async () => ({ items: [], total: 0 }),
		resolvePath: () => undefined,
		exists: async () => false,
		isInsideWorkspace: () => false,
		openResource: async () => undefined,
		revealInExplorer: async () => undefined,
		openDiff: async () => undefined,
		focusTaskboard: async () => undefined,
		openWorkflow: async () => ({ id: '', name: '' }),
		executeWorkflowNode: async () => ({ output: '' }),
		requestActionConsent: async () => true,
		readCanvas: () => undefined,
		applyCanvasOps: async () => undefined,
		readTextFile: async () => undefined,
	} as unknown as IIdeCapabilityEnv;
	(base as any).confirmUserAction = async (req: { title: string; detail: string }) => {
		consents.push(req);
		return opts.consent !== false;
	};
	if (opts.hasAction !== false) {
		(base as any).marketplaceAction = async (req: unknown) => {
			actions.push(req);
			return { ok: true, total: 0, items: [] };
		};
	}
	// ★ 把两个记录数组挂到 env 上（测试要断言"问了几次 / 转发了几次"）✓
	(base as any).consents = consents;
	(base as any).actions = actions;
	return base;
}

suite('dshHarness / 商城能力（marketplace）契约', () => {

	test('★ 白名单四处一致（类型 / 常量 / 清单校验 / 执行端 case）', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const manifestSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'vssarosPluginManifest.ts'), 'utf8');
		const dispatcherSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshIdeCapabilities.ts'), 'utf8');

		// ① 类型联合里有 marketplace
		const typeUnion = /export type VssarosIdeCapability =([^;]+);/.exec(manifestSrc)?.[1] ?? '';
		assert.ok(/'marketplace'/.test(typeUnion), '类型联合 VssarosIdeCapability 缺 marketplace ✗');

		// ② 常量里有 marketplace
		assert.ok(VSSAROS_IDE_CAPABILITIES.includes('marketplace' as VssarosIdeCapability), '白名单常量缺 marketplace ✗');

		// ③ 执行端有 case
		const switchBlock = /export async function executeIdeCapability[\s\S]*?\n\}/.exec(dispatcherSrc)?.[0] ?? '';
		assert.ok(/case\s+'marketplace':/.test(switchBlock), '执行端缺 case marketplace ✗');

		// ④ 清单校验认识这个能力名（isVssarosIdeCapability 用常量表）
		assert.ok(/VSSAROS_IDE_CAPABILITIES/.test(manifestSrc), '清单校验未复用白名单常量 ✗');
	});

	test('★ 能力层与执行面的 op 集合一致（错开 ⇒ 点了没反应 ✗）', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const dispatcherSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshIdeCapabilities.ts'), 'utf8');
		const actionSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'marketplaceActionService.ts'), 'utf8');

		const dispatcherBlock = /case 'marketplace':[\s\S]*?\n\t\tdefault:/.exec(dispatcherSrc)?.[0] ?? '';
		const layerOps = new Set([...dispatcherBlock.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]));
		const actionOps = new Set([...actionSrc.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));

		assert.ok(actionOps.size >= 6, `执行面没解析出 op（拿到 ${actionOps.size} 个）✗`);
		const missing = [...actionOps].filter(op => !layerOps.has(op));
		assert.deepStrictEqual(missing, [], `执行面支持但能力层不认识的 op ✗：${missing.join(', ')}`);
	});

	test('★ 写类 op 必须先问用户（fail-closed），读类 op 不问', async () => {
		const env = envOf({ consent: true }) as any;
		await executeIdeCapability({ capability: 'marketplace', params: { op: 'list', kind: 'skill' } }, env);
		assert.strictEqual(env.consents.length, 0, '读类 op 不该弹确认框 ✗');
		assert.strictEqual(env.actions.length, 1, '读类 op 应转发给执行面 ✗');

		await executeIdeCapability({ capability: 'marketplace', params: { op: 'install', kind: 'skill', slug: 'demo' } }, env);
		assert.strictEqual(env.consents.length, 1, '写类 op 必须弹确认框 ✗');
		assert.strictEqual(env.actions.length, 2, '写类 op 应转发给执行面 ✗');
	});

	test('★ 用户拒绝 ⇒ 不执行（fail-closed）', async () => {
		const env = envOf({ consent: false }) as any;
		const res = await executeIdeCapability({ capability: 'marketplace', params: { op: 'uninstall', kind: 'skill', slug: 'demo' } }, env);
		assert.strictEqual(env.actions.length, 0, '用户拒绝了却仍然执行 ✗');
		assert.strictEqual((res as any)?.ok, false, '拒绝的回执应 ok=false ✗');
	});

	test('★ 没有确认框 ⇒ 拒绝执行（fail-closed）', async () => {
		const env = envOf({ consent: true }) as any;
		delete env.confirmUserAction;
		await assert.rejects(
			() => executeIdeCapability({ capability: 'marketplace', params: { op: 'install', kind: 'skill', slug: 'demo' } }, env),
			/confirmUserAction/,
			'没有确认框时必须 fail-closed ✗',
		);
		assert.strictEqual(env.actions.length, 0, '没问成就执行了 ✗');
	});

	test('★ 没有商城通道 ⇒ 明确报人话', async () => {
		const env = envOf({ consent: true, hasAction: false }) as any;
		await assert.rejects(
			() => executeIdeCapability({ capability: 'marketplace', params: { op: 'list' } }, env),
			/marketplaceAction/,
			'缺通道时应报人话 ✗',
		);
	});

	test('★ 不认识的 op ⇒ 明确失败（不静默成功）', async () => {
		const env = envOf({ consent: true }) as any;
		await assert.rejects(
			() => executeIdeCapability({ capability: 'marketplace', params: { op: 'teleport' } }, env),
			/op 不认识/,
			'未知 op 必须报错 ✗',
		);
	});
});
