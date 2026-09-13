/*---------------------------------------------------------------------------------------------
 *  Unit test: 聊天卡「节点描述符」推导（图标 + 副标题，2026-09-13）。
 *
 *  ★ 本文件的核心价值是**护栏**：`iconForStageKind` 按 kind **子串**匹配，新增一类
 *    stage kind 时若忘记补规则，图标会**静默退化**为引擎兜底 ⚙️（实测曾有 4 种未命中：
 *    material / model / storyboard / timeline）。下方第一条测试遍历生成表的**全部**
 *    kind 断言「必须命中」→ 新增 kind 时此测试直接失败 → 强制补规则 ✓。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { COMFYTV_STAGE_META } from '../../webview/src/features/workflowEditor/comfyHost/comfyTVStageMeta.generated.js';
import {
	CARD_ICON_BY_ENGINE,
	CARD_ICON_FALLBACK,
	describeCardNode,
	iconForStageKind,
} from '../../browser/workflow/cardDescriptor.js';

suite('聊天卡节点描述符（cardDescriptor）', () => {

	suite('图标：stage kind 覆盖率（★ 新增 kind 的护栏）', () => {

		test('★★ COMFYTV_STAGE_META 的每一种 kind 都必须命中图标', () => {
			const kinds = [...new Set(COMFYTV_STAGE_META.map(m => m.kind))];
			assert.ok(kinds.length > 0, '生成表应非空（否则本护栏形同虚设）');
			const missing = kinds.filter(k => !iconForStageKind(k));
			assert.deepStrictEqual(
				missing, [],
				`以下 kind 未命中图标 → 请在 cardDescriptor.iconForStageKind 补子串规则: ${missing.join(', ')}`,
			);
		});

		test('★ 每个 stage 的图标都命中（非空且不等于兜底 ⚙️）', () => {
			const degraded: string[] = [];
			for (const m of COMFYTV_STAGE_META) {
				const icon = iconForStageKind(m.kind);
				if (!icon || icon === CARD_ICON_FALLBACK) { degraded.push(`${m.nodeId}(${m.kind})`); }
			}
			assert.deepStrictEqual(degraded, [], `以下 stage 图标退化: ${degraded.join(', ')}`);
		});

		test('语义子串匹配（picker / video / audio / text / image / panorama / project）', () => {
			assert.strictEqual(iconForStageKind('image-picker'), '🎯');
			assert.strictEqual(iconForStageKind('video-picker'), '🎯');
			assert.strictEqual(iconForStageKind('video'), '🎬');
			assert.strictEqual(iconForStageKind('image-batch'), '🖼️');
			assert.strictEqual(iconForStageKind('speech'), '🎵');
			assert.strictEqual(iconForStageKind('text'), '📝');
			assert.strictEqual(iconForStageKind('panorama'), '🌐');
			assert.strictEqual(iconForStageKind('project'), '📁');
		});

		test('★ 2026-09-13 补齐的 4 种 kind（实测曾未命中）', () => {
			assert.strictEqual(iconForStageKind('material'), '🧱');
			assert.strictEqual(iconForStageKind('model'), '🧊');
			assert.strictEqual(iconForStageKind('storyboard'), '🎞️');
			assert.strictEqual(iconForStageKind('timeline'), '⏱️');
		});

		test('未知 kind → undefined（调用方走引擎兜底，不抛错）', () => {
			assert.strictEqual(iconForStageKind(''), undefined);
			assert.strictEqual(iconForStageKind('brand-new-semantic'), undefined);
		});
	});

	suite('describeCardNode（图标 + 副标题）', () => {

		test('stage 元数据命中 → 副标题与画布 schemaDetail 同款', () => {
			// CropStage 在生成表里 kind='image' 且无 workflowKind → `stage: image`
			assert.deepStrictEqual(describeCardNode('ComfyTV.CropStage', 'comfyStage'), {
				icon: '🖼️', subtitle: 'stage: image',
			});
		});

		test('★ 无 stage 元数据（自研节点）→ 引擎中文标签（绝不回退机器名）', () => {
			assert.deepStrictEqual(describeCardNode('Saros.MyNewThing', 'script'), {
				icon: '📜', subtitle: '脚本节点',
			});
			assert.deepStrictEqual(describeCardNode('ComfyTV.UnknownStage', 'comfyStage'), {
				icon: '⚙️', subtitle: 'ComfyTV 阶段',
			});
		});

		test('★ 完全未知的引擎类型 → 图标兜底 + 副标题回退 rawType（都不为空）', () => {
			const d = describeCardNode('Third.Party.Node', 'mysteryType');
			assert.strictEqual(d.icon, CARD_ICON_FALLBACK);
			assert.strictEqual(d.subtitle, 'Third.Party.Node');
		});

		test('引擎图标表覆盖编排节点（agent / prompt / skill / tool / end / ifElse）', () => {
			for (const t of ['agent', 'prompt', 'skill', 'tool', 'end', 'ifElse', 'start', 'askUser']) {
				assert.ok(CARD_ICON_BY_ENGINE[t], `${t} 应有图标`);
			}
		});
	});
});
