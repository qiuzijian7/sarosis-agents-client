/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流文件导出（纯函数层）测试 —— 2026-09-11 补齐「导出 / 导入」闭环。
 *
 * 覆盖：
 *   1. buildWorkflowExportPayload — 白名单（可迁移字段全在 / 不可迁移字段全无）
 *   2. buildWorkflowExportJson    — 产物可被 parseWorkflowImportFile **无损**读回
 *   3. workflowExportFileName     — Windows 非法字符清洗 + 空名兜底
 *
 * ★ 与 `workflowFileImport.test.ts` 的 round-trip suite 互补：那边锁「实体
 * 序列化可无损导入」，这边锁「**白名单**序列化可无损导入」，且覆盖
 * breakpoints / author / visibility —— 这三个字段此前导出带了、导入侧却不
 * 识别（静默丢失），2026-09-11 一并补齐。
 */

import assert from 'assert';
import type { IStoredWorkflow } from '../../common/workflowStorage.js';
import { parseWorkflowImportFile } from '../../browser/workflow/workflowFileImport.js';
import {
	buildWorkflowExportJson,
	buildWorkflowExportPayload,
	workflowExportFileName,
	WORKFLOW_EXPORT_EXTENSION,
} from '../../browser/workflow/workflowFileExport.js';

