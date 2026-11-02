/*
 * 「知识库列表 = 知识库容器」契约守卫（★ 2026-11-02 P1）
 *
 *   规则：`<vault>/知识库列表/<名称>/` 就是**一个知识库**；「新建知识库」= 建这个文件夹。
 *
 *   钉四类东西：
 *     ① 名称校验（安全边界）：空 / `..` / 点开头 / 非法字符 / 保留名 / 点空格结尾 全部拒绝
 *     ② 新建：建目录 + index.md；同名再建 ⇒ `exists`（不覆盖）
 *     ③ 列表：只列一级子目录（散文件、点目录不算），带篇数 / 更新时间 / 是否已绑飞书
 *     ④ 接线：宿主有 `/api/kb-create`、`/api/kb-list` 两条路由；界面有「新建知识库」入口
 *
 *   跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-kblist.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const ops = await import('file:///' + path.join(LIB, 'core', 'kbLayoutOps.js').replace(/\\/g, '/'));
const home = await import('file:///' + path.join(LIB, 'homePage.js').replace(/\\/g, '/'));
const kbSrc = fs.readFileSync(path.join(LIB, 'core', 'kb.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const bundle = fs.readFileSync(path.join(LIB, 'web', 'kbSideview.js'), 'utf8');

let fail = 0;
const check = (name, fn) => {
	try {
		const d = fn();
		console.log('PASS  ' + name + (d ? '  — ' + d : ''));
	} catch (e) {
		fail += 1;
		console.log('FAIL  ' + name + '  — ' + String((e && e.message) || e).slice(0, 180));
	}
};

// ── ① 名称校验 ────────────────────────────────────────────────────────────
check('名称校验：合法名通过', () => {
	const ok = ['AI_Agent', '团队 UI 知识库', 'v1.2 规范', '数据-2026'].every((n) => ops.validateKbName(n).ok);
	if (!ok) { throw new Error('合法名被拒'); }
	return '4 个';
});

check('名称校验：非法名全部拒绝（含路径穿越 / 保留名 / 隐藏目录）', () => {
	// 注：尾部空格不在列表里 —— `validateKbName` 会先 trim，`'trail '` ⇒ `'trail'` 是**合法**的（Windows 不允许尾空格，trim 掉才对）
	const bad = ['', '   ', '.', '..', '../evil', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'CON', 'lpt1', '.hidden', 'trail.'];
	const leaked = bad.filter((n) => ops.validateKbName(n).ok);
	if (leaked.length) { throw new Error('放行了：' + JSON.stringify(leaked)); }
	return bad.length + ' 个';
});

// ── ② 新建 / ③ 列表 ───────────────────────────────────────────────────────
const vault = path.join(os.tmpdir(), 'kb-kblist-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
try {
	fs.mkdirSync(path.join(vault, ops.KB_LIST_DIR), { recursive: true });
	fs.writeFileSync(path.join(vault, ops.KB_LIST_DIR, 'loose.md'), '# 散文件\n', 'utf8');
	fs.mkdirSync(path.join(vault, ops.KB_LIST_DIR, '.hidden'), { recursive: true });

	check('新建：建目录 + index.md', () => {
		const r = ops.createKnowledgeBase(vault, 'AI_Agent');
		if (!r.ok) { throw new Error(r.error); }
		if (!fs.existsSync(path.join(vault, ops.KB_LIST_DIR, 'AI_Agent', 'index.md'))) { throw new Error('缺 index.md'); }
		return JSON.stringify(r.created);
	});

	check('新建：同名再建 ⇒ exists（不覆盖）', () => {
		fs.writeFileSync(path.join(vault, ops.KB_LIST_DIR, 'AI_Agent', 'a.md'), '# A\n', 'utf8');
		const r = ops.createKnowledgeBase(vault, 'AI_Agent');
		if (r.ok || r.code !== 'exists') { throw new Error('没报 exists：' + JSON.stringify(r)); }
		if (!fs.existsSync(path.join(vault, ops.KB_LIST_DIR, 'AI_Agent', 'a.md'))) { throw new Error('已有内容被覆盖'); }
		return 'ok';
	});

	check('新建：withIndex=false 时不生成 index.md', () => {
		const r = ops.createKnowledgeBase(vault, 'NoIndex', { withIndex: false });
		if (!r.ok) { throw new Error(r.error); }
		if (fs.existsSync(path.join(vault, ops.KB_LIST_DIR, 'NoIndex', 'index.md'))) { throw new Error('不该有 index.md'); }
		return 'ok';
	});

	check('列表：只列一级子目录（散文件 / 点目录不算），带篇数与飞书标记', () => {
		fs.writeFileSync(path.join(vault, ops.KB_LIST_DIR, 'AI_Agent', ops.KB_FEISHU_FILE), '{"spaceId":"S1"}', 'utf8');
		const list = ops.listKnowledgeBases(vault);
		const names = list.map((x) => x.name).sort();
		if (JSON.stringify(names) !== JSON.stringify(['AI_Agent', 'NoIndex'])) { throw new Error('列出的库不对：' + names.join(',')); }
		const ai = list.find((x) => x.name === 'AI_Agent');
		if (ai.docs !== 2) { throw new Error('篇数不对（应 2：index + a）：' + ai.docs); }
		if (!ai.hasFeishu) { throw new Error('未识别 .kb-feishu.json'); }
		if (!ai.rel.startsWith(ops.KB_LIST_DIR + '/')) { throw new Error('rel 不是知识库列表下的相对路径'); }
		return names.join(' / ');
	});

	check('列表：库根不存在时返回空数组（不抛错）', () => {
		const r = ops.listKnowledgeBases(path.join(vault, '不存在的库根'));
		if (!Array.isArray(r) || r.length) { throw new Error('应返回 []'); }
		return '[]';
	});
} finally {
	fs.rmSync(vault, { recursive: true, force: true });
}

// ── ④ 接线 ────────────────────────────────────────────────────────────────
check('契约：kbLayoutOps 的目录名与 core/kb.js 的 NOTES_DIR 一致', () => {
	const m = /export const NOTES_DIR = '([^']+)'/.exec(kbSrc);
	if (!m || m[1] !== ops.KB_LIST_DIR) { throw new Error('NOTES_DIR=' + (m && m[1]) + ' ≠ ' + ops.KB_LIST_DIR); }
	return ops.KB_LIST_DIR;
});

check('路由：宿主有 /api/kb-create 与 /api/kb-list', () => {
	const miss = [];
	if (!idxSrc.includes('/api/kb-create')) { miss.push('/api/kb-create'); }
	if (!idxSrc.includes('/api/kb-list')) { miss.push('/api/kb-list'); }
	if (miss.length) { throw new Error('缺：' + miss.join(', ')); }
	return 'ok';
});

check('界面：面板脚本里有「新建知识库」入口并调用 kb-create', () => {
	if (!bundle.includes('kb-create')) { throw new Error('bundle 没有调用 kb-create'); }
	if (!/新建知识库/.test(bundle) && !/\\u65b0\\u5efa\\u77e5\\u8bc6\\u5e93/i.test(bundle)) { throw new Error('bundle 没有「新建知识库」文案'); }
	return 'ok';
});

// ── ⑤ 每库飞书绑定 ────────────────────────────────────────────────────────
const vault2 = path.join(os.tmpdir(), 'kb-bind-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
try {
	fs.mkdirSync(path.join(vault2, ops.KB_LIST_DIR, 'AI_Agent'), { recursive: true });

	check('绑定：写入 .kb-feishu.json（就近存，库被拷走也不丢）', () => {
		const r = ops.writeFeishuBinding(vault2, 'AI_Agent', { spaceId: '7688351135437982979', spaceName: 'AI_Agent' });
		if (!r.ok) { throw new Error(r.error); }
		const p = path.join(vault2, ops.KB_LIST_DIR, 'AI_Agent', ops.KB_FEISHU_FILE);
		if (!fs.existsSync(p)) { throw new Error('文件没落盘'); }
		const back = ops.readFeishuBinding(vault2, 'AI_Agent');
		if (!back || back.spaceId !== '7688351135437982979') { throw new Error('读回来不对'); }
		if (back.syncMode !== 'upload') { throw new Error('syncMode 默认应为 upload'); }
		return back.spaceId;
	});

	check('绑定：非法 spaceId 拒绝 / 不存在的库 404', () => {
		const bad = ops.writeFeishuBinding(vault2, 'AI_Agent', { spaceId: 'a b' });
		if (bad.ok || bad.code !== 'bad-space') { throw new Error('非法 spaceId 没被拒：' + JSON.stringify(bad)); }
		const nokb = ops.writeFeishuBinding(vault2, 'NotExists', { spaceId: 'abcd1234' });
		if (nokb.ok || nokb.code !== 'no-kb') { throw new Error('不存在的库没报 no-kb'); }
		return 'ok';
	});

	check('绑定：库名带 ../ 时拒绝（路径越界）', () => {
		const r = ops.writeFeishuBinding(vault2, '../evil', { spaceId: 'abcd1234' });
		if (r.ok || r.code !== 'invalid-name') { throw new Error('越界没被挡：' + JSON.stringify(r)); }
		return 'ok';
	});

	check('绑定：解除 ⇒ 文件删除、库目录保留', () => {
		const r = ops.clearFeishuBinding(vault2, 'AI_Agent');
		if (!r.ok || !r.cleared) { throw new Error('解除失败：' + JSON.stringify(r)); }
		if (fs.existsSync(path.join(vault2, ops.KB_LIST_DIR, 'AI_Agent', ops.KB_FEISHU_FILE))) { throw new Error('文件还在'); }
		if (!fs.existsSync(path.join(vault2, ops.KB_LIST_DIR, 'AI_Agent'))) { throw new Error('库目录被误删'); }
		return 'cleared';
	});
} finally {
	fs.rmSync(vault2, { recursive: true, force: true });
}

check('路由：/api/kb-bind 与 /api/kb-unbind 都在', () => {
	const miss = ['/api/kb-bind', '/api/kb-unbind'].filter((k) => !idxSrc.includes(k));
	if (miss.length) { throw new Error('缺：' + miss.join(', ')); }
	return 'ok';
});

check('界面：右键菜单有「关联飞书知识库」入口', () => {
	if (!bundle.includes('kb-bind')) { throw new Error('bundle 没调用 kb-bind'); }
	if (!/关联飞书/.test(bundle) && !/\\u5173\\u8054\\u98de\\u4e66/i.test(bundle)) { throw new Error('bundle 没有「关联飞书」文案'); }
	return 'ok';
});

check('view-data 带出 kbs（前端据它渲染「📚 N 库」与行悬停）', () => {
	if (!/kbs:\s*\(\(\)\s*=>/.test(idxSrc) || !idxSrc.includes('listKnowledgeBases(vault.dir')) {
		throw new Error('view-data 没把 kbs 带上');
	}
	return 'ok';
});

check('界面：树行有悬停说明（rowTitle），且不破坏 Obsidian 风格（不加图标列）', () => {
	if (!bundle.includes('rowTitle')) { throw new Error('bundle 没有 rowTitle'); }
	// ⚠ bundle 是压缩产物：局部变量名会被改名（`kbList` 查不到是正常的），
	//   但 emoji 与属性名会保留 ⇒ 查 📚 的码位（U+1F4DA，可能被转义成 \u{1F4DA} / 代理对）
	if (!/1f4da/i.test(bundle)) { throw new Error('bundle 没有 📚 小签（U+1F4DA）'); }
	return 'ok';
});

check('关联飞书：能列出真实空间（下拉），拿不到时退回手填', () => {
	if (!bundle.includes('data-kb-spacepick')) { throw new Error('bundle 没有空间下拉'); }
	if (!bundle.includes('feishu-spaces')) { throw new Error('bundle 没调 /api/feishu-spaces'); }
	return 'ok';
});

check('主页：侧栏只留入口（不再堆卡片），整页在中间栏', () => {
	// ★ 2026-11-02：总览从「侧栏内展开」改为「侧栏一行入口 + 中间栏独立页」
	if (bundle.includes('data-kb-overview')) { throw new Error('bundle 里还有旧的侧栏总览块'); }
	if (!bundle.includes('data-kb-homeentry')) { throw new Error('bundle 缺总览入口行'); }
	/*
	 * ★ 2026-11-02（用户报「点总览显示空白」）：
	 *   主页**必须在本页内以覆盖层呈现**（`/x/kb/` 就是那个侧栏本身）。
	 *   ⚠ 不许再走 `__vssarosOpenPageTab`：那是 shell 的中栏工作台面板，只认白名单 route，
	 *     传自定义 route 会被忽略 ⇒ 实际渲染成 `/x/dashboard/` ⇒ 纯白 ✗
	 */
	/*
	 * ★ 2026-11-02 三次修订（用户截图）：总览要成为**本页中栏页签条上的一个页签**
	 *   （与文档/设置/图谱/导图并列）⇒ 覆盖层方案已废弃。
	 */
	if (!bundle.includes('data-kb-home-tab') || !bundle.includes('data-kb-home-pane')) {
		throw new Error('bundle 缺「总览」页签（data-kb-home-tab / data-kb-home-pane）');
	}
	if (bundle.includes('data-kb-home-overlay')) {
		throw new Error('bundle 里还有旧的覆盖层（应已改为页签）');
	}
	const nav = fs.readFileSync(path.join(HERE, '..', '..', 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'), 'utf8');
	const wb = /function openWorkbenchTab\(it\)\s*\{[\s\S]{0,400}?pendingTabOpen\s*=\s*it\.id/.exec(nav);
	if (!wb) { throw new Error('chat-surface: openWorkbenchTab 没写 pendingTabOpen（页签会被抢回 dashboard）'); }
	return 'ok';
});

check('主页：点卡片能定位回侧栏（postMessage 双向契约）', () => {
	// 页面侧：发 { source:'kb-home', type:'open-kb', kb }
	if (!/source:\s*'kb-home'/.test(bundle) && !bundle.includes('kb-home')) {
		throw new Error('面板侧没有处理 kb-home 消息');
	}
	const homeSrc = fs.readFileSync(path.join(LIB, 'homePage.js'), 'utf8');
	if (!homeSrc.includes("source: 'kb-home'") || !homeSrc.includes("type: 'open-kb'")) {
		throw new Error('homePage.js 没有发 open-kb 消息');
	}
	if (!/window\.parent\.postMessage/.test(homeSrc)) { throw new Error('homePage.js 没走 parent.postMessage'); }
	return 'ok';
});

check('防白屏：hook 依赖里不许引用「后面才声明」的 const（TDZ ⇒ 整页崩）', () => {
	/*
	 * 2026-11-02 真机白屏的根因：`useEffect(..., [.., showToast])` 而 `showToast` 定义在更下面
	 *   ⇒ 依赖数组在 hook 调用点求值 ⇒ ReferenceError: Cannot access 'xx' before initialization
	 *   ⇒ bundle 渲染崩溃，界面只剩空白（压缩后变量名是 'ct'，极难认）。
	 * 这里钉住这一条：本文件的 effect 依赖里不得出现 `showToast`。
	 */
	const tsx = fs.readFileSync(path.join(HERE, '..', '..', '..', 'src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx'), 'utf8');
	const lines = tsx.split('\n');
	const declAt = lines.findIndex((l) => /const showToast|function showToast/.test(l));
	if (declAt < 0) { throw new Error('找不到 showToast 声明'); }
	// 只有「出现在声明之前」的依赖才真会 TDZ（声明之后引用的三处是安全的，别误报）
	const offenders = [];
	lines.forEach((l, i) => {
		if (i >= declAt) { return; }
		if (/\[[^\]]*\bshowToast\b[^\]]*\]/.test(l)) { offenders.push('L' + (i + 1)); }
	});
	if (offenders.length) { throw new Error('依赖数组在 showToast 声明（L' + (declAt + 1) + '）之前引用它 ⇒ TDZ：' + offenders.join(',')); }
	// 且 bundle 必须还能构建出「kb-home 消息处理」这段
	if (!bundle.includes('kb-home')) { throw new Error('bundle 缺 kb-home 消息处理'); }
	return 'ok';
});

