/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点编辑器描述符测试（2026-09-13，P1）。
 *
 * 被守护的不变量：
 *   1. `STAGE_EDITOR_META` **恰好覆盖** `STAGE_EDITOR_KIND` 用到的所有非 'none' kind
 *      —— 漏一项（新节点接了编辑器却忘记声明承载方式）或多项（写了没人用的 kind）
 *      都会失败；
 *   2. `stageEditorDescriptor()` 的 kind 必须与 `stageEditorKind()` 完全一致
 *      （两张表不能各说各话）；
 *   3. `canFullscreenStage()` 的语义边界（loader 不声明全屏、无编辑器节点恒 false）。
 */

import assert from 'assert';
import {
	STAGE_EDITOR_KIND,
	STAGE_EDITOR_META,
	stageEditorDescriptor,
	canFullscreenStage,
	stageEditorKind,
} from '../../webview/src/features/workflowEditor/comfyHost/stageCardRegistry.js';

/** STAGE_EDITOR_KIND 实际用到的非 'none' kind 集合。 */
function kindsInUse(): Set<string> {
	const s = new Set<string>();
	for (const kind of Object.values(STAGE_EDITOR_KIND)) {
		if (kind !== 'none') { s.add(kind); }
	}
	return s;
}

suite('NodeEditorDescriptor', () => {

	// ── 1. 覆盖完整性（双向）────────────────────────────────────────────────

	test('STAGE_EDITOR_META 恰好覆盖 STAGE_EDITOR_KIND 用到的所有 kind（无遗漏）', () => {
		const declared = new Set(Object.keys(STAGE_EDITOR_META));
		const missing = [...kindsInUse()].filter(k => !declared.has(k));
		assert.deepStrictEqual(
			missing, [],
			`以下 kind 已被节点使用但未在 STAGE_EDITOR_META 声明（新增节点编辑器时必须同时声明承载方式）：${missing.join(', ')}`,
		);
	});

	test('STAGE_EDITOR_META 没有多余条目（除联合类型中的历史 kind）', () => {
		const used = kindsInUse();
		// ★ 已知例外：'mask' 在 StageEditorKind 联合类型里保留，但 STAGE_EDITOR_KIND
		//   未登记任何节点 —— MaskPainter（Erase / Inpaint）实际由 nodeCard 的
		//   `isMaskEdit` 独立判定渲染（nodeCard.tsx:3513），**不走 kind 表**。
		//   保留该 kind 是为未来把 mask 编辑器统一进描述符体系；在此之前它只是
		//   「联合类型里的占位」。此处显式登记例外，避免被误判为漏登记。
		const HISTORICAL_KINDS = new Set(['mask']);
		const extra = [...Object.keys(STAGE_EDITOR_META)].filter(k => !used.has(k) && !HISTORICAL_KINDS.has(k));
		assert.deepStrictEqual(extra, [], `以下 kind 在 STAGE_EDITOR_META 声明但没有任何节点使用：${extra.join(', ')}`);
	});

	// ── 2. 字段合法性 ───────────────────────────────────────────────────────

	test('每条描述符的字段合法（title 非空 / host 合法 / fullscreen 为布尔）', () => {
		for (const [kind, meta] of Object.entries(STAGE_EDITOR_META)) {
			assert.ok(meta.title && meta.title.trim().length > 0, `${kind}: title 不能为空`);
			assert.ok(
				meta.host === 'react' || meta.host === 'iframe',
				`${kind}: host 必须是 'react' | 'iframe'（实际 ${String(meta.host)}）`,
			);
			assert.strictEqual(typeof meta.fullscreen, 'boolean', `${kind}: fullscreen 必须是布尔`);
			// iframe 承载（B 类外部应用）必须提供 URL 解析器，否则独立窗口无从加载
			if (meta.host === 'iframe') {
				assert.strictEqual(typeof meta.resolveUrl, 'function', `${kind}: host='iframe' 时必须提供 resolveUrl`);
			}
		}
	});

	// ── 3. 两张表一致性 ─────────────────────────────────────────────────────

	test('stageEditorDescriptor().kind 与 stageEditorKind() 完全一致（逐节点）', () => {
		for (const nodeType of Object.keys(STAGE_EDITOR_KIND)) {
			const viaFn = stageEditorKind(nodeType);
			const desc = stageEditorDescriptor(nodeType);
			if (viaFn === 'none') {
				assert.strictEqual(desc, undefined, `${nodeType}: kind='none' 不应有描述符`);
			} else {
				assert.ok(desc, `${nodeType}: 有 kind 就必须能取到描述符`);
				assert.strictEqual(desc!.kind, viaFn, `${nodeType}: 描述符 kind 与 stageEditorKind() 不一致`);
			}
		}
	});

	test('未注册 / 空类型 → undefined（安全默认）', () => {
		assert.strictEqual(stageEditorDescriptor(undefined), undefined);
		assert.strictEqual(stageEditorDescriptor(''), undefined);
		assert.strictEqual(stageEditorDescriptor('ComfyTV.NotExistStage'), undefined);
		assert.strictEqual(stageEditorDescriptor('LoadImage')!.kind, 'image');   // 已注册的 native 节点
	});

	// ── 4. canFullscreenStage 语义 ──────────────────────────────────────────

	test('canFullscreenStage：导演台 true（已有全屏渲染路径）', () => {
		assert.strictEqual(canFullscreenStage('ComfyTV.StoryboardEditorStage'), true);
	});

	test('canFullscreenStage：loader 类为 false（放大无收益）', () => {
		assert.strictEqual(canFullscreenStage('ComfyTV.ImageLoaderStage'), false);
		assert.strictEqual(canFullscreenStage('LoadImage'), false);
		assert.strictEqual(canFullscreenStage('image-loader'), false);
	});

	test('canFullscreenStage：无内嵌编辑器的节点恒 false', () => {
		// ComfyTV.ImageStage 有最小高度（640）但**没有**内嵌编辑器 → 不能声明全屏
		assert.strictEqual(canFullscreenStage('ComfyTV.ImageStage'), false);
		assert.strictEqual(canFullscreenStage(undefined), false);
		assert.strictEqual(canFullscreenStage('ComfyTV.NotExistStage'), false);
	});

	test('当前只有导演台具备全屏渲染路径 —— 声明 fullscreen 的集合应等于预期', () => {
		// ★ 这条是「声明意图」与「已实现」的对账：若把 fullscreen 改为 true 但没实现
		//   渲染分支，按钮点了会是空浮层。新增全屏支持时请同步更新本期望值。
		const fullscreenKinds = Object.entries(STAGE_EDITOR_META)
			.filter(([, m]) => m.fullscreen)
			.map(([k]) => k)
			.sort();
		assert.deepStrictEqual(fullscreenKinds, [
			'animated-emoji', 'colorGrade', 'crop', 'directorConsole', 'emoji-static',
			'gridSplit', 'kenBurns', 'mask', 'material', 'multiangle', 'outpaint',
			'panorama', 'relight', 'transform',
		]);
		// 反例：image 必须为 false
		assert.strictEqual(STAGE_EDITOR_META.image.fullscreen, false);
	});
});
