// @vssaros/dsh-memory — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-memory/test/run-memory-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑：详情页常量（页签 / 分页）+ renderDetailPage 冒烟（10 个页签都在、空数据不崩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DETAIL_PAGE_SIZE, DETAIL_ROUTE, DETAIL_VIEWS, renderDetailPage } from '../lib/detail.js';

// 详情页渲染会用到数据根（委托 @vssaros/dsh-foundation）——包内自检不装宿主，
// 用 foundationRef 提供的**探针后门**（`globalThis.__VSSAROS_FOUNDATION__`）塞一个最小实现。
globalThis.__VSSAROS_FOUNDATION__ = {
	dataRootOf: () => path.join(os.tmpdir(), 'vssaros-memory-check'),
	// 详情页 HTML 也要它转义（foundation 里那份是唯一真源；这里给最小等价实现）
	escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listLib = (dir = path.join(ROOT, 'lib'), out = []) => {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { listLib(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
};
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name + (detail ? '  — ' + String(detail).slice(0, 90) : '')); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

const pkg = JSON.parse(read('package.json'));

console.log('── 清单与激活 ──');
check('包名', pkg.name === '@vssaros/dsh-memory', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-memory'`));

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const component = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:memory'/.test(src));
// ★ 2026-11-02（用户：「记忆库中，移除右侧 AI 助手栏」）：
//   真正生效的是**运行期描述符**（宿主 normalize 它），清单只做登记展示（且白名单不含 splitConversation）。
{
	check('运行期描述符关闭常驻对话列（splitConversation:false ⇒ 记忆面板独占整幅）',
		/splitConversation:\s*false/.test(src), '找不到 splitConversation:false');
	// 断言"写在描述符里"而不是"写在清单里"：清单校验器不认识这个键，写了会让插件清单解析失败
	check('splitConversation 不写进清单（IDE 清单白名单不含它，写了会抛"不认识的字段"）',
		pkg.vssaros?.workbench?.splitConversation === undefined, String(pkg.vssaros?.workbench?.splitConversation));
	// layout 只在分栏模式下生效；保留它是为了将来重开分栏时位置正确 ⇒ 这里只钉"重开时业务在左"
	const rtSide = (src.match(/layout:\s*\{[^}]*businessSide:\s*'([a-z]+)'/) || [])[1];
	check('重开分栏时业务面板在左（businessSide=left）', rtSide === 'left', String(rtSide));
	// 文案不能继续承诺「边对话边看记忆」——助手栏已经不在这个工作台里了
	check('描述不再承诺"边对话边看记忆"（助手栏已移除）',
		!/边对话边看记忆/.test(String(pkg.vssaros?.workbench?.description) + src), String(pkg.vssaros?.workbench?.description));
}

/**
 * ★ 行为断言（不只是"源码里有个 false"）：把本包描述符交给**宿主外壳自己的 `normalize()`** 跑一遍，
 * 看规范化结果里 `splitConversation` 是否真的变成 false（`conversationMode()` 据此判 `detach` ⇒ 不渲染对话列）。
 * 这样"改错位置/键名拼错/被 normalize 默认值覆盖"都会红，而不是只在人眼前错一次。
 */
{
	const loadChunk = (file, fakeReact) => {
		let mod = null;
		const win = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(name => (name === 'react' ? fakeReact : (() => { throw new Error('unexpected require ' + name); })())); } } };
		const doc = { addEventListener() { }, getElementById() { return null; }, createElement() { return { style: {}, setAttribute() { } }; }, head: { appendChild() { } } };
		new Function('window', 'document', fs.readFileSync(file, 'utf8'))(win, doc);
		return mod;
	};
	// 外壳 chunk 里 `class … extends React.Component` / 各类 hook 都要有，否则加载期就抛（不是断言失败）
	const fakeReact = {
		createElement: () => null, Fragment: 'F',
		Component: class { }, PureComponent: class { },
		useState: (v) => [typeof v === 'function' ? v() : v, () => { }],
		useEffect: () => { }, useLayoutEffect: () => { }, useInsertionEffect: () => { },
		useCallback: (f) => f, useMemo: (f) => f(), useRef: (v) => ({ current: v ?? null }),
		useReducer: (r, i) => [i, () => { }], useContext: () => ({}),
		createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }),
		forwardRef: (f) => f, memo: (f) => f,
	};
	let ok = '未执行';
	try {
		const mem = loadChunk(path.join(ROOT, 'lib', 'client.memory.js'), fakeReact);
		const shellFile = path.resolve(ROOT, '..', 'vssaros-workbenches', 'lib', 'client.js');
		const Comp = function Comp() { return null; };
		const shell = (() => {
			let m = null;
			const win = { __ModuleLoader__: { load: ({ factory }) => { m = factory(name => (name === 'react' ? fakeReact : (name === 'react-dom' ? { createPortal: () => null } : (() => { throw new Error('unexpected require ' + name); })()))); } }, location: { search: '', hash: '', origin: 'http://127.0.0.1:1' } };
			const doc = { getElementById: () => ({}), createElement: () => ({ style: {}, setAttribute() { } }), head: { appendChild() { } } };
			new Function('window', 'globalThis', 'document', fs.readFileSync(shellFile, 'utf8'))(win, {}, doc);
			return m;
		})();
		const entry = shell.normalize(mem.__DESCRIPTOR, Comp);
		check('宿主 normalize() 后 splitConversation=false（⇒ conversationMode 判 detach，不渲染对话列）',
			entry.splitConversation === false, JSON.stringify({ customFrame: entry.customFrame, splitConversation: entry.splitConversation }));
		check('宿主 normalize() 保留 customFrame=false（不误判成"整页内嵌"）', entry.customFrame === false, String(entry.customFrame));
		ok = '';
	} catch (e) {
		check('行为断言：描述符经宿主 normalize()', false, String(e && e.message || e));
		ok = '';
	}
	void ok;
}
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 详情页常量 ──');
check('详情路由是 /x/memory/detail', DETAIL_ROUTE === '/x/memory/detail', DETAIL_ROUTE);
check('分页 50 条', DETAIL_PAGE_SIZE === 50, String(DETAIL_PAGE_SIZE));
check('页签 10 个', DETAIL_VIEWS.length === 10, String(DETAIL_VIEWS.length));
check('页签 id 唯一', new Set(DETAIL_VIEWS.map((v) => v.id)).size === DETAIL_VIEWS.length);
check('前三个页签是 记忆/会话/槽位', DETAIL_VIEWS.slice(0, 3).map((v) => v.id).join(',') === 'memories,sessions,slots', DETAIL_VIEWS.slice(0, 3).map((v) => v.id).join(','));
check('每个页签都有 label（emoji + 中文）', DETAIL_VIEWS.every((v) => typeof v.label === 'string' && v.label.length > 0));

console.log('── renderDetailPage 冒烟（空数据不崩）──');
{
	const model = {
		params: new URLSearchParams('view=memories'),
		agentId: 'main',
		items: [], tierCounts: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
		typeCounts: {}, extStats: {}, agents: [], slotNames: [], sessions: [], summaries: [],
	};
	let out = null;
	let err = '';
	try { out = renderDetailPage(model); } catch (e) { err = String(e?.message || e); }
	check('空数据渲染不抛错', !err, err);
	const body = String(out?.body || out || '');
	check('渲染结果是一段 HTML', body.length > 200 && body.includes('<'), String(body.length) + ' 字符');
	check('页面带 data-vssaros-page 锚点', /data-vssaros-page/.test(body));
	check('10 个页签的标签都在页面上', DETAIL_VIEWS.every((v) => body.includes(v.label) || body.includes(v.id)));
}

console.log(`\n[memory] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