check('防空白：索引缺失时 /api/page 自动重建（删了必须补）', () => {
	// 症状：迁移/首次使用删了 .kb/kernel.json ⇒ 页面按索引渲染 ⇒ 全 0 篇、看起来"没内容"
	if (!idxSrc.includes('索引缺失就自动重建')) { throw new Error('/api/page 没有自动重建兜底'); }
	if (!/rebuildKernelCache\(dir\)/.test(idxSrc)) { throw new Error('/api/page 没真正调 rebuildKernelCache'); }
	const mig = fs.readFileSync(path.join(HERE, 'kb-migrate-layout.mjs'), 'utf8');
	if (!mig.includes('rebuildKernelCache')) { throw new Error('迁移脚本删完索引没重建'); }
	return 'ok';
});

check('主页：真实数据 —— 近 7 天改动（mtime 聚合）+ index.md 摘要', () => {
	const v = path.join(os.tmpdir(), 'kb-guard-week-' + Date.now());
	try {
		fs.mkdirSync(path.join(v, '知识库列表', 'A'), { recursive: true });
		fs.writeFileSync(path.join(v, '知识库列表', 'A', 'index.md'), '# A\n\n> 新建于 x\n\n这是说明文字。\n', 'utf8');
		fs.writeFileSync(path.join(v, '知识库列表', 'A', 'n1.md'), '# n1\n', 'utf8');
		fs.mkdirSync(path.join(v, '知识库列表', 'B'), { recursive: true });
		const old = path.join(v, '知识库列表', 'B', 'old.md');
		fs.writeFileSync(old, '# old\n', 'utf8');
		const past = new Date(Date.now() - 30 * 864e5);
		fs.utimesSync(old, past, past);

		const l = ops.listKnowledgeBases(v);
		const A = l.find((k) => k.name === 'A');
		const B = l.find((k) => k.name === 'B');
		if (!A || A.weekNew !== 2) { throw new Error('A 的 weekNew 应为 2，实际 ' + (A && A.weekNew)); }
		if (!A.excerpt || !A.excerpt.includes('这是说明文字')) { throw new Error('A 没取到 index.md 摘要：' + JSON.stringify(A.excerpt)); }
		if (!B || B.weekNew !== 0) { throw new Error('B（30 天前的文件）不该算近 7 天改动'); }

		const page = home.renderHomePage({ vaultName: 'V', kbs: l });
		if (!page.includes('近 7 天改动') || !page.includes('7 天 +')) { throw new Error('页面缺近 7 天口径'); }
		if (!page.includes('class="ex"')) { throw new Error('页面缺摘要渲染'); }
		return 'weekNew / excerpt ✓';
	} finally {
		fs.rmSync(v, { recursive: true, force: true });
	}
});

