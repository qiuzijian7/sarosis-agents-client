// @vssaros/dsh-xhs-note — 自检：草稿存储（原子/乐观锁/上限/迁移）+ 预填文案 + 静态契约。
// 跑法：node dsh-plugins/vssaros-xhs-note/test/run-xhs-note-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDrafts, readDraft, writeDraft, deleteDraft, migrateLegacy, DraftConflictError, MAX_DRAFTS, draftsDirOf, dataRootOf } from '../lib/store.js';
import { bindFoundation } from '../lib/foundationRef.js';
import { buildPrefillPrompt, prefillKey, PREFILL_HEAD } from '../lib/prefill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name + (detail ? '  — ' + String(detail).slice(0, 90) : '')); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-note-'));
const config = { dataRoot: tmp };
// 数据根委托 foundation：测试里绑一个最小假服务（生产环境由 apply() 绑真源）
bindFoundation({ dataRootOf: (cfg) => (cfg && cfg.dataRoot) || path.join(tmp, 'root') });

try {
	console.log('── 草稿存储 ──');
	const created = await writeDraft(config, { topic: '杭州三日', title: '一个人去杭州', body: '正文 A', tags: '#杭州' });
	check('新建返回 id 与 rev=1', !!created.id && created.rev === 1, JSON.stringify(created));
	const file = path.join(draftsDirOf(config), created.id + '.json');
	check('落盘到 <数据根>/xhs-note/drafts/<id>.json', fs.existsSync(file), file);
	check('没有残留 .tmp 临时文件', fs.readdirSync(draftsDirOf(config)).every((n) => !n.includes('.tmp-')));

	const list1 = await listDrafts(config);
	check('列表只返回元数据（没有 body 字段）', list1.drafts.length === 1 && list1.drafts[0].body === undefined, JSON.stringify(list1.drafts[0]));

	const updated = await writeDraft(config, { id: created.id, rev: 1, topic: '杭州三日', title: '一个人去杭州（改）', body: '正文 B' });
	check('带正确 rev 的更新成功，rev 自增到 2', updated.rev === 2, JSON.stringify(updated));

	let conflict = null;
	try { await writeDraft(config, { id: created.id, rev: 1, title: '旧窗口写入' }); }
	catch (e) { conflict = e; }
	check('rev 过期 ⇒ 抛 DraftConflictError（409）', conflict instanceof DraftConflictError && conflict.code === 'CONFLICT', conflict && conflict.message);

	const afterConflict = await readDraft(config, created.id);
	check('冲突写入没有污染磁盘（标题仍是新版）', afterConflict.title === '一个人去杭州（改）', afterConflict.title);

	let emptyErr = '';
	try { await writeDraft(config, { topic: 'x', title: ' ', body: ' ' }); } catch (e) { emptyErr = String(e.message || e); }
	check('标题与正文都为空 ⇒ 拒绝', /不能都为空/.test(emptyErr), emptyErr);

	await deleteDraft(config, created.id);
	check('删除后读不到', (await readDraft(config, created.id)) === null);
	check('删除不存在的草稿不抛错', (await deleteDraft(config, created.id)).deleted === false);

	console.log('── 迁移（旧 localStorage 一次性）──');
	const migrated = await migrateLegacy(config, [
		{ id: 'old-1', topic: '旧主题', title: '旧草稿 1', body: '老内容', tags: '#旧' },
		{ id: 'old-2', topic: '旧主题', title: '旧草稿 2', body: '老内容 2' },
	]);
	check('首次迁移导入 2 篇', migrated.imported === 2 && migrated.skipped === false, JSON.stringify(migrated));
	const again = await migrateLegacy(config, [{ id: 'old-3', title: '不该再导', body: 'x' }]);
	check('再迁移直接跳过（幂等）', again.skipped === true && again.imported === 0, JSON.stringify(again));
	check('迁移标记写在数据根', fs.existsSync(path.join(draftsDirOf(config), '.migrated-localstorage')));

	console.log('── 上限 ──');
	const capDir = path.join(tmp, 'cap', 'xhs-note', 'drafts');
	fs.mkdirSync(capDir, { recursive: true });
	for (let i = 0; i < MAX_DRAFTS; i++) {
		fs.writeFileSync(path.join(capDir, 'seed-' + i + '.json'), JSON.stringify({ id: 'seed-' + i, title: 't' + i, body: '', savedAt: '2026-01-01T00:00:00.000Z', rev: 1 }), 'utf8');
	}
	let capErr = '';
	try { await writeDraft({ dataRoot: path.join(tmp, 'cap') }, { title: '再来一篇', body: 'x' }); } catch (e) { capErr = String(e.message || e); }
	check(`已达 ${MAX_DRAFTS} 篇 ⇒ 拒绝并提示上限`, /上限/.test(capErr), capErr);

	console.log('── 数据根（委托 foundation）──');
	check('dataRootOf 走 foundation 的实现（config.dataRoot 优先）', dataRootOf({ dataRoot: tmp }) === tmp);
	check('没配 dataRoot 时用 foundation 的回落（测试里绑的假服务）', draftsDirOf({}).startsWith(path.join(tmp, 'root')), draftsDirOf({}));

	console.log('── 预填文案 ──');
	const short = buildPrefillPrompt({ topic: '杭州', title: '一个人去杭州', body: '正文', tags: '#杭州' });
	check('以固定抬头开头', short.startsWith(PREFILL_HEAD));
	check('包含主题/标题/正文/标签四段', ['【主题】杭州', '【标题】一个人去杭州', '【正文】正文', '【标签】#杭州'].every((s) => short.includes(s)), short.slice(0, 80));
	const long = buildPrefillPrompt({ topic: 't', title: 'x', body: 'A'.repeat(4000) });
	check('长正文被截断并标注后略', long.includes('…（后略，全文在工作台）') && long.length < 1200, long.length);
	check('去重键含会话/草稿/rev', prefillKey({ sessionId: 's1', draftId: 'd1', rev: 3 }) === 's1|d1|3');

	console.log('── HTTP 路由（假 ctx 捕获 handler，真发请求）──');
	{
		const { apply } = await import('../lib/index.js');
		let handler = null;
		const fakeCtx = {
			get: () => null,
			inject: (deps, cb) => {
				if (deps.includes('webServer')) {
					cb({
						effect: (fn) => fn(),
						webServer: { register: (route) => { handler = route.handler; return () => {}; } },
						connection: { requestRejection: () => 0 },
					});
				}
			},
			effect: (fn) => fn(),
			logger: { info: () => {} },
		};
		apply(fakeCtx, config);
		check('captured webServer handler', typeof handler === 'function');

		const call = async (method, pathname, body) => {
			const { Readable } = await import('node:stream');
			const req = Readable.from(body ? [Buffer.from(JSON.stringify(body), 'utf8')] : []);
			req.method = method;
			req.url = pathname;
			req.headers = {};
			const chunks = [];
			const res = {
				writeHead: (status) => { res.status = status; },
				end: (payload) => { if (payload) { chunks.push(String(payload)); } },
			};
			await handler(req, res);
			const text = chunks.join('');
			let json = null;
			try { json = JSON.parse(text); } catch { /* HTML */ }
			return { status: res.status, text, json };
		};

		const empty = await call('GET', '/x/xhs-note/api/drafts');
		check('GET 列表返回 ok + 空数组', empty.status === 200 && Array.isArray(empty.json.drafts), JSON.stringify(empty.json && empty.json.drafts));
		const created2 = await call('POST', '/x/xhs-note/api/drafts', { topic: '路线', title: '杭州两日', body: '正文' });
		check('POST 新建返回 id/rev', created2.status === 200 && !!created2.json.id && created2.json.rev === 1, JSON.stringify(created2.json));
		const conflict = await call('POST', '/x/xhs-note/api/drafts/' + encodeURIComponent(created2.json.id), { rev: 99, title: 'x' });
		check('rev 不匹配 ⇒ 409（HTTP 层也守住）', conflict.status === 409, JSON.stringify(conflict.json));
		const one = await call('GET', '/x/xhs-note/api/drafts/' + encodeURIComponent(created2.json.id));
		check('GET 单篇返回全文', one.status === 200 && one.json.draft.title === '杭州两日');
		const gone = await call('DELETE', '/x/xhs-note/api/drafts/' + encodeURIComponent(created2.json.id));
		check('DELETE 删除成功', gone.status === 200 && gone.json.deleted === true);
		const page = await call('GET', '/x/xhs-note/');
		check('页面壳带 data-vssaros-page="xhs-note"', page.status === 200 && page.text.includes('data-vssaros-page="xhs-note"'));
	}

	console.log('── 静态契约 ──');
	const chunkSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'client.xhs-note.js'), 'utf8');
	const bare = chunkSrc.split(/\r?\n/).filter((line) => !line.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(line) || /\b(rgba?|hsla?)\(/.test(line)));
	check('组件里没有裸色值（颜色只走令牌）', bare.length === 0, bare.slice(0, 2).join(' | '));
	const wbClasses = new Set(chunkSrc.match(/\bwb-[a-z-]+/g) || []);
	check('用共享层原语（≥10 个不同 wb-* 类）', wbClasses.size >= 10, wbClasses.size + ' 个');
	check('根节点带 data-vssaros-surface="workbench"', /data-vssaros-surface':\s*'workbench'/.test(chunkSrc));
	check('工具栏锚点恰好 1 处', (chunkSrc.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
	check('对话停靠点存在', chunkSrc.includes('data-vssaros-xhs-conversation'));
	check('用容器查询（不是 @media 判宽）', chunkSrc.includes('@container') && !/@media/.test(chunkSrc));

	const entrySrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf8');
	check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(entrySrc));
	check('入口不重复声明注册（注册在子块，守卫才认得出组件文件）', !entrySrc.includes('desktopWorkbenches.register'));
	const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
	check('子块里注册工作台', chunkSrc.includes('desktopWorkbenches.register'));
	check('描述符与清单 title 一致', chunkSrc.includes(`title: '${pkg.vssaros.workbench.title}'`));
	check('描述符与清单 description 一致', chunkSrc.includes(pkg.vssaros.workbench.description));
	check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh.client.inject || []).includes('@vssaros/dsh-workbenches'));
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n[xhs-note] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
