/*
 * 守卫：**`/api/doc` 端到端**（服务端渲染 + 磁盘缓存，2026-10-25）。
 *
 * 覆盖三件事（都是在真实库上跑，缺库则跳过）：
 *   ① 返回 `html`（markdown-it 渲染结果）且不含未解析标记
 *   ② 第二次请求 `cached=true`（缓存命中）
 *   ③ 改动 mtime 后 `cached=false`（缓存失效，不会返回旧 HTML）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-doc-route.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VAULT = process.env.KB_VAULT || 'E:/VsSarosVault';
if (!existsSync(VAULT)) {
	console.log(`（跳过）未找到真实库：${VAULT}`);
	process.exit(0);
}

const KB = new URL('../lib/index.js', import.meta.url).href;
const FND = new URL('../../vssaros-foundation/lib/index.js', import.meta.url).href;

const mod = await import(KB);
const fnd = await import(FND);
const foundation = fnd.createFoundationService();

let handler;
const noop = () => () => {};
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({
						effect: fn => { fn(); return noop(); },
						connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } },
					});
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

const dataRoot = mkdtempSync(join(tmpdir(), 'kb-doc-route-'));
mod.apply(ctx, {
	dataRoot,
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '我的知识库', path: VAULT }]),
});

const call = async (path, method = 'GET', body = '') => {
	const out = [];
	const req = { method, url: path };
	// 路由用 `for await (const chunk of req)` 读 body ⇒ POST 必须给异步迭代器
	if (method === 'POST') {
		req[Symbol.asyncIterator] = async function* () { if (body) { yield Buffer.from(body); } };
	}
	await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

// 预热：view-data 会填充 LAST_VAULT_DIRS（读围栏要用）
await call('/x/kb/api/view-data');

// 挑一篇带 Callout 的笔记
const walk = (dir) => {
	let out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) { continue; }
		const p = join(dir, e.name);
		if (e.isDirectory()) { out = out.concat(walk(p)); } else if (/\.md$/i.test(e.name)) { out.push(p); }
	}
	return out;
};
const all = walk(join(VAULT, '笔记'));
const pick = all.find(f => readFileSync(f, 'utf8').includes('[!')) || all[0];
if (!pick) { console.log('（跳过）库里没有 md'); process.exit(0); }

const uri = '/x/kb/api/doc?uri=' + encodeURIComponent(pick.replace(/\\/g, '/'));
const first = await call(uri);
const second = await call(uri);

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

t('返回 ok 且有 html', first.ok === true && typeof first.html === 'string' && first.html.length > 50);
t('html 里没有未解析的 Callout 标记', !String(first.html || '').includes('[!'));
t('html 里有 kb-callout（该笔记确实带 Callout）', String(first.html || '').includes('kb-callout'));
t('第二次命中缓存', second.cached === true, 'cached=' + second.cached);
t('两次 html 完全一致', first.html === second.html);

// 改 mtime ⇒ 缓存必须失效（否则会把旧内容当新内容返回）
const now = new Date();
utimesSync(pick, now, now);
const third = await call(uri);
t('改 mtime 后缓存失效', third.cached !== true, 'cached=' + third.cached);

// 缓存目录落地在 `<库根>/.kb-html-cache/`（`.kb` 前缀不进树）
const cacheDir = join(VAULT, '.kb-html-cache');
t('缓存文件已落盘', existsSync(cacheDir) && readdirSync(cacheDir).some(f => f.endsWith('.json')));

// 顺带验一次服务端渲染器本身（防止 html 字段被换成原文）
t('html 是标签而非原文', /<(h1|p|ul|table|blockquote)\b/.test(String(first.html || '')));

// ── 体检报告（只读）────────────────────────────────────────────
const health = await call('/x/kb/api/health');
const rep = health.report || {};
t('体检返回 ok 且有数据', health.ok === true && Number(rep.total) > 0, 'total=' + rep.total);
t('体检结构完整（五类计数都是数字）',
	['orphanCount', 'brokenCount', 'noTagCount', 'emptyDirCount', 'dupNameCount'].every(k => typeof rep[k] === 'number'));
t('断链项带候选目标字段（字符串，可为空）',
	(rep.broken ?? []).every(x => typeof x.suggest === 'string' && typeof x.fromAbs === 'string'));
t('体检不把隐藏文件算进去', !(rep.dupNames ?? []).some(d => String(d.name).startsWith('.'))
	&& !(rep.emptyDirs ?? []).some(d => String(d).split('/').pop().startsWith('.')));

// ── 清理空目录（**必须用临时库**，绝不能拿真实库做删除测试）──────────
{
	const tmpVault = mkdtempSync(join(tmpdir(), 'kb-clean-'));
	const notes = join(tmpVault, '笔记');
	mkdirSync(join(tmpVault, '库'), { recursive: true });   // 库结构不全时 pageSnapshotOf 可能不认这个库
	mkdirSync(join(notes, '空A', '空B'), { recursive: true });
	mkdirSync(join(notes, '有文件'), { recursive: true });
	writeFileSync(join(notes, '有文件', 'x.md'), '# x', 'utf8');

	// 重新 apply 一次，把库指向临时目录（handler 会被重新捕获）
	mod.apply(ctx, {
		dataRoot: mkdtempSync(join(tmpdir(), 'kb-clean-root-')),
		hostHalf: true,
		kbVaults: JSON.stringify([{ id: 'tmp', name: '临时库', path: tmpVault }]),
	});
	await call('/x/kb/api/view-data');

	const res = await call('/x/kb/api/health/cleanup', 'POST');
	t('清理接口返回 ok', res.ok === true, JSON.stringify(res).slice(0, 120));
	t('删掉了嵌套空目录（2 个）', res.deletedCount === 2,
		'deleted=' + res.deletedCount + ' skipped=' + res.skippedCount + ' list=' + JSON.stringify(res.deleted || []) + ' why=' + JSON.stringify(res.skipped || []).slice(0, 160));
	t('空目录确实消失', !existsSync(join(notes, '空A')));
	t('笔记根保留', existsSync(notes));
	t('非空目录保留', existsSync(join(notes, '有文件', 'x.md')));

	// ── 断链修复（同一临时库）──────────────────────────────────
	const srcNote = join(notes, '源.md');
	writeFileSync(srcNote, '# 源\n\n见 [[不存在]] 与 [[不存在|别名]]\n', 'utf8');
	writeFileSync(join(notes, '目标笔记.md'), '# 目标', 'utf8');
	const uri2 = srcNote.replace(/\\/g, '/');
	const fix = await call('/x/kb/api/health/fix-link', 'POST', JSON.stringify({ uri: uri2, target: '不存在', replacement: '目标笔记' }));
	t('断链修复成功且替换 2 处', fix.ok === true && fix.replaced === 2, JSON.stringify(fix).slice(0, 120));
	const afterFix = readFileSync(srcNote, 'utf8');
	t('正文已改写（含别名的那处也在）', afterFix.includes('[[目标笔记]]') && afterFix.includes('[[目标笔记|别名]]'));
	t('修复前留了备份', existsSync(join(notes, '.kb-backup')));
	const badFix = await call('/x/kb/api/health/fix-link', 'POST', JSON.stringify({ uri: uri2, target: '目标笔记', replacement: '根本不存在的一篇' }));
	t('新目标不存在时拒绝', badFix.ok === false && String(badFix.error || '').includes('找不到'));
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（/api/doc 端到端）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（/api/doc 端到端：渲染 + 缓存 + 失效）`);