check('主页：「新建知识库」用页内弹窗，不许用 window.prompt', () => {
	const homeSrc = fs.readFileSync(path.join(LIB, 'homePage.js'), 'utf8');
	// Electron 里 prompt 会被阻塞甚至不弹（本仓多处踩过）⇒ 必须自己画弹窗
	if (/window\.prompt\s*\(/.test(homeSrc)) { throw new Error('homePage.js 又用回 window.prompt 了'); }
	if (!homeSrc.includes('id="mask"') || !homeSrc.includes('id="kbname"')) { throw new Error('缺页内弹窗结构'); }
	// 关联飞书：建库后可选调 kb-bind
	if (!homeSrc.includes('/api/kb-bind')) { throw new Error('缺少「建库同时关联飞书」的能力'); }
	return 'ok';
});

check('主页：插件侧有 /x/kb/home 页面渲染（纯函数 + 路由）', () => {
	if (typeof home.renderHomePage !== 'function') { throw new Error('homePage.js 没导出 renderHomePage'); }
	const html = home.renderHomePage({ vaultName: 'V', kbs: [{ name: 'A', docs: 3, hasFeishu: true }] });
	if (!html.includes('知识库主页') || !html.includes('data-kb="A"') || !html.includes('newCard')) {
		throw new Error('渲染结果缺关键元素');
	}
	// ⚠ ROUTE_PREFIX 已是 `/x/kb` ⇒ 路由是 `${ROUTE_PREFIX}/home`（写成 /kb/home 会变成 /x/kb/kb/home）
	if (!idxSrc.includes('${ROUTE_PREFIX}/home`')) { throw new Error('index.js 没有 /x/kb/home 路由'); }
	return 'ok';
});

console.log('\n============================================================');
console.log(fail ? '✗ ' + fail + ' 项失败' : '✓ 全部「知识库=文件夹」契约通过');
process.exit(fail ? 1 : 0);
