/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流文件导入（纯函数层）测试 —— 2026-09-11 补齐「本地文件导入」缺口。
 *
 * 覆盖：
 *   1. parseWorkflowImportFile   — 正常解析 / 各类非法输入 / 宽容策略（字段类型不符）
 *   2. sanitizeWorkflowSlug      — slug 归一（必须与 workflowStorageService 同规则）
 *   3. resolveImportSlug         — 源 id 沿用 / 冲突消解（绝不覆盖已有工作流）
 */

import assert from 'assert';
import {
	parseWorkflowImportFile,
	sanitizeWorkflowSlug,
	resolveImportSlug,
} from '../../browser/workflow/workflowFileImport.js';

suite('WorkflowFileImport', () => {

	// ── 1. parseWorkflowImportFile ───────────────────────────────────────────

	test('parse: 完整工作流 JSON → 载荷字段齐全', () => {
		const text = JSON.stringify({
			id: 'wf-my-flow',
			name: '我的工作流',
			description: 'desc',
			presetId: 'preset-1',
			agentId: 'claw',
			steps: [{ id: 's1' }],
			nodes: [{ id: 'n1' }, { id: 'n2' }],
			connections: [{ from: 'n1', to: 'n2' }],
			version: '1.2.3',
			category: 'emoji',
			tags: ['a', 'b', 3],
			useGuide: '# 用法',
		});
		const { payload, warnings } = parseWorkflowImportFile(text);

		assert.strictEqual(payload.name, '我的工作流');
		assert.strictEqual(payload.description, 'desc');
		assert.strictEqual(payload.presetId, 'preset-1');
		assert.strictEqual(payload.agentId, 'claw');
		assert.strictEqual(payload.sourceId, 'wf-my-flow');
		assert.strictEqual(payload.nodes!.length, 2);
		assert.strictEqual(payload.connections!.length, 1);
		assert.strictEqual(payload.steps.length, 1);
		assert.strictEqual(payload.version, '1.2.3');
		assert.strictEqual(payload.category, 'emoji');
		// 非字符串 tag 被过滤
		assert.deepStrictEqual(payload.tags, ['a', 'b']);
		assert.strictEqual(payload.useGuide, '# 用法');
		assert.deepStrictEqual(warnings, []);
	});

	test('parse: 空文件 → 抛错', () => {
		assert.throws(() => parseWorkflowImportFile('   '), /文件为空/);
	});

	test('parse: 非法 JSON → 抛错（消息含 JSON 解析失败）', () => {
		assert.throws(() => parseWorkflowImportFile('{ not json'), /JSON 解析失败/);
	});

	test('parse: 顶层为数组 → 抛错', () => {
		assert.throws(() => parseWorkflowImportFile('[1,2,3]'), /顶层应为 JSON 对象/);
	});

	test('parse: 无工作流特征字段 → 抛错（避免任意 JSON 被当工作流导入）', () => {
		assert.throws(() => parseWorkflowImportFile('{"foo":1}'), /缺少 name \/ id \/ nodes/);
	});

	test('parse: name 缺失 → 回落 id，再回落默认名，并记 warning', () => {
		const byId = parseWorkflowImportFile(JSON.stringify({ id: 'wf-x', nodes: [{ id: 'n' }] }));
		assert.strictEqual(byId.payload.name, 'wf-x');
		assert.ok(byId.warnings.some(w => /未提供有效名称/.test(w)));

		const fallback = parseWorkflowImportFile(JSON.stringify({ nodes: [{ id: 'n' }] }));
		assert.strictEqual(fallback.payload.name, '导入的工作流');
	});

	test('parse: nodes 非数组 → 忽略该字段 + warning（宽容，不整体失败）', () => {
		const { payload, warnings } = parseWorkflowImportFile(
			JSON.stringify({ name: 'W', nodes: 'oops', connections: [{ from: 'a', to: 'b' }] }),
		);
		assert.strictEqual(payload.nodes, undefined);
		assert.strictEqual(payload.connections!.length, 1);
		assert.ok(warnings.some(w => /nodes 字段不是数组/.test(w)));
	});

	test('parse: nodes 为空数组 → 仍可导入，但提示画布会空白', () => {
		const { payload, warnings } = parseWorkflowImportFile(JSON.stringify({ name: 'W', nodes: [], connections: [] }));
		assert.strictEqual(payload.nodes!.length, 0);
		assert.ok(warnings.some(w => /没有节点数据/.test(w)));
		assert.ok(warnings.some(w => /没有连线数据/.test(w)));
	});

	// ── 2. sanitizeWorkflowSlug ─────────────────────────────────────────────

	test('slug: 归一化与 workflowStorageService 同规则', () => {
		assert.strictEqual(sanitizeWorkflowSlug('My Workflow'), 'my-workflow');
		// 非法字符逐个替换为 '-'，随后 `-+` 折叠为单个连字符（下划线/空格各折叠一次）。
		assert.strictEqual(sanitizeWorkflowSlug('a__b  c'), 'a-b-c');
		assert.strictEqual(sanitizeWorkflowSlug('--Edge--'), 'edge');
		assert.strictEqual(sanitizeWorkflowSlug('中文名'), '');
	});

	// ── 3. resolveImportSlug ────────────────────────────────────────────────

	test('slug: 源 id 无冲突 → 沿用（去 wf- 前缀）', () => {
		assert.strictEqual(resolveImportSlug('wf-my-flow', '任意名', new Set()), 'my-flow');
	});

	test('slug: 源 id 已存在 → 生成 -imported-2（绝不覆盖）', () => {
		const existing = new Set(['wf-my-flow']);
		assert.strictEqual(resolveImportSlug('wf-my-flow', 'X', existing), 'my-flow-imported-2');
	});

	test('slug: 连续冲突 → 递增到 -imported-3', () => {
		const existing = new Set(['wf-my-flow', 'wf-my-flow-imported-2']);
		assert.strictEqual(resolveImportSlug('wf-my-flow', 'X', existing), 'my-flow-imported-3');
	});

	test('slug: 无源 id → 用名称派生；名称无法 slug 化 → workflow 兜底', () => {
		assert.strictEqual(resolveImportSlug(undefined, 'My Flow', new Set()), 'my-flow');
		assert.strictEqual(resolveImportSlug(undefined, '中文名', new Set()), 'workflow');
	});

	test('slug: 源 id 非 wf- 前缀也接受（外部导出）', () => {
		assert.strictEqual(resolveImportSlug('custom-flow', 'X', new Set()), 'custom-flow');
	});
});

