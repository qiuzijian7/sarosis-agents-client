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
import { resolveTemplateVars as resolveTemplateVarsWF } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

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

		suite('W4 resolveTemplateVars: {{label.field}} named references', () => {
			const named = (label: string): string | undefined => {
				if (label === '分析') { return JSON.stringify({ tags: ['cyberpunk', 'neon'], score: 8 }); }
				if (label === '提示词') { return 'plain text snapshot'; }
				return undefined;
			};

			test('named label resolves whole snapshot (JSON stringified object → String)', () => {
				const r = resolveTemplateVarsWF('结果 {{分析}}', { named });
				assert.strictEqual(r, '结果 {"tags":["cyberpunk","neon"],"score":8}');
			});

			test('named label + dot path extracts field（数组/对象字段用 JSON.stringify，标量用 String）', () => {
				const r = resolveTemplateVarsWF('风格 {{分析.tags}}', { named });
				// tags 是数组 → stringifyResolvedValue 走 JSON.stringify（对齐 [object Object] 修复语义）
				assert.strictEqual(r, '风格 ["cyberpunk","neon"]');
			});

			test('named plain-text snapshot resolves without path', () => {
				const r = resolveTemplateVarsWF('前置：{{提示词}}', { named });
				assert.strictEqual(r, '前置：plain text snapshot');
			});

			test('unknown label keeps the placeholder verbatim', () => {
				const r = resolveTemplateVarsWF('{{幽灵节点.x}}', { named });
				assert.strictEqual(r, '{{幽灵节点.x}}');
			});

			test('deep path miss keeps the placeholder', () => {
				const r = resolveTemplateVarsWF('{{分析.no.such}}', { named });
				assert.strictEqual(r, '{{分析.no.such}}');
			});

			test('args/input placeholders are not hijacked by named pass', () => {
				const r = resolveTemplateVarsWF('{{input}} {{args.topic}}', { input: 'IN', args: { topic: 'T' }, named });
				assert.strictEqual(r, 'IN T');
			});

			test('mixed input + named + args in one template', () => {
				const r = resolveTemplateVarsWF('{{分析.score}} 分 · {{input}} · {{args.topic}}', { input: '上游', args: { topic: '主题' }, named });
				assert.strictEqual(r, '8 分 · 上游 · 主题');
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
