/*
 * 2026-11-12：设置页「保存并新增应用 → TypeError: Failed to fetch」守卫。
 *
 * 真机：Host 不可达（左下角「请检查 Host 是否正在运行 / 登录已失效」）⇒ /x/kb/api/* 全挂。
 * 页面两个放大问题的缺陷：
 *   ① GET 失败被 `.catch(() => undefined)` 静默吞掉 ⇒ 页面显示「默认应用 / 未配置 / user」
 *      等**默认值伪装**，用户以为读到的是真设置（真机 dev 设置其实是 appId=cli_… / bot）；
 *   ② POST 失败只显示裸 `TypeError: Failed to fetch`，不可行动，看起来像「点了没反应」；
 *   ③ 更危险：GET 失败时 settings=null，保存会用空对象**全量 POST 覆盖**真配置
 *      （mappings / clipPoll / identity 全丢）⇒ 必须在写路径前置拦截。
 *
 * 契约：两份前端（TSX bundle / client.js 面板）同款文案 + 加载失败可见 + 写路径拦截。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-settings-offline.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TSX = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', 'utf8');
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
const BUNDLE = readFileSync(HERE + '../lib/web/kbSideview.js', 'utf8');

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

const NET_HINT = '无法连接知识库 Host（/x/kb/api 请求失败）。请确认 VsSaros Host 正在运行；若提示「登录已失效」，先重新登录再重试。';

check('① 两份前端都有 describeFetchError，且文案逐字一致', () => {
	assert.ok(/export function describeFetchError\(/.test(TSX), 'TSX 缺纯函数');
	assert.ok(/const describeFetchError = \(e\) =>/.test(CLIENT), 'client.js 缺同款函数');
	assert.ok(TSX.includes(NET_HINT) && CLIENT.includes(NET_HINT), '文案不一致');
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(/failed to fetch\|networkerror\|load failed\|net::/i.test(src), name + ' 缺网络错误识别');
	}
});

check('② ★ GET 失败不再静默吞掉，写入 loadError', () => {
	assert.ok(!/api\('kb-settings'\)[\s\S]{0,400}\.catch\(\(\) => undefined\)/.test(TSX), 'TSX 仍静默吞 GET 失败');
	assert.ok(/setLoadError\(describeFetchError\(e\)\)/.test(TSX), 'TSX 没记录可读错误');
	assert.ok(/setLoadError\(describeFetchError\(e\)\)/.test(CLIENT), 'client.js 没记录可读错误');
	assert.ok(/setLoadError\(''\)/.test(TSX) && /setLoadError\(''\)/.test(CLIENT), '成功后没清除错误');
});

check('③ ★ 加载失败时写路径全部前置拦截（防空配置覆盖真设置）', () => {
	const saves = TSX.match(/const save(?:App)? = \([\s\S]*?\n\t\};/g) || [];
	assert.ok(saves.length >= 2, '没抓到 TSX 的两个保存函数');
	for (const s of saves) {
		assert.ok(/if \(loadError\)/.test(s), 'TSX 保存函数缺 loadError 拦截：' + s.slice(0, 60));
	}
	for (const key of ['const save = (patch) =>', 'const saveApp = () =>']) {
		const at = CLIENT.indexOf(key);
		assert.ok(at > 0, 'client.js 缺 ' + key);
		const seg = CLIENT.slice(at, at + 700);
		assert.ok(/if \(loadError\)/.test(seg), 'client.js ' + key + ' 缺拦截');
	}
});

check('④ 两份前端都有醒目的连接错误条', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(src.includes('data-kb-settings-offline'), name + ' 缺错误条锚点');
		assert.ok(src.includes('已暂时禁止保存'), name + ' 错误条没说明已禁止保存');
	}
});

check('⑤ POST 失败用可读文案，不再裸 String(e)', () => {
	assert.ok(/保存飞书应用失败：' \+ describeFetchError\(e\)/.test(TSX));
	assert.ok(/保存飞书应用失败：' \+ describeFetchError\(e\)/.test(CLIENT));
});

check('⑥ 纯函数行为：网络错误 → 可行动提示；业务错误 → 原样透出', () => {
	// 与源码同款逻辑（守卫不 import TSX，避免构建依赖；用源码里的正则+文案做对照）
	const describe = (e) => {
		const raw = String((e && e.message) || e || '');
		return /failed to fetch|networkerror|load failed|net::/i.test(raw) ? NET_HINT : raw;
	};
	assert.equal(describe(new TypeError('Failed to fetch')), NET_HINT);
	assert.equal(describe({ message: 'NetworkError when attempting to fetch resource.' }), NET_HINT);
	assert.equal(describe(new Error('App ID 形态不对')), 'App ID 形态不对');
	assert.ok(!describe(new TypeError('Failed to fetch')).includes('TypeError'), '提示不该带裸异常名');
});

check('⑦ 产物 bundle 已同步（改 TSX 不跑 build+sync 会红）', () => {
	assert.ok(BUNDLE.includes('data-kb-settings-offline'), 'kbSideview.js 还是旧版（缺错误条锚点）');
	// ⚠ esbuild 会压缩函数名 / state 名、把中文转成大写 \uXXXX ⇒ 只认压缩后稳定的字面量
	assert.ok(BUNDLE.includes('failed to fetch|networkerror|load failed|net::'), 'bundle 缺网络错误识别');
	assert.ok(BUNDLE.includes('\\u65E0\\u6CD5\\u8FDE\\u63A5'), 'bundle 缺可行动提示文案');
});

check('⑧ 反向突变自证：去掉加载失败状态会被 ② 抓到', () => {
	const broken = TSX.replace(/setLoadError\(describeFetchError\(e\)\)/g, 'void e');
	assert.notEqual(broken, TSX);
	assert.ok(!/setLoadError\(describeFetchError\(e\)\)/.test(broken));
});

check('⑨ 两份设置页：加载前禁止写入、重复点击保护、页内重试与保存状态', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(src.includes('!settings || settingsLoading || appSavingRef.current'), name + ' 缺加载/重复提交保护');
		assert.ok(src.includes('appSavingRef.current = true') && src.includes('appSavingRef.current = false'));
		assert.ok(src.includes('重新读取设置') && src.includes('正在读取设置'));
		assert.ok(src.includes("appSaving ? '保存中…'"));
		assert.ok(!src.includes('setSettings(b.settings || payload)'), name + ' 不许用含密钥 payload 作为成功兜底');
	}
});

const asyncCheck = async (name, fn) => {
	try { await fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};
const requestSources = [
	['TSX', TSX.match(/export async function requestKbSettings[\s\S]*?\n\}/)?.[0]],
	['client.js', CLIENT.match(/async function requestKbSettings[\s\S]*?\n\t\t\t\}/)?.[0]],
];
for (const [name, source] of requestSources) {
	const loadRequest = (fetch) => {
		assert.ok(source, name + ' 缺真实请求函数');
		const code = transformSync(source.replace(/^export /, '') + '\nmodule.exports = requestKbSettings;', { loader: 'ts' }).code;
		const module = { exports: {} };
		new Function('fetch', 'AbortController', 'module', code)(fetch, AbortController, module);
		return module.exports;
	};
	const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
	await asyncCheck(name + '：成功响应确认设置及请求凭据', async () => {
		const body = { ok: true, settings: { feishu: { appId: 'cli_test' } } };
		const request = loadRequest(async (url, init) => {
			assert.equal(url, '/x/kb/api/kb-settings');
			assert.equal(init.credentials, 'same-origin');
			assert.ok(init.signal);
			return response(body);
		});
		assert.deepEqual(await request({}, 1000), body);
	});
	await asyncCheck(name + '：HTTP 错误、ok:false、空设置均拒绝，不假装已保存', async () => {
		await assert.rejects(loadRequest(async () => response({ ok: false, error: { message: '凭据服务不可用' } }, false, 503))({}, 1000), /凭据服务不可用/);
		await assert.rejects(loadRequest(async () => response({ ok: false, error: '保存失败' }))({}, 1000), /保存失败/);
		await assert.rejects(loadRequest(async () => response({ ok: true }))({}, 1000), /未返回有效设置/);
	});
	await asyncCheck(name + '：登录页或损坏 JSON 有可行动错误', async () => {
		const request = loadRequest(async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError('bad json'); } }));
		await assert.rejects(request({}, 1000), /HTTP 401.*登录状态/);
	});
	await asyncCheck(name + '：网络层失败透传给可读错误处理', async () => {
		await assert.rejects(loadRequest(async () => { throw new TypeError('Failed to fetch'); })({}, 1000), /Failed to fetch/);
	});
	await asyncCheck(name + '：fetch 和响应正文永久等待时均超时并取消请求', async () => {
		for (const hangBody of [false, true]) {
			let signal;
			const request = loadRequest(async (_, init) => {
				signal = init.signal;
				if (!hangBody) { return new Promise(() => {}); }
				return { ok: true, status: 200, json: () => new Promise(() => {}) };
			});
			await assert.rejects(request({}, 20), /请求超时.*无法确认是否已保存/);
			assert.equal(signal.aborted, true);
		}
	});
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
