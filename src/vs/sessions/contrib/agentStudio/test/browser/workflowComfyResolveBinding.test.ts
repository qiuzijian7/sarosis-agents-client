/*---------------------------------------------------------------------------------------------
 *  Unit tests for resolveBinding — ComfyTV-style bindings parser.
 *  Covers upstream_<port>:value[n] / masked, main_prompt, option:*, computed:*,
 *  literal:*, {{var}} pre-pass, defaults, and error cases.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	resolveBinding,
	resolveBindingsMap,
	resolveTemplateVars,
	isBindingEmpty,
	BindingError,
	type BindingContext,
	type UpstreamSource,
} from '../../webview/src/features/workflowEditor/comfyHost/resolveBinding.js';

function imageSource(values: unknown[], hasMask = true): UpstreamSource {
	return {
		value: values,
		at: (i: number) => values[i],
		hasMask,
		masked: hasMask ? `mask(${values.join(',')})` : undefined,
	};
}

function ctx(partial: Partial<BindingContext> = {}): BindingContext {
	return {
		upstreams: {
			image: imageSource(['a.png', 'b.png']),
			video: imageSource(['v1.mp4']),
			maskOnly: imageSource([], true),
		},
		widgets: { seed: 42, steps: 20 },
		promptTexts: { 'n-prompt': '黄昏森林' },
		computeds: { width: 960, height: 540 },
		...partial,
	};
}

suite('resolveBinding', () => {

	suite('upstream_<port>:value', () => {

		test('whole value of an input port', () => {
			const r = resolveBinding('upstream_image:value', ctx());
			assert.deepStrictEqual(r.value, ['a.png', 'b.png']);
			assert.strictEqual(r.sourcePort, 'image');
		});

		test('indexed element', () => {
			const r = resolveBinding('upstream_image:value[0]', ctx());
			assert.strictEqual(r.value, 'a.png');
			const r2 = resolveBinding('upstream_image:value[1]', ctx());
			assert.strictEqual(r2.value, 'b.png');
		});

		test('masked variant marks usedMask', () => {
			const r = resolveBinding('upstream_image:masked', ctx());
			assert.strictEqual(r.usedMask, true);
			assert.strictEqual(r.value, 'mask(a.png,b.png)');
		});

		test('missing port with default returns default', () => {
			const r = resolveBinding('upstream_audio:value', ctx(), 'fallback.wav');
			assert.strictEqual(r.value, 'fallback.wav');
		});

		test('missing port without default throws BindingError', () => {
			assert.throws(() => resolveBinding('upstream_audio:value', ctx()), BindingError);
		});

		test('masked when unavailable without default throws', () => {
			const c = ctx({ upstreams: { image: imageSource(['a.png'], false) } });
			assert.throws(() => resolveBinding('upstream_image:masked', c), BindingError);
		});

		test('masked when unavailable with default falls back', () => {
			const c = ctx({ upstreams: { image: imageSource(['a.png'], false) } });
			const r = resolveBinding('upstream_image:masked', c, 'none');
			assert.strictEqual(r.value, 'none');
		});
	});

	suite('main_prompt / option / computed / literal', () => {

		test('main_prompt resolves first prompt node text', () => {
			const r = resolveBinding('main_prompt', ctx());
			assert.strictEqual(r.value, '黄昏森林');
		});

		test('option:<widget> reads current node widget', () => {
			const r = resolveBinding('option:seed', ctx());
			assert.strictEqual(r.value, 42);
		});

		test('option missing widget with default', () => {
			const r = resolveBinding('option:missing', ctx(), 7);
			assert.strictEqual(r.value, 7);
		});

		test('computed:<name>', () => {
			const r = resolveBinding('computed:width', ctx());
			assert.strictEqual(r.value, 960);
		});

		test('literal:<json> parses JSON, falls back to string', () => {
			assert.deepStrictEqual(resolveBinding('literal:[1,2,3]', ctx()).value, [1, 2, 3]);
			assert.strictEqual(resolveBinding('literal:hello', ctx()).value, 'hello');
		});
	});

	suite('{{var}} template pre-pass', () => {

		test('embedded template var resolves first', () => {
			const c = ctx({ resolveTemplateVar: (n) => (n === 'n1.output' ? '渲染结果' : undefined) });
			const r = resolveBinding('{{n1.output}} 的高清版', c);
			assert.strictEqual(r.value, '渲染结果 的高清版');
		});

		test('unknown template var becomes empty string', () => {
			const r = resolveBinding('{{ghost}}', ctx());
			assert.strictEqual(r.value, '');
		});

		test('resolveTemplateVars is a no-op without braces', () => {
			assert.strictEqual(resolveTemplateVars('plain', ctx()), 'plain');
		});
	});

	suite('scalar passthrough / errors', () => {

		test('plain scalar passes through', () => {
			const r = resolveBinding('some raw text', ctx());
			assert.strictEqual(r.value, 'some raw text');
		});

		test('recursion depth limit', () => {
			// deeply nested upstream chains exceed depth → throw
			const deepCtx = ctx({
				upstreams: { image: { value: 'x', at: () => 'x', hasMask: false } },
				resolveTemplateVar: () => '{{loop}}',
			});
			assert.throws(() => resolveBinding('{{loop}}', deepCtx, undefined, 6), BindingError);
		});
	});

	suite('resolveBindingsMap', () => {

		test('resolves multiple bindings', () => {
			const r = resolveBindingsMap(
				{ prompt: 'main_prompt', image0: 'upstream_image:value[0]', audio: 'upstream_audio:value' },
				ctx(),
				{ audio: 'silence.wav' },
			);
			assert.deepStrictEqual(r.values, { prompt: '黄昏森林', image0: 'a.png', audio: 'silence.wav' });
			assert.strictEqual(r.sources['image0'], 'image');
			assert.strictEqual(r.usedMask, false);
		});

		test('missing source without default throws through the map', () => {
			assert.throws(
				() => resolveBindingsMap({ audio: 'upstream_audio:value' }, ctx(), {}),
				BindingError,
			);
		});

		test('collects usedMask when any binding is masked', () => {
			const r = resolveBindingsMap({ img: 'upstream_image:masked' }, ctx());
			assert.strictEqual(r.usedMask, true);
			assert.strictEqual(r.values['img'], 'mask(a.png,b.png)');
		});
	});

	suite('isBindingEmpty', () => {

		test('empty / blank / literal:null are empty', () => {
			assert.strictEqual(isBindingEmpty(''), true);
			assert.strictEqual(isBindingEmpty('   '), true);
			assert.strictEqual(isBindingEmpty('literal:null'), true);
			assert.strictEqual(isBindingEmpty('upstream_image:value'), false);
		});
	});
});
