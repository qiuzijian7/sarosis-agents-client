/* Unit tests for the ComfyTV action-spawn model (actionSpawn.ts).
 * Verifies the faithful port of stageActions.ts / imagePresets.ts /
 * imageEditPresets.ts: per-kind action lists + preset → targetClass mapping.
 * Run with: node test/run-actionspawn.mjs */

import { ACTIONS_BY_KIND, actionKeyFor } from '../src/features/workflowEditor/comfyHost/actionSpawn';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
	else { failed++; console.error(`✗ ${label}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`); }
}

// ─── actionKeyFor: kind normalization ───────────────────────────────────────
eq(actionKeyFor('image'), 'image', 'image → image');
eq(actionKeyFor('image-picker'), 'image-picker', 'image-picker → image-picker');
eq(actionKeyFor('image-batch'), 'image-batch', 'image-batch → image-batch');
eq(actionKeyFor('panorama'), 'panorama', 'panorama → panorama');
eq(actionKeyFor('video'), 'video', 'video → video');
eq(actionKeyFor('model'), 'model', 'model → model');
eq(actionKeyFor('material'), undefined, 'material → undefined (no actions)');

// ─── image actions: 6 actions, order matches ComfyTV ────────────────────────
const imageActions = ACTIONS_BY_KIND.image;
eq(imageActions.map(a => a.id), ['edit', 'panorama', 'multiangle', 'relight', 'material', 'preset'], 'image action ids');
eq(imageActions.map(a => a.id).filter(id => ACTIONS_BY_KIND.image.find(x => x.id === id)?.presets?.length), ['edit', 'preset'], 'only edit+preset have presets');

// ─── edit presets (IMAGE_EDIT_PRESETS): 11 targets ──────────────────────────
const editPresets = imageActions.find(a => a.id === 'edit')!.presets!;
eq(editPresets.length, 11, 'edit preset count');
eq(editPresets[0], { id: 'hd', icon: '✦', category: 'imageEdit', targetClass: 'ComfyTV.UpscaleStage', inputSocket: 'image' }, 'edit[0] hd → UpscaleStage');
eq(editPresets[6].id, 'rotate', 'edit[6] rotate');
eq(editPresets[6].targetClass, 'ComfyTV.RotateStage', 'rotate → RotateStage');
eq(editPresets[10].id, 'ken-burns', 'edit[10] ken-burns');
eq(editPresets[10].targetClass, 'ComfyTV.KenBurnsStage', 'ken-burns → KenBurnsStage');

// ─── variant presets (IMAGE_VARIANT_PRESETS): 9 targets ─────────────────────
const variantPresets = imageActions.find(a => a.id === 'preset')!.presets!;
eq(variantPresets.length, 9, 'variant preset count');
eq(variantPresets[0].id, 'face-3view', 'variant[0] face-3view');
eq(variantPresets[0].targetClass, 'ComfyTV.ImageVariationsStage', 'face-3view → ImageVariationsStage');
eq(variantPresets[0].widgets, { workflow: 'Face 3-View', variant_count: 3 }, 'face-3view widgets');
eq(variantPresets[6].id, 'cinematic-light', 'variant[6] cinematic-light');
eq(variantPresets[6].targetClass, 'ComfyTV.ImageEditStage', 'cinematic-light → ImageEditStage');

// ─── every edit/variant preset targets a real registered node ───────────────
// (light check: targetClass starts with ComfyTV. and is non-empty)
for (const p of [...editPresets, ...variantPresets]) {
	const ok = !!p.targetClass && p.targetClass.startsWith('ComfyTV.');
	if (!ok) { failed++; console.error(`✗ preset ${p.id} has invalid targetClass`); }
	else { passed++; }
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