suite('WorkflowFileExport', () => {

	/** 完整落盘实体（含**不应迁移**的字段，用于验证白名单确实剔除它们）。 */
	function stored(): IStoredWorkflow {
		return {
			id: 'wf-emoji-pack',
			name: '表情包工作流',
			description: '一键生成静态表情包',
			presetId: 'workflow-agent',
			agentId: 'saros-claw',
			// ↓ 以下不应随文件迁移
			workspaceId: 'ws-1',
			updatedAt: 1757000000000,
			createdAt: 1756000000000,
			source: 'builtin',
			isActive: true,
			// ↑
			steps: [{ id: 's1', type: 'task' }],
			nodes: [
				{ id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: { label: '开始' } },
				{
					id: 'n1', type: 'Saros.Prompt', name: '提示', position: { x: 220, y: 40 },
					data: {
						label: '提示', prompt: '{{input}}',
						comfytv_image_refs: [{ ref: 'data:image/png;base64,AAA', slot: 'image' }],
					},
				},
			] as unknown as IStoredWorkflow['nodes'],
			connections: [{ id: 'e1', from: 'start', to: 'n1', fromPort: 'out', toPort: 'in' }] as unknown as IStoredWorkflow['connections'],
			breakpoints: ['n1'],
			version: '1.0.3',
			category: 'emoji',
			author: 'zijianqiu',
			visibility: 'public',
			tags: ['表情包', 'comfy'],
			useGuide: '# 使用指南\n1. 打开画布',
		};
	}

	// ── 1. 白名单 ────────────────────────────────────────────────────────────

	test('payload 白名单：可迁移字段全在', () => {
		const payload = buildWorkflowExportPayload(stored());
		const migratable = [
			'id', 'name', 'description', 'presetId', 'agentId', 'steps', 'nodes',
			'connections', 'breakpoints', 'version', 'category', 'author',
			'visibility', 'tags', 'useGuide',
		];
		for (const k of migratable) {
			assert.ok(k in payload, `缺少可迁移字段 ${k}`);
		}
	});

	test('payload 白名单：不可迁移字段一律不导出', () => {
		const payload = buildWorkflowExportPayload(stored());
		// workspaceId → 导入方是另一个工作区；时间戳 → 由导入侧重建；
		// source=builtin → 副本不该继承「内置」身份（否则列表显示错误角标）；
		// isActive → 激活状态由目标环境决定。
		const forbidden = ['workspaceId', 'updatedAt', 'createdAt', 'source', 'isActive'];
		for (const k of forbidden) {
			assert.ok(!(k in payload), `不应导出 ${k}`);
		}
	});

	test('payload：空值省略（不写空 breakpoints/tags/空元信息）', () => {
		const minimal = {
			id: 'wf-min', name: '最小', description: '', steps: [],
		} as unknown as IStoredWorkflow;
		const payload = buildWorkflowExportPayload(minimal);
		for (const k of ['breakpoints', 'tags', 'version', 'category', 'author', 'visibility', 'useGuide', 'presetId', 'agentId', 'nodes', 'connections']) {
			assert.ok(!(k in payload), `${k} 为空时不应写入`);
		}
		// 基础字段恒在
		assert.strictEqual(payload.id, 'wf-min');
		assert.strictEqual(payload.name, '最小');
		assert.strictEqual(payload.description, '');
		assert.deepStrictEqual(payload.steps, []);
	});

	// ── 2. round-trip（导出 → 导入无损）─────────────────────────────────────

	test('round-trip：导出 JSON → 导入解析无损（含 breakpoints/author/visibility）', () => {
		const src = stored();
		const { payload, warnings } = parseWorkflowImportFile(buildWorkflowExportJson(src));

		assert.deepStrictEqual(warnings, [], '导出产物必须是无警告的规整文件');
		assert.strictEqual(payload.sourceId, src.id);
		assert.strictEqual(payload.name, src.name);
		assert.strictEqual(payload.description, src.description);
		assert.strictEqual(payload.presetId, src.presetId);
		assert.strictEqual(payload.agentId, src.agentId);
		assert.strictEqual(payload.version, src.version);
		assert.strictEqual(payload.category, src.category);
		assert.strictEqual(payload.useGuide, src.useGuide);
		assert.deepStrictEqual(payload.tags, src.tags);
		// ★ 本轮补齐的三个字段：此前导出带上、导入侧不识别 → 静默丢失
		assert.deepStrictEqual(payload.breakpoints, src.breakpoints);
		assert.strictEqual(payload.author, src.author);
		assert.strictEqual(payload.visibility, src.visibility);
		// 画布数据逐字节保留
		assert.deepStrictEqual(payload.nodes, src.nodes);
		assert.deepStrictEqual(payload.connections, src.connections);
		assert.strictEqual(payload.steps.length, 1);
	});

	test('round-trip：导出的 JSON 文本可被再次 JSON.parse（人工可读，2 空格缩进）', () => {
		const json = buildWorkflowExportJson(stored());
		assert.ok(json.includes('\n  "id"'), '应为 2 空格缩进的可读 JSON');
		const reparsed = JSON.parse(json) as Record<string, unknown>;
		assert.strictEqual(reparsed.id, 'wf-emoji-pack');
	});

	// ── 3. 文件名 ────────────────────────────────────────────────────────────

	test('文件名：清洗 Windows 非法字符（\\ / : * ? " < > |），中文保留', () => {
		assert.strictEqual(workflowExportFileName('表情包'), `表情包${WORKFLOW_EXPORT_EXTENSION}`);
		assert.strictEqual(workflowExportFileName('a/b:c*d?e"f<g>h|i\\j'), `a-b-c-d-e-f-g-h-i-j${WORKFLOW_EXPORT_EXTENSION}`);
	});

	test('文件名：名称清洗后为空 → 回落 id → 再兜底 workflow', () => {
		assert.strictEqual(workflowExportFileName('   ', 'wf-x'), `wf-x${WORKFLOW_EXPORT_EXTENSION}`);
		assert.strictEqual(workflowExportFileName('///', 'wf-y'), `wf-y${WORKFLOW_EXPORT_EXTENSION}`);
		assert.strictEqual(workflowExportFileName('', undefined), `workflow${WORKFLOW_EXPORT_EXTENSION}`);
	});

	// ── 4. 与编辑器侧内联实现同构（webview 无法 import 本模块，靠形状对齐）──

	test('编辑器侧形状同构：白名单产物同样可无损导入（无 workspaceId/source 污染）', () => {
		// 模拟编辑器导出（webview 内联版）：画布最新态 + 元信息白名单，**无** workspaceId/source。
		const editorPayload = {
			id: 'wf-emoji-pack',
			name: '表情包工作流',
			description: '一键生成静态表情包',
			steps: [{ id: 's1' }],
			nodes: [{ id: 'n1' }],
			connections: [{ from: 'n1', to: 'n1' }],
			breakpoints: ['n1'],
			presetId: 'workflow-agent',
			agentId: 'saros-claw',
			version: '1.0.3',
			category: 'emoji',
			author: 'zijianqiu',
			visibility: 'public',
			tags: ['表情包'],
			useGuide: '# 指南',
		};
		const { payload, warnings } = parseWorkflowImportFile(JSON.stringify(editorPayload, null, 2));
		assert.deepStrictEqual(warnings, []);
		assert.deepStrictEqual(payload.breakpoints, ['n1']);
		assert.strictEqual(payload.author, 'zijianqiu');
		assert.strictEqual(payload.visibility, 'public');
		assert.strictEqual(payload.sourceId, 'wf-emoji-pack');
	});
});
