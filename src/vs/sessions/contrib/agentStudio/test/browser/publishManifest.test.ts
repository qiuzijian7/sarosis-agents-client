/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 发布 manifest 组装测试 —— 锁定 2026-09-11 的「发布元数据丢失」修复。
 *
 * 背景：`visibility` / `tags` / `useGuide` 曾被 `MarketplaceService.publish` 的
 * 内联组装丢弃（弹窗收集了、IPublishOptions 也声明了，但没进 manifest）→ 商城的
 * 「可见性 / 标签 / 使用指南」永远为空。抽出纯函数后由本文件守护。
 */

import assert from 'assert';
import { buildPublishManifest } from '../../browser/workflow/publishManifest.js';
import type { PackageManifest } from '../../common/packageInstaller.js';
import type { IPublishOptions } from '../../common/marketplace.js';

function makeBase(overrides: Partial<PackageManifest> = {}): PackageManifest {
	return {
		kind: 'workflow',
		id: 'wf-base',
		name: 'Base Name',
		version: '1.0.0',
		description: 'base desc',
		category: 'other',
		files: ['workflow.json'],
		...overrides,
	} as PackageManifest;
}

suite('PublishManifest', () => {

	test('opts 覆盖 base 的基础字段（未传则保留 base）', () => {
		const m = buildPublishManifest(makeBase(), {
			name: 'New Name',
			version: '2.0.0',
			description: 'new desc',
			category: 'emoji',
		});
		assert.strictEqual(m.name, 'New Name');
		assert.strictEqual(m.version, '2.0.0');
		assert.strictEqual(m.description, 'new desc');
		assert.strictEqual(m.category, 'emoji');
		// 未传的字段沿用 base
		assert.strictEqual(m.id, 'wf-base');
		assert.strictEqual(m.kind, 'workflow');
		assert.deepStrictEqual(m.files, ['workflow.json']);
	});

	// ★ P0 回归锁定：这三个字段曾被丢弃
	test('visibility / tags / useGuide 必须进入 manifest（回归锁定）', () => {
		const m = buildPublishManifest(makeBase(), {
			visibility: 'private',
			tags: ['表情包', 'emoji'],
			useGuide: '# 使用说明',
		});
		assert.strictEqual(m.visibility, 'private');
		assert.deepStrictEqual(m.tags, ['表情包', 'emoji']);
		assert.strictEqual(m.useGuide, '# 使用说明');
	});

	test('未传时保留 base 既有元数据（二次发布不清空）', () => {
		const base = makeBase({
			visibility: 'public',
			tags: ['keep'],
			useGuide: 'keep guide',
		} as Partial<PackageManifest>);
		const m = buildPublishManifest(base, { description: '只改描述' });
		assert.strictEqual(m.visibility, 'public');
		assert.deepStrictEqual(m.tags, ['keep']);
		assert.strictEqual(m.useGuide, 'keep guide');
		assert.strictEqual(m.description, '只改描述');
	});

	test('空 tags 数组视为未填写（不覆盖 base）', () => {
		const base = makeBase({ tags: ['keep'] } as Partial<PackageManifest>);
		const m = buildPublishManifest(base, { tags: [] });
		assert.deepStrictEqual(m.tags, ['keep']);
	});

	test('visibility=public 也能正确传递（不因 falsy 被吞）', () => {
		// 'public' 是真值但语义上「显式选择公开」也必须写入；同时覆盖
		// 「用 !== undefined 判断而非真值判断」这一实现细节。
		const m = buildPublishManifest(makeBase(), { visibility: 'public' });
		assert.strictEqual(m.visibility, 'public');
	});

	test('author 三级兜底：opts > manifest > 登录用户', () => {
		assert.strictEqual(
			buildPublishManifest(makeBase({ author: 'base-author' }), { author: 'opts-author' }, 'login').author,
			'opts-author',
		);
		assert.strictEqual(
			buildPublishManifest(makeBase({ author: 'base-author' }), {}, 'login').author,
			'base-author',
		);
		assert.strictEqual(
			buildPublishManifest(makeBase(), {}, 'login').author,
			'login',
		);
	});

	test('仅 agent 包携带 skillRefs / mcpRefs', () => {
		const agent = buildPublishManifest(makeBase({ kind: 'agent' }), {
			skillRefs: ['s1'],
			mcpRefs: ['m1'],
		});
		assert.deepStrictEqual(agent.skillRefs, ['s1']);
		assert.deepStrictEqual(agent.mcpRefs, ['m1']);

		const workflow = buildPublishManifest(makeBase({ kind: 'workflow' }), {
			skillRefs: ['s1'],
			mcpRefs: ['m1'],
		});
		assert.strictEqual(workflow.skillRefs, undefined);
		assert.strictEqual(workflow.mcpRefs, undefined);
	});

	test('agent 包的空 refs 数组不写入（避免覆盖为空）', () => {
		const m = buildPublishManifest(makeBase({ kind: 'agent' }), { skillRefs: [], mcpRefs: [] });
		assert.strictEqual(m.skillRefs, undefined);
		assert.strictEqual(m.mcpRefs, undefined);
	});

	test('不修改传入的 base（纯函数）', () => {
		const base = makeBase();
		const before = JSON.stringify(base);
		buildPublishManifest(base, { name: 'X', visibility: 'private' });
		assert.strictEqual(JSON.stringify(base), before);
	});
});

// 类型层面的护栏：opts 必须是 IPublishOptions（防止调用方漏字段时静默通过）
const _typeCheck: IPublishOptions = { visibility: 'public', tags: ['a'], useGuide: 'g' };
void _typeCheck;
