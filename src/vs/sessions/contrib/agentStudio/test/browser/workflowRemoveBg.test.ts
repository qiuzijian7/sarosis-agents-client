/*---------------------------------------------------------------------------------------------
 *  Unit tests for 「去背景」节点纯逻辑层（removeBg.ts）。
 *
 *  背景：工作流新增 Saros.RemoveBg 节点，浏览器直连本地 rembg 服务
 *  （rembg_server.py，POST /api/remove）。本测试覆盖参数解析与 widget 契约；
 *  HTTP/快照链路在 removeBgExecutor（依赖浏览器环境，不在单测范围）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	REMOVE_BG_TYPE,
	isRemoveBgNode,
	REMOVE_BG_WIDGETS,
	REMBG_DEFAULT_MODEL,
	REMBG_DEFAULT_URL,
	REMBG_MODEL_OPTIONS,
	resolveRembgParams,
	rembgBool,
	rembgStr,
} from '../../webview/src/features/workflowEditor/comfyHost/removeBg.js';

suite('removeBg', () => {

	test('类型谓词只认 Saros.RemoveBg', () => {
		assert.strictEqual(isRemoveBgNode('Saros.RemoveBg'), true);
		// ★ 大小写敏感：昨天的 toSarosType 小写化事故教训 —— 谓词不得宽容大小写
		assert.strictEqual(isRemoveBgNode('Saros.Removebg'), false);
		assert.strictEqual(isRemoveBgNode('Saros.removebg'), false);
		assert.strictEqual(isRemoveBgNode('ComfyTV.ImageStage'), false);
		assert.strictEqual(isRemoveBgNode(''), false);
	});

	test('widget 契约：三个控件且类型在 comfyTV 控件白名单内', () => {
		const names = REMOVE_BG_WIDGETS.map((w) => w.name);
		assert.deepStrictEqual(names, ['model', 'alpha_matting', 'post_process']);
		for (const w of REMOVE_BG_WIDGETS) {
			// nodeCard 控件网格（comfyTV 分支）白名单：COMBO/INT/FLOAT/BOOLEAN
			// （TEXT 被 prompt textarea 专用，STRING 不支持 —— 见 nodeCard.tsx:261/285）
			assert.ok(w.type === 'COMBO' || w.type === 'BOOLEAN', `${w.name} 类型必须在白名单内`);
		}
		const model = REMOVE_BG_WIDGETS.find((w) => w.name === 'model')!;
		const opts = (model as { options: Array<{ value: string }> }).options.map((o) => o.value);
		assert.ok(opts.includes(REMBG_DEFAULT_MODEL), '默认模型必须在选项列表中');
	});

	test('resolveRembgParams：默认值', () => {
		const p = resolveRembgParams({});
		assert.strictEqual(p.model, REMBG_DEFAULT_MODEL);
		assert.strictEqual(p.alphaMatting, false);
		assert.strictEqual(p.postProcessMask, true);
	});

	test('resolveRembgParams：显式取值 + 布尔兼容（字符串1 / 数字1 / true）', () => {
		const p = resolveRembgParams({ model: 'isnet-anime', alpha_matting: '1', post_process: 1 });
		assert.strictEqual(p.model, 'isnet-anime');
		assert.strictEqual(p.alphaMatting, true);
		assert.strictEqual(p.postProcessMask, true);
	});

	test('resolveRembgParams：未知模型回退默认（服务端 400 前置拦截）', () => {
		const p = resolveRembgParams({ model: 'not-a-model' });
		assert.strictEqual(p.model, REMBG_DEFAULT_MODEL);
	});

	test('rembgStr / rembgBool 边界', () => {
		assert.strictEqual(rembgStr({ k: '  x  ' }, 'k', 'd'), 'x');
		assert.strictEqual(rembgStr({}, 'k', 'd'), 'd');
		assert.strictEqual(rembgStr({ k: '' }, 'k', 'd'), 'd');
		assert.strictEqual(rembgBool({ k: 'true' }, 'k', false), true);
		assert.strictEqual(rembgBool({ k: 0 }, 'k', true), false);
		assert.strictEqual(rembgBool({ k: null }, 'k', true), true);
		assert.strictEqual(rembgBool({ k: '' }, 'k', true), true, '空串视为未设置 → fallback');
	});

	test('常量：服务地址与模型选项', () => {
		assert.strictEqual(REMBG_DEFAULT_URL, 'http://127.0.0.1:7000');
		assert.ok(REMBG_MODEL_OPTIONS.length >= 6);
		// 选项 value 不得重复（COMBO 下拉去重依赖）
		const values = REMBG_MODEL_OPTIONS.map((o) => o.value);
		assert.strictEqual(new Set(values).size, values.length);
	});
});