// ── 4. 导出 ↔ 导入 round-trip（契约锁定，2026-09-11）─────────────────────────
//
// 编辑器「⤴ 导出 → 工作流 JSON 文件」的产出 = 完整 `IStoredWorkflow` 序列化
// （webview 侧合并「画布最新态」与「初始实体元信息」）。导入侧必须能**无损**
// 读回 —— 否则「导出即备份/分享」是假闭环（拿到文件导不回来）。
//
// 本 suite 用真实形状的实体锁定该契约：任何一侧字段漂移（例如给
// `IStoredWorkflow` 新增元信息却没在导入侧识别）都会在这里失败。

suite('WorkflowFileExport ↔ Import round-trip', () => {

	const storedWorkflow = {
		id: 'wf-emoji-pack',
		name: '表情包工作流',
		description: '一键生成静态表情包',
		presetId: 'workflow-agent',
		agentId: 'saros-claw',
		workspaceId: 'ws-1',
		steps: [{ id: 's1', type: 'task' }],
		nodes: [
			{ id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: { label: '开始' } },
			{
				id: 'n1', type: 'Saros.Prompt', name: '提示', position: { x: 220, y: 40 },
				data: {
					label: '提示', prompt: '{{input}}',
					// 资产引用（复杂内嵌结构）必须逐字节保留
					comfytv_image_refs: [{ ref: 'data:image/png;base64,AAA', slot: 'image' }],
				},
			},
		],
		connections: [{ id: 'e1', from: 'start', to: 'n1', fromPort: 'out', toPort: 'in' }],
		breakpoints: ['n1'],
		version: '1.0.3',
		category: 'emoji',
		author: 'zijianqiu',
		tags: ['表情包', 'comfy'],
		useGuide: '# 使用指南\n1. 打开画布',
		updatedAt: 1757000000000,
	};

	test('导出的工作流实体 → 导入解析无损（画布 + 元信息全保留）', () => {
		const { payload, warnings } = parseWorkflowImportFile(JSON.stringify(storedWorkflow, null, 2));

		// 导出产物是「规整」文件（name/nodes/connections 齐全）→ 不应有任何提示
		assert.deepStrictEqual(warnings, []);

		// 元信息
		assert.strictEqual(payload.sourceId, storedWorkflow.id);
		assert.strictEqual(payload.name, storedWorkflow.name);
		assert.strictEqual(payload.description, storedWorkflow.description);
		assert.strictEqual(payload.presetId, storedWorkflow.presetId);
		assert.strictEqual(payload.agentId, storedWorkflow.agentId);
		assert.strictEqual(payload.version, storedWorkflow.version);
		assert.strictEqual(payload.category, storedWorkflow.category);
		assert.deepStrictEqual(payload.tags, storedWorkflow.tags);
		assert.strictEqual(payload.useGuide, storedWorkflow.useGuide);
		assert.strictEqual(payload.steps.length, 1);

		// 画布数据逐字节保留（含节点 data 内嵌的资产引用）
		assert.deepStrictEqual(payload.nodes, storedWorkflow.nodes);
		assert.deepStrictEqual(payload.connections, storedWorkflow.connections);
	});

	test('导出产物再导入 → 首次沿用源 id，重复导入走 -imported-N（不覆盖）', () => {
		const { payload } = parseWorkflowImportFile(JSON.stringify(storedWorkflow));
		// 本地无同名 → 沿用源 id 派生 slug
		assert.strictEqual(resolveImportSlug(payload.sourceId, payload.name, new Set()), 'emoji-pack');
		// 再次导入 → 绝不覆盖，生成副本
		assert.strictEqual(
			resolveImportSlug(payload.sourceId, payload.name, new Set(['wf-emoji-pack'])),
			'emoji-pack-imported-2',
		);
	});

	test('最小导出产物也必须命中特征字段识别（不会导出一个导不回来的文件）', () => {
		// 「导出即导入逆操作」的下限保证：即便元信息全空，只要 nodes 在就可导入。
		const minimal = { id: 'wf-min', name: '最小', nodes: [{ id: 'n' }], connections: [] };
		const { payload } = parseWorkflowImportFile(JSON.stringify(minimal));
		assert.strictEqual(payload.sourceId, 'wf-min');
		assert.strictEqual(payload.nodes!.length, 1);
	});
});
