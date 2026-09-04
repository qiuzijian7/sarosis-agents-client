/*---------------------------------------------------------------------------------------------
 *  Unit tests for 画布缩放分级（zoomTier.ts）——
 *  Zoom Tier 阈值边界 + CSS 契约（nodeCard data-zone 名与选择器互锁）。
 *
 *  背景：2026-09-02 首版 Thumb 层用 absolute inset:0 → 兄弟全隐藏后包装层塌缩、
 *  图压成细条，且 CSS 切换不触发高度反馈 → 节点保持 Full 档旧高度（大长条空卡）。
 *  修复后 Thumb 层 in-flow 4:3 + 跨档 markFormHeightDirty。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	computeZoomTier,
	ZOOM_TIER_CSS,
	ZOOM_TIER_COMPACT_MIN,
	ZOOM_TIER_FULL_MIN,
} from '../../webview/src/features/workflowEditor/zoomTier.js';

suite('zoomTier', () => {

	suite('computeZoomTier 阈值边界（含下限）', () => {
		test('thumb: k < 0.35', () => {
			assert.strictEqual(computeZoomTier(0.18), 'thumb');
			assert.strictEqual(computeZoomTier(0.34), 'thumb');
			assert.strictEqual(computeZoomTier(0.349), 'thumb');
		});

		test('compact: 0.35 ≤ k < 0.7（边界含下限）', () => {
			assert.strictEqual(computeZoomTier(ZOOM_TIER_COMPACT_MIN), 'compact');
			assert.strictEqual(computeZoomTier(0.35), 'compact');
			assert.strictEqual(computeZoomTier(0.5), 'compact');
			assert.strictEqual(computeZoomTier(0.69), 'compact');
		});

		test('full: k ≥ 0.7（边界含下限）', () => {
			assert.strictEqual(computeZoomTier(ZOOM_TIER_FULL_MIN), 'full');
			assert.strictEqual(computeZoomTier(0.7), 'full');
			assert.strictEqual(computeZoomTier(1), 'full');
			assert.strictEqual(computeZoomTier(2.5), 'full');
		});

		test('异常 scale 防御（NaN/负数 → thumb，不抛错）', () => {
			assert.strictEqual(computeZoomTier(Number.NaN), 'thumb');
			assert.strictEqual(computeZoomTier(-1), 'thumb');
			assert.strictEqual(computeZoomTier(0), 'thumb');
		});
	});

	suite('ZOOM_TIER_CSS 契约（与 nodeCard data-zone 名互锁）', () => {
		test('compact 档用 :not([data-zone="keep"]) 白名单反转', () => {
			assert.ok(ZOOM_TIER_CSS.includes('[data-tier="compact"] .wf-comfy-card > div > *:not([data-zone="keep"])'),
				'compact 规则必须限定 .wf-comfy-card 内容包装层的直接子节点');
		});

		test('thumb 档唯一显示 [data-zone="thumb"] 且为 in-flow 4:3（非 absolute）', () => {
			assert.ok(ZOOM_TIER_CSS.includes('[data-tier="thumb"] .wf-comfy-card > div > [data-zone="thumb"]'));
			// ★ 回归：首版用 absolute inset:0 → 包装层塌缩、图压成细条。必须是
			//   in-flow + aspect-ratio，让高度反馈把节点缩成缩略卡。
			assert.ok(ZOOM_TIER_CSS.includes('aspect-ratio'), 'thumb 层必须用 aspect-ratio 撑高');
			assert.ok(!/\[data-zone="thumb"\] \{[^}]*position:\s*absolute/.test(ZOOM_TIER_CSS),
				'thumb 层不得回退为 absolute（会塌缩）');
			assert.ok(ZOOM_TIER_CSS.includes('object-fit: cover'), '缩略图必须 cover 铺满');
		});

		test('thumb 档隐藏全部未打标兄弟', () => {
			assert.ok(ZOOM_TIER_CSS.includes('[data-tier="thumb"] .wf-comfy-card > div > *:not([data-zone="thumb"])'));
		});

		test('选择器限定在 .wf-comfy-card 内（不影响 widgetBridge 容器/端口行）', () => {
			const rules = ZOOM_TIER_CSS.split('\n').filter(l => l.trim().startsWith('[data-tier='));
			assert.ok(rules.length >= 4);
			for (const r of rules) {
				assert.ok(r.includes('.wf-comfy-card'), `规则必须限定卡片根：${r}`);
			}
		});
	});
});
