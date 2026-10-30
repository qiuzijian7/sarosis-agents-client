/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { validateProvidersSyncArgs } from '../../common/dshBridgeProtocol.js';
import { buildProvidersSyncArgs, credentialRefFor, mergeExtensionModels, providerApiFor, providerRouteFor } from '../../common/dshProviderSyncPlan.js';

suite('dshProviderSyncPlan（provider 收集整形）', () => {
	test('路由名/凭证引用名规整', () => {
		assert.strictEqual(providerRouteFor('openrouter'), 'vssaros-openrouter');
		assert.strictEqual(providerRouteFor('My Custom Provider!'), 'vssaros-my-custom-provider');
		assert.strictEqual(credentialRefFor('openrouter'), 'VSSAROS_OPENROUTER_KEY');
		assert.strictEqual(credentialRefFor('my-custom-provider'), 'VSSAROS_MY_CUSTOM_PROVIDER_KEY');
		assert.strictEqual(providerApiFor('anthropic'), 'anthropic-messages');
		assert.strictEqual(providerApiFor('openai'), 'openai-completions');
		assert.strictEqual(providerApiFor(undefined), 'openai-completions');
	});

	test('已配置的源整形成 profile + 凭证；缺 baseURL/模型的跳过', () => {
		const out = buildProvidersSyncArgs([
			{ id: 'openrouter', displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1/', credential: 'sk-or-xxx', models: [{ id: 'openai/gpt-5', name: 'GPT-5' }, { id: 'm2' }] },
			{ id: 'broken', displayName: 'Broken', baseURL: '', credential: 'k', models: [{ id: 'x' }] },
			{ id: 'nomodels', displayName: 'NoModels', baseURL: 'https://x.example.com', models: [] },
			{ id: 'ollama', displayName: 'Ollama', baseURL: 'http://127.0.0.1:11434', models: [{ id: 'qwen3' }] },
		]);
		assert.deepStrictEqual(out.skipped, ['broken', 'nomodels']);
		assert.strictEqual(out.providers.length, 2);
		const or = out.providers[0];
		assert.strictEqual(or.route, 'vssaros-openrouter');
		assert.strictEqual(or.baseURL, 'https://openrouter.ai/api/v1'); // 尾斜杠去掉
		assert.strictEqual(or.credentialRef, 'VSSAROS_OPENROUTER_KEY');
		assert.deepStrictEqual(or.models[0], { id: 'openai/gpt-5', name: 'GPT-5' });
		assert.deepStrictEqual(or.models[1], { id: 'm2', name: undefined });
		assert.deepStrictEqual(out.credentials, [{ ref: 'VSSAROS_OPENROUTER_KEY', value: 'sk-or-xxx' }]);
		// ollama 无 key → 无凭证引用
		assert.strictEqual(out.providers[1].credentialRef, undefined);
	});

	test('路由撞名时后到者跳过', () => {
		const out = buildProvidersSyncArgs([
			{ id: 'a b', displayName: 'A', baseURL: 'https://a.example.com', models: [{ id: 'm' }] },
			{ id: 'a-b', displayName: 'B', baseURL: 'https://b.example.com', models: [{ id: 'm' }] },
		]);
		assert.strictEqual(out.providers.length, 1);
		assert.strictEqual(out.skipped.length, 1);
	});

	test('产物通过跨进程负载校验', () => {
		const out = buildProvidersSyncArgs([
			{ id: 'openrouter', displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', credential: 'sk-x', models: [{ id: 'm' }] },
			{ id: 'stub', displayName: 'Stub', baseURL: 'http://127.0.0.1:8788/v1', models: [{ id: 'stub-1' }] },
		]);
		assert.ok(validateProvidersSyncArgs(out), JSON.stringify(out).slice(0, 300));
	});

	test('headers 透传与整形（codebuddy 身份头场景）', () => {
		const out = buildProvidersSyncArgs([
			{
				id: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', credential: 'tok',
				headers: { 'X-IDE-Type': 'CodeBuddyIDE', 'X-IDE-Name': 'CodeBuddyIDE', 'X-Empty': '  ' },
				models: [{ id: 'kimi-k2' }],
			},
		]);
		const cb = out.providers[0];
		assert.deepStrictEqual(cb.headers, { 'X-IDE-Type': 'CodeBuddyIDE', 'X-IDE-Name': 'CodeBuddyIDE' }); // 空值被丢弃
		assert.ok(validateProvidersSyncArgs(out));
		// 无 headers 的源不带该字段
		const plain = buildProvidersSyncArgs([{ id: 'p', displayName: 'P', baseURL: 'https://p.example.com', models: [{ id: 'm' }] }]);
		assert.strictEqual(plain.providers[0].headers, undefined);
	});

	test('负载校验拒绝脏 headers', () => {
		const base = { route: 'vssaros-a', displayName: 'x', api: 'openai-completions', baseURL: 'https://x.co', models: [{ id: 'm' }] };
		const wrap = (headers: unknown) => ({ providers: [{ ...base, headers }], credentials: [] });
		assert.ok(validateProvidersSyncArgs(wrap({ 'X-IDE-Type': 'CodeBuddyIDE' })));
		assert.ok(!validateProvidersSyncArgs(wrap({ 'Authorization': 'Bearer x' })));// 凭证头不许占用
		assert.ok(!validateProvidersSyncArgs(wrap({ 'bad name': 'v' })));
		assert.ok(!validateProvidersSyncArgs(wrap({ 'X-A': 'v\r\nInjected: 1' })));// CRLF 注入
		assert.ok(!validateProvidersSyncArgs(wrap({ 'X-A': '' })));
		assert.ok(!validateProvidersSyncArgs(wrap('not-an-object')));
	});

	test('负载校验拒绝脏输入', () => {
		assert.ok(!validateProvidersSyncArgs(undefined));
		assert.ok(!validateProvidersSyncArgs({ providers: [], credentials: [{ ref: 'OTHER_KEY', value: 'x' }] })); // 凭证必须 VSSAROS_ 前缀
		assert.ok(!validateProvidersSyncArgs({ providers: [{ route: 'evil', displayName: 'x', api: 'openai-completions', baseURL: 'https://x.co', models: [{ id: 'm' }] }], credentials: [] })); // 路由必须 vssaros- 前缀
		assert.ok(!validateProvidersSyncArgs({ providers: [{ route: 'vssaros-a', displayName: 'x', api: 'openai-completions', baseURL: 'http://evil.example.com', models: [{ id: 'm' }] }], credentials: [] })); // http 只允许 localhost
		assert.ok(!validateProvidersSyncArgs({ providers: [{ route: 'vssaros-a', displayName: 'x', api: 'openai-completions', baseURL: 'https://x.co', models: [] }], credentials: [] })); // 模型非空
	});
});

/**
 * 扩展登录态 provider（codebuddy）的模型清单合并 —— 锁住"注册表 ∪ 扩展命令"的优先级，
 * 防止再次退化成"只用扩展命令、注册表兜底是死代码"（`codebuddy` vs 注册表 `lm:codebuddy` 的 id 错配）。
 */
suite('mergeExtensionModels（扩展源模型清单合并）', () => {
	test('注册表在前、命令补齐并去重（顺序稳定）', () => {
		const out = mergeExtensionModels(
			[{ id: 'glm-5.2-ioa', name: 'GLM-5.2' }, { id: 'kimi-k2' }],
			[{ id: 'kimi-k2', name: 'Kimi K2' }, { id: 'hy4' }],
		);
		assert.deepStrictEqual(out, [
			{ id: 'glm-5.2-ioa', name: 'GLM-5.2' },
			{ id: 'kimi-k2', name: 'Kimi K2' },   // 命令侧补上了注册表缺的显示名
			{ id: 'hy4' },                         // 命令侧独有的模型也保留
		]);
	});

	test('命令侧显式 reasoning 优先（注册表经 LM API 会丢能力位）', () => {
		const out = mergeExtensionModels([{ id: 'a' }, { id: 'b', reasoning: true }], [{ id: 'a', reasoning: true }, { id: 'b' }]);
		assert.deepStrictEqual(out, [{ id: 'a', reasoning: true }, { id: 'b', reasoning: true }]);
	});

	test('注册表为空时命令清单兜底（服务时序/超时不再让整源消失）', () => {
		assert.deepStrictEqual(mergeExtensionModels([], [{ id: 'm1' }]), [{ id: 'm1' }]);
		assert.deepStrictEqual(mergeExtensionModels([], undefined), []);
	});

	test('脏输入（缺 id）被忽略，不产生空条目', () => {
		const out = mergeExtensionModels([{ id: '' }, { id: 'ok' }], [{ id: '' }, { id: 'ok2' }]);
		assert.deepStrictEqual(out, [{ id: 'ok' }, { id: 'ok2' }]);
	});

	test('effort（平台推荐档位）透传：注册表侧没有、以命令侧为准，且不写空键', () => {
		// 合并：注册表那条经 VS Code LM API 拿不到 effort ⇒ 保留命令侧那份。
		const merged = mergeExtensionModels([{ id: 'a', reasoning: true }], [{ id: 'a', reasoning: true, effort: 'medium' }]);
		assert.deepStrictEqual(merged, [{ id: 'a', reasoning: true, effort: 'medium' }]);
		// 整形后仍带着（桥侧据此算**路由级**默认档位；pi-ai 没有模型级默认档位）。
		const args = buildProvidersSyncArgs([{
			id: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', credential: 'tok',
			models: [{ id: 'a', reasoning: true, effort: 'high' }, { id: 'b', reasoning: true }],
		}]);
		assert.strictEqual(args.providers[0].models[0].effort, 'high');
		assert.strictEqual('effort' in args.providers[0].models[1], false, '无推荐档位不得写空键');
	});

	test('模型上限 200（= 跨进程校验硬上限；此前 100 会静默丢尾部模型）', () => {
		const many = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}` }));
		const out = buildProvidersSyncArgs([{ id: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', credential: 'tok', models: many }]);
		assert.strictEqual(out.providers[0].models.length, 200);
		assert.strictEqual(out.providers[0].models[199].id, 'm199');
		assert.ok(validateProvidersSyncArgs(out));
	});

	// ── 2026-10-30 回归：图像能力位必须穿过同步链路 ─────────────────────

	test('★★ 回归：`supportsImages` 必须一路传到 sync 负载（此前被整个丢弃）', () => {
		// 现场：codebuddy 列表里 `images: true`，dsh 侧却报「does not declare image input support」。
		// 根因就是 `_modelsOf` / buildProvidersSyncArgs 只透传 reasoning，图像位在中途消失。
		const args = buildProvidersSyncArgs([{
			id: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', credential: 'tok',
			models: [{ id: 'vision-model', supportsImages: true }, { id: 'text-model' }],
		}]);
		assert.strictEqual(args.providers[0].models[0].supportsImages, true,
			'声明了图像能力就必须带出去（否则 dsh 一律当纯文本）');
		assert.strictEqual('supportsImages' in args.providers[0].models[1], false,
			'未声明时不得写空键（缺省即纯文本）');
		// 跨进程校验仍然接受这个负载
		assert.ok(validateProvidersSyncArgs(args));
	});

	test('★★ 图像能力合并取并集（任一侧声明即为真，不因另一侧缺失而抹掉）', () => {
		// 注册表侧有（LM 元数据可信）、命令侧没有 ⇒ 必须保留
		assert.deepStrictEqual(
			mergeExtensionModels([{ id: 'a', supportsImages: true }], [{ id: 'a' }]),
			[{ id: 'a', supportsImages: true }],
		);
		// 反之亦然
		assert.deepStrictEqual(
			mergeExtensionModels([{ id: 'a' }], [{ id: 'a', supportsImages: true }]),
			[{ id: 'a', supportsImages: true }],
		);
		// 两侧都没有 ⇒ 不产生该键
		assert.deepStrictEqual(mergeExtensionModels([{ id: 'a' }], [{ id: 'a' }]), [{ id: 'a' }]);
	});

	test('★ 图像位与 reasoning / effort 互不干扰（同时透传）', () => {
		const merged = mergeExtensionModels(
			[{ id: 'a', reasoning: true, supportsImages: true }],
			[{ id: 'a', effort: 'high' }],
		);
		assert.deepStrictEqual(merged, [{ id: 'a', reasoning: true, supportsImages: true, effort: 'high' }]);
	});

	// ── 2026-10-30 回归：上下文长度必须穿过同步链路 ─────────────────────

	test('★★ 回归：`contextWindow` / `maxTokens` 必须一路传到 sync 负载（此前整个丢失）', () => {
		// 现场：dsh 侧一直用 pi-ai 缺省窗口，压缩阈值按错窗口算。
		const args = buildProvidersSyncArgs([{
			id: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', credential: 'tok',
			models: [{ id: 'big', contextWindow: 192_000, maxTokens: 32_000 }, { id: 'plain' }],
		}]);
		assert.strictEqual(args.providers[0].models[0].contextWindow, 192_000);
		assert.strictEqual(args.providers[0].models[0].maxTokens, 32_000);
		assert.strictEqual('contextWindow' in args.providers[0].models[1], false, '未声明时不得写空键');
		assert.ok(validateProvidersSyncArgs(args));
	});

	test('★★ 容量位只收正有限数（0/NaN/Infinity 不得覆盖 pi-ai 默认）', () => {
		// 写 0 比不写更糟：会把「零上下文」当头。这里统一挡掉。
		const bad = mergeExtensionModels(
			[{ id: 'a', contextWindow: 0, maxTokens: Number.NaN }],
			[{ id: 'a' }],
		);
		assert.deepStrictEqual(bad, [{ id: 'a' }]);

		const args = buildProvidersSyncArgs([{
			id: 'p', displayName: 'P', baseURL: 'https://x.co', credential: 'tok',
			models: [{ id: 'm', contextWindow: Number.POSITIVE_INFINITY, maxTokens: -1 }],
		}]);
		assert.strictEqual('contextWindow' in args.providers[0].models[0], false);
		assert.strictEqual('maxTokens' in args.providers[0].models[0], false);
	});

	test('★ 容量位合并：命令侧（平台目录）优先，缺了才回落注册表', () => {
		// 平台目录是权威（逐模型给 maxInput/maxOutput）；注册表经 LM API 未必带。
		assert.deepStrictEqual(
			mergeExtensionModels([{ id: 'a', contextWindow: 128_000 }], [{ id: 'a', contextWindow: 192_000 }]),
			[{ id: 'a', contextWindow: 192_000 }],
		);
		// 命令侧没有 ⇒ 保住注册表那份
		assert.deepStrictEqual(
			mergeExtensionModels([{ id: 'a', contextWindow: 128_000 }], [{ id: 'a' }]),
			[{ id: 'a', contextWindow: 128_000 }],
		);
		// 命令侧是脏值（0）⇒ 回落注册表
		assert.deepStrictEqual(
			mergeExtensionModels([{ id: 'a', contextWindow: 128_000 }], [{ id: 'a', contextWindow: 0 }]),
			[{ id: 'a', contextWindow: 128_000 }],
		);
	});
});
