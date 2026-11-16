/*
 * 2026-11-11：知识库「初次默认总览 / 重启恢复上次文档」守卫。
 *
 * 需求：① 初次打开知识库默认显示「总览」；② 下次启动 app 打开知识库时自动恢复
 *   上次关闭时打开的文档。落点 `<kbRoot>/.kb-settings.json` 的 `lastDoc`。
 *
 * 端到端用 fake Host 真发 HTTP：验证 `/api/last-doc` 读写、清空、脏值拒绝，
 * 以及**最关键**的「保存飞书设置不会把 lastDoc 冲掉」（POST 是全量覆盖）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-last-doc.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = new URL('.', import.meta.url);
const { sanitizeLastDoc } = await import(new URL('../lib/core/kbLastDoc.js', HERE).href);
const TSX = readFileSync(new URL('../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', HERE), 'utf8');
const INDEX = readFileSync(new URL('../lib/index.js', HERE), 'utf8');
const CLIENT = readFileSync(new URL('../lib/client.js', HERE), 'utf8');
const SYNC = readFileSync(new URL('sync-kb-sideview.mjs', HERE), 'utf8');
const BUNDLE = readFileSync(new URL('../lib/web/kbSideview.js', HERE), 'utf8');
const PAGE_BOOT = readFileSync(new URL('../lib/web/page-boot.js', HERE), 'utf8');

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

// ── 纯函数 ──────────────────────────────────────────────────────────────────
check('① sanitizeLastDoc：合法记录保留 path/title/vaultId', () => {
	assert.deepEqual(sanitizeLastDoc({ path: '知识库列表/AIAgent/a.md', title: 'A', vaultId: 'v1' }),
		{ path: '知识库列表/AIAgent/a.md', title: 'A', vaultId: 'v1' });
});
check('② 空值 / 数组 / 无 path ⇒ null', () => {
	for (const v of [null, undefined, 0, 'x', [], {}, { path: '' }, { path: '   ' }, { title: 'A' }]) {
		assert.equal(sanitizeLastDoc(v), null);
	}
});
check('③ 路径穿越与控制字符被拒（记录不能当越权载体）', () => {
	assert.equal(sanitizeLastDoc({ path: '../etc/passwd' }), null);
	assert.equal(sanitizeLastDoc({ path: 'a/../../b' }), null);
	assert.equal(sanitizeLastDoc({ path: 'a\u0000b' }), null);
});
check('④ 超长字段截断、空 vaultId 不写入', () => {
	const r = sanitizeLastDoc({ path: 'p'.repeat(900), title: 't'.repeat(400), vaultId: '' });
	assert.equal(r.path.length, 500);
	assert.equal(r.title.length, 200);
	assert.equal('vaultId' in r, false);
});

// ── 静态接线 ────────────────────────────────────────────────────────────────
check('⑤ ★ ① 初次默认总览：activeView 初值 home + 总览页签初开', () => {
	assert.ok(/useState<'doc' \| 'settings' \| 'graph' \| 'canvas'( \| 'home')?>\('home'\)/.test(TSX),
		'activeView 初值不是 home');
	assert.ok(/useState<\{ settings: boolean; graph: boolean; canvas: boolean; home: boolean \}>\([^)]*home: true/.test(TSX),
		'总览页签初次没打开');
});
check('⑥ ★ ② 恢复逻辑：能力位 + 异步读 + 树校验降级 + 只跑一次', () => {
	assert.ok(/getLastDoc\?\(\): Promise<KbLastDoc \| null>/.test(TSX), '缺 getLastDoc 能力位');
	assert.ok(/setLastDoc\?\(doc: KbLastDoc \| null\)/.test(TSX), '缺 setLastDoc 能力位');
	assert.ok(/const restoredRef = useRef\(false\)/.test(TSX) && /restoredRef\.current = true/.test(TSX),
		'缺一次性保护（UPDATE 换数据会重复恢复）');
	assert.ok(/exists\(data\.tree\)/.test(TSX), '恢复前没校验文档仍在树里');
	assert.ok(/actions\.setLastDoc\?\.\(null\)/.test(TSX), '记录失效时没清空');
	assert.ok(/loadIntoViewRef\.current\?\.\(p,/.test(TSX), '没调回打开文档');
});
check('⑦ 写入点：打开文档记、关当前页签到邻居/全关分别记/清空', () => {
	assert.ok(/actions\?\.setLastDoc\?\.\(\{ path, title: name \}\)/.test(TSX), 'loadIntoView 没写');
	assert.ok(/actions\?\.setLastDoc\?\.\(next \? \{ path: next\.path, title: next\.title \} : null\)/.test(TSX),
		'closeTab 没更新');
	assert.ok(/}, \[activePath, tabs, actions\]/.test(TSX), 'closeTab 依赖缺 actions（stale）');
});
check('⑧ 恢复 effect 依赖数组为空（不引用后声明的 showToast，防 TDZ 白屏）', () => {
	const at = TSX.indexOf('const restoredRef = useRef(false);');
	assert.ok(at > 0, '找不到恢复 effect');
	assert.ok(/\}, \[\]\);/.test(TSX.slice(at, at + 1600)), '恢复 effect 依赖不是 []');
	assert.ok(TSX.indexOf('loadIntoViewRef.current = loadIntoView;') < at,
		'恢复 effect 排在 loadIntoViewRef 赋值之前 ⇒ 拿不到引用');
});
check('⑨ 后端：/api/last-doc 端点 + 设置保存沿用旧值', () => {
	assert.ok(/\/api\/last-doc/.test(INDEX), '缺独立端点');
	assert.ok(/cur\.lastDoc = sanitizeLastDoc\(body\?\.lastDoc\)/.test(INDEX), 'POST 没规范化');
	assert.ok(/sanitizeLastDoc\(readSettings\(\)\.lastDoc\)/.test(INDEX),
		'kb-settings 全量 POST 会冲掉 lastDoc ✗');
	assert.ok(/lastDoc: null,/.test(INDEX), 'defaults 缺 lastDoc');
});
check('⑩ 两种宿主都接了能力位，且产物已同步', () => {
	assert.ok(CLIENT.includes('getLastDoc: async () =>') && CLIENT.includes('setLastDoc: (doc) =>'),
		'工作台面板 client.js 没接');
	assert.ok(SYNC.includes('getLastDoc: async () =>') && SYNC.includes('setLastDoc: doc =>'),
		'sync 模板没接（改 lib/web/page-boot.js 会被覆盖 ✗）');
	assert.ok(PAGE_BOOT.includes('getLastDoc'), '生成的 page-boot.js 还是旧版');
	// 压缩产物保留属性名（`lastDoc` 小写只在宿主侧出现，别拿它当 bundle 锚点）
	assert.ok(BUNDLE.includes('getLastDoc') && BUNDLE.includes('setLastDoc'),
		'kbSideview.js 还是旧版 ⇒ 没跑 build+sync');
});

// ── fake Host 端到端 ────────────────────────────────────────────────────────
const FND = await import(new URL('../../vssaros-foundation/lib/index.js', HERE).href);
const KB = await import(new URL('../lib/index.js', HERE).href);
let handler;
const noop = () => () => {};
const foundation = FND.createFoundationService();
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({ effect: fn => { fn(); return noop(); }, connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } } });
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});
const tmp = mkdtempSync(join(tmpdir(), 'kb-lastdoc-'));
try {
	KB.apply(ctx, { dataRoot: tmp, hostHalf: true });
	const call = async (method, path, body) => {
		const out = [];
		const req = { method, url: path };
		if (method === 'POST') {
			const text = JSON.stringify(body ?? {});
			req[Symbol.asyncIterator] = async function* () { yield Buffer.from(text); };
		}
		await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
		const text = out.join('');
		return { text, json: JSON.parse(text || '{}') };
	};
	const DOC = { path: '知识库列表/AIAgent/a.md', title: 'A', vaultId: 'v1' };
	const first = await call('GET', '/x/kb/api/last-doc');
	check('⑪ 首次 GET ⇒ lastDoc=null（初次打开走默认总览）', () => {
		assert.equal(first.json.ok, true);
		assert.equal(first.json.lastDoc, null);
	});
	const wrote = await call('POST', '/x/kb/api/last-doc', { lastDoc: DOC });
	const readBack = await call('GET', '/x/kb/api/last-doc');
	check('⑫ ★ POST 写入后 GET 能读回（跨重启恢复的数据基础）', () => {
		assert.equal(wrote.json.ok, true);
		assert.equal(readBack.json.lastDoc?.path, DOC.path);
		assert.equal(readBack.json.lastDoc?.vaultId, 'v1');
	});
	await call('POST', '/x/kb/api/kb-settings', { feishu: { enabled: true, mappings: [] } });
	const afterSettings = await call('GET', '/x/kb/api/last-doc');
	check('⑬ ★★ 保存飞书设置不会冲掉 lastDoc（全量覆盖陷阱）', () => {
		assert.equal(afterSettings.json.lastDoc?.path, DOC.path, '设置保存把恢复状态清空了 ✗');
	});
	const dirty = await call('POST', '/x/kb/api/last-doc', { lastDoc: { path: '../etc/passwd' } });
	check('⑭ 脏值被拒且落盘为 null', () => {
		assert.equal(dirty.json.lastDoc, null);
	});
	const cleared = await call('POST', '/x/kb/api/last-doc', { lastDoc: null });
	check('⑮ 关闭全部文档页签（POST null）⇒ 清空，下次回到总览', () => {
		assert.equal(cleared.json.ok, true);
		assert.equal(cleared.json.lastDoc, null);
	});
	check('⑯ lastDoc 真的落进 .kb-settings.json（跨 app 重启可读）', () => {
		const disk = readFileSync(join(tmp, 'knowledge-base', '.kb-settings.json'), 'utf8');
		assert.ok(disk.includes('"lastDoc": null'), '已被 ⑮ 清空，盘上却还留着旧文档 ✗');
		assert.ok(disk.includes('"feishu"'), '设置保存把其它字段弄丢了 ✗');
	});
} catch (e) {
	fail++;
	console.log('FAIL  fake Host 端到端异常 — ' + String(e?.message ?? e));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
