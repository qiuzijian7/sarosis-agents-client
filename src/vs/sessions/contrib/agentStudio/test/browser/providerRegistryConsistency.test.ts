/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider 注册表一致性守卫。
 *
 * 背景：内置 provider 曾有「两套注册表各自维护」的问题 ——
 *   - `BUILTIN_BYOK_PROVIDERS`（builtInBYOKModelProvider.ts）驱动**运行时**：
 *     `BuiltInBYOKModelProvider._getBaseUrl()` 从它读 baseUrl，聊天请求实际用它；
 *   - `PROVIDER_DEFINITIONS`（views/providerView.ts）驱动**设置 UI**：
 *     卡片展示、Base URL 输入框 placeholder、连通性测试用它。
 *
 * 两套数据手工同步，已实际漂移：
 *   - gemini 的 defaultBaseUrl 不一致（UI 侧缺 `/v1beta/openai` 后缀）
 *   - custom 项在 UI 侧缺失
 * 后果是「UI 展示/测试的端点」与「聊天真实使用的端点」不同 —— 用户看到的和实际用的不是一回事。
 *
 * 修复：共享身份字段收敛到 `common/providerCatalog.ts` 单一数据源，两侧派生。
 * 本测试把该不变量固化，防止再次漂移。
 *
 * 注意：这里直接导入纯数据模块 `providerCatalog`，**不**导入 providerView
 * （后者依赖 DOM / workbench，无法在 Node 测试环境加载）。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_PROVIDER_IDENTITIES } from '../../common/providerCatalog.js';
import { BUILTIN_BYOK_PROVIDERS } from '../../browser/builtInBYOKModelProvider.js';

