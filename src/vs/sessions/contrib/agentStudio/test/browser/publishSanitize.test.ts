/*---------------------------------------------------------------------------------------------
 *  Unit test: 发布前的本地态剥离（2026-09-13 修发布泄露面）。
 *
 *  锁定三条语义：
 *    · `data:` 内联资源 → **删除键**（本地生成物，跨机无意义 ✓）
 *    · 本机绝对路径 → **置 ''**（保留键，避免下游解析异常 ✗）
 *    · **不改原对象** ✓（调用方可能还要用原件）
 *  并守住「不误伤」：相对路径 / URL / 合法字段必须原样保留 ✓。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { sanitizeForPublish, isInlineDataUrl, isLocalAbsolutePath } from '../../browser/utils/publishSanitize.js';

test('★ data: 内联资源被删除（含嵌套数组）', () => {
	const input = {
		id: 'wf-1',
		nodes: [
			{ id: 'n1', data: { prompt: 'hi', image: 'data:image/png;base64,AAAA' } },
			{ id: 'n2', data: { refs: [{ ref: 'data:image/gif;base64,BBBB', slot: 0 }, { ref: 'keep.png', slot: 1 }] } },
		],
	};
	const { value, stripped } = sanitizeForPublish(input);
	const v = value as typeof input;
	assert.strictEqual('image' in v.nodes[0].data, false, 'data: 值应删除键');
	assert.deepStrictEqual(stripped.sort(), ['nodes[0].data.image', 'nodes[1].data.refs[0].ref'].sort());
	// ★ 数组元素被剥离时**保留下标**（不 splice）——下标常与格序绑定，删元素会错位 ✗
	assert.strictEqual((v.nodes[1].data.refs as unknown[]).length, 2, '数组长度不变（下标不能错位）');
	// 对象属性里的 data: → **删除键**（对象键删除不影响数组长度 ✓）
	assert.strictEqual('ref' in (v.nodes[1].data.refs as Array<Record<string, unknown>>)[0], false, '属性 data: 应删除键');
	assert.strictEqual((v.nodes[1].data.refs as Array<{ ref: string }>)[1].ref, 'keep.png', '非 data: 值原样保留');
});

test('★ 数组元素**本身**是本地态 → 置空保下标', () => {
	const { value, stripped } = sanitizeForPublish({ refs: ['data:image/png;base64,AAAA', 'keep.png', 'E:\\x'] });
	const v = value as { refs: string[] };
	assert.deepStrictEqual(v.refs, ['', 'keep.png', ''], '元素本身是本地态 → 置空（长度不变 ✓）');
	assert.deepStrictEqual(stripped, ['refs[0]', 'refs[2]']);
});

test('★ 本机绝对路径置空（保留键）', () => {
	const { value, stripped } = sanitizeForPublish({
		rootDir: 'E:\\Downloads\\media',
		unixDir: '/Users/me/media',
		unc: '\\\\server\\share',
	});
	const v = value as Record<string, string>;
	assert.strictEqual(v.rootDir, '');
	assert.strictEqual(v.unixDir, '');
	assert.strictEqual(v.unc, '');
	assert.strictEqual(stripped.length, 3);
	assert.ok('rootDir' in v, '键必须保留（置空而非删除）—— 字段缺失会引发下游解析异常 ✗');
});

test('★★ 不误伤：相对路径 / URL / 合法字段原样保留', () => {
	const input = {
		apiPath: '/api/v1/generate',      // 任意 /… 不算本机路径 ✓（只认 /Users|/home|/root）
		rel: 'assets/logo.png',
		url: 'https://example.com/a.png',
		vscode: 'vscode-file://vscode-app/x.png',
		empty: '',
		num: 3,
		flag: true,
		nested: { deep: { keep: 'ok' } },
	};
	const { value, stripped } = sanitizeForPublish(input);
	assert.deepStrictEqual(value, input, '不含本地态时应完全等价');
	assert.deepStrictEqual(stripped, []);
});

test('★ 不改原对象（调用方可能还要用原件）', () => {
	const input = { a: 'data:image/png;base64,AAAA', b: 'C:\\x' };
	const before = JSON.stringify(input);
	sanitizeForPublish(input);
	assert.strictEqual(JSON.stringify(input), before, '不得原地修改');
});

test('★ 判定函数边界', () => {
	assert.strictEqual(isInlineDataUrl('data:image/png;base64,x'), true);
	assert.strictEqual(isInlineDataUrl('DATA:image/png;base64,x'), true, '大小写不敏感（宽松更安全 ✓）');
	assert.strictEqual(isInlineDataUrl('data:'), false, '无逗号 → 不是合法 data URL');
	assert.strictEqual(isLocalAbsolutePath('C:/x'), true);
	assert.strictEqual(isLocalAbsolutePath('/home/u/x'), true);
	assert.strictEqual(isLocalAbsolutePath('/api/v1'), false);
	assert.strictEqual(isLocalAbsolutePath('x/y'), false);
	assert.strictEqual(isLocalAbsolutePath(123), false);
});