suite('Provider 注册表一致性（单一数据源）', () => {

	test('★ 功能注册表必须覆盖身份目录的全部 provider，且顺序一致', () => {
		const identityIds = BUILTIN_PROVIDER_IDENTITIES.map(i => i.id);
		const functionalIds = BUILTIN_BYOK_PROVIDERS.map(def => def.id);

		assert.deepStrictEqual(
			functionalIds,
			identityIds,
			`功能注册表与身份目录的 id 集合/顺序不一致。\n` +
			`  身份目录: ${identityIds.join(', ')}\n` +
			`  功能注册表: ${functionalIds.join(', ')}`,
		);
	});

	test('★ 功能注册表的身份字段必须逐字取自身份目录', () => {
		const mismatches: string[] = [];
		for (const identity of BUILTIN_PROVIDER_IDENTITIES) {
			const functional = BUILTIN_BYOK_PROVIDERS.find(def => def.id === identity.id);
			if (!functional) {
				mismatches.push(`  ${identity.id}: 功能注册表缺失`);
				continue;
			}
			if (functional.name !== identity.name) {
				mismatches.push(`  ${identity.id}.name: "${functional.name}" vs 目录 "${identity.name}"`);
			}
			if (functional.defaultBaseUrl !== identity.defaultBaseUrl) {
				mismatches.push(`  ${identity.id}.defaultBaseUrl: "${functional.defaultBaseUrl}" vs 目录 "${identity.defaultBaseUrl}"`);
			}
			if (functional.apiKeyConfigKey !== identity.apiKeyConfigKey) {
				mismatches.push(`  ${identity.id}.apiKeyConfigKey: "${functional.apiKeyConfigKey}" vs 目录 "${identity.apiKeyConfigKey}"`);
			}
			if (functional.baseUrlConfigKey !== identity.baseUrlConfigKey) {
				mismatches.push(`  ${identity.id}.baseUrlConfigKey: "${functional.baseUrlConfigKey}" vs 目录 "${identity.baseUrlConfigKey}"`);
			}
		}
		assert.strictEqual(mismatches.length, 0, `身份字段漂移：\n${mismatches.join('\n')}`);
	});

	test('★ gemini 的 defaultBaseUrl 必须带 OpenAI 兼容后缀（回归守卫）', () => {
		const gemini = BUILTIN_PROVIDER_IDENTITIES.find(i => i.id === 'gemini');
		assert.ok(gemini, 'gemini 应在身份目录中');
		assert.strictEqual(
			gemini!.defaultBaseUrl,
			'https://generativelanguage.googleapis.com/v1beta/openai',
			'gemini 的 OpenAI 兼容端点为 /v1beta/openai；缺后缀会导致 404',
		);
	});

	test('★ custom provider 必须在身份目录中（此前 UI 侧缺失）', () => {
		assert.ok(
			BUILTIN_PROVIDER_IDENTITIES.some(i => i.id === 'custom'),
			'custom 应作为内置 provider 注册（此前仅在功能侧存在）',
		);
	});

	/**
	 * UI 注册表的守卫（源码文本断言）。
	 *
	 * 为什么不用 import：providerView.ts 依赖 DOM / workbench 服务，在 Node 测试环境中
	 * 无法加载（`window is not defined`）。但「UI 侧不得自行硬编码身份字段」这条不变量
	 * 必须被守住 —— 上述 gemini 漂移正是这样产生的。故退而断言源码文本。
	 *
	 * 路径解析：测试被打包进临时 .cjs，`__dirname` 指向临时目录，故从 cwd（仓库根）解析。
	 */
	const providerViewSourcePath = path.resolve(
		process.cwd(),
		'src/vs/sessions/contrib/agentStudio/browser/views/providerView.ts',
	);

	test('★ UI 注册表不得硬编码 defaultBaseUrl（必须派生自身份目录）', () => {
		const source = fs.readFileSync(providerViewSourcePath, 'utf8');
		const start = source.indexOf('export const PROVIDER_DEFINITIONS');
		assert.ok(start >= 0, '未找到 PROVIDER_DEFINITIONS 定义');
		const block = source.slice(start, source.indexOf('\n});', start));

		const offenders = block.match(/defaultBaseUrl:\s*['"`]https?:[^'"`]*['"`]/g);
		assert.strictEqual(
			offenders, null,
			`PROVIDER_DEFINITIONS 内出现硬编码 defaultBaseUrl：${offenders?.join(', ')}\n` +
			'身份字段（含 defaultBaseUrl）必须从 BUILTIN_PROVIDER_IDENTITIES 派生 —— ' +
			'硬编码会导致「UI 连通性测试的端点」与「聊天真实使用的端点」漂移。',
		);
	});

	test('★ UI 注册表与身份目录的 id 集合必须一致（含 custom，此前缺失）', () => {
		const source = fs.readFileSync(providerViewSourcePath, 'utf8');
		// 派生写法：PROVIDER_DEFINITIONS 直接由身份目录 map 得到，id 集合天然一致。
		assert.ok(
			/export const PROVIDER_DEFINITIONS:[\s\S]{0,120}?BUILTIN_PROVIDER_IDENTITIES\.map\(/.test(source),
			'PROVIDER_DEFINITIONS 必须由 BUILTIN_PROVIDER_IDENTITIES.map(...) 派生；' +
			'若改回手写数组，UI 侧会再次漏掉 custom 等 provider。',
		);
	});

	test('身份目录内部：id 唯一、字段非空、defaultBaseUrl 为合法形态', () => {
		const seen = new Set<string>();
		for (const identity of BUILTIN_PROVIDER_IDENTITIES) {
			assert.ok(!seen.has(identity.id), `id 重复: ${identity.id}`);
			seen.add(identity.id);
			assert.ok(identity.id.trim(), 'id 不能为空');
			assert.ok(identity.name.trim(), `${identity.id}: name 不能为空`);
			assert.ok(identity.apiKeyConfigKey.trim(), `${identity.id}: apiKeyConfigKey 不能为空`);
			assert.ok(identity.baseUrlConfigKey.trim(), `${identity.id}: baseUrlConfigKey 不能为空`);
			assert.ok(identity.apiKeyConfigKey.startsWith('sessions.agentStudio.'), `${identity.id}: apiKeyConfigKey 前缀异常`);
			assert.ok(identity.baseUrlConfigKey.startsWith('sessions.agentStudio.'), `${identity.id}: baseUrlConfigKey 前缀异常`);
			// '' 是合法的（main / custom 由用户填写）；非空时必须是 http(s) URL
			if (identity.defaultBaseUrl !== '') {
				assert.ok(
					/^https?:\/\//.test(identity.defaultBaseUrl),
					`${identity.id}: defaultBaseUrl 应以 http(s):// 开头，实际 "${identity.defaultBaseUrl}"`,
				);
			}
		}
	});

	test('功能注册表内部：priority 唯一（避免排序不确定）', () => {
		const priorities = BUILTIN_BYOK_PROVIDERS.map(def => def.priority);
		assert.strictEqual(new Set(priorities).size, priorities.length, `priority 存在重复: ${priorities.join(', ')}`);
	});
});
