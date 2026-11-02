#!/usr/bin/env node
/*
 * 把库根散落的中间文件搬进 `.kb/`（★ 2026-11-02，用户：「仿 obsidian 放到一个文件夹中」）。
 *
 * 迁移映射（旧 → 新）：
 *   .kbkernel.json              → .kb/kernel.json
 *   .ftindex.json               → .kb/ftindex.json
 *   .feishu-sync.json           → .kb/feishu-sync.json      （**最关键：丢了会重复上传**）
 *   .feishu-space-map.json      → .kb/space-map.json
 *   .kb-layout.json             → .kb/layout.json
 *   .kb-build-cache.json        → .kb/build-cache.json
 *   .kb-ingest-cache.json       → .kb/ingest-cache.json
 *   .kb-insights-cache.json     → .kb/insights-cache.json
 *   .kb-topic-overview-cache.json → .kb/topic-overview-cache.json
 *   kb-schema.json              → .kb/schema.json
 *   .op-log.jsonl               → .kb/op-log.jsonl
 *   .kb-html-cache/             → .kb/html-cache/           （整目录搬）
 *   .kb-*.bak-* 等备份          → 原样留在根（它们是历史，不动）
 *
 * 另外：
 *   · `<库根>/.gitignore` 里那些逐文件的忽略项收敛成 `.kb/`
 *   · 数据源/知识库列表里的同名缓存（`.kb-insights-cache.json` 等）也一并下沉
 *
 * 用法：
 *   node scripts/kb-migrate-meta.mjs --vault "E:/VsSarosVault"           # 干跑
 *   node scripts/kb-migrate-meta.mjs --vault "E:/VsSarosVault" --apply   # 真做
 */

import fs from 'node:fs';
import path from 'node:path';

import { META_DIR, META_KEYS, META_NAME, META_LEGACY_NAME, metaDir, metaPath, metaLegacyPath } from '../lib/core/kbMeta.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const at = argv.indexOf('--vault');
const VAULT = path.resolve(at >= 0 ? argv[at + 1] : '');

if (!VAULT || !fs.existsSync(VAULT)) {
	console.log('✗ 用法：--vault <库根>');
	process.exit(1);
}

const log = (s) => console.log(s);
const sizeOf = (p) => {
	const st = fs.statSync(p);
	if (st.isFile()) { return st.size; }
	let s = 0;
	for (const e of fs.readdirSync(p, { withFileTypes: true })) { s += sizeOf(path.join(p, e.name)); }
	return s;
};
const mb = (n) => (n > 1024 * 1024 ? Math.round(n / 1024 / 1024 * 10) / 10 + 'MB' : Math.round(n / 1024) + 'KB');

log('═'.repeat(60));
log('库：' + VAULT);
log('模式：' + (APPLY ? '★ APPLY' : 'dry-run'));
log('═'.repeat(60));

let moved = 0;
let bytes = 0;

const moveOne = (from, to, label) => {
	if (!fs.existsSync(from)) { return; }
	if (fs.existsSync(to)) {
		log('   ! 跳过（新位置已存在，保留两份）：' + label);
		return;
	}
	const sz = sizeOf(from);
	if (APPLY) {
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
	}
	log('   ✓ ' + (APPLY ? '' : '将 ') + label.padEnd(40) + mb(sz));
	moved += 1;
	bytes += sz;
};

log('\n① 库根散件 → .kb/');
// ⚠ `nav` 不是"库根单文件"，而是 `知识库列表/*.md` 里的 4 个固定名 ⇒ 由 ②.6 单独处理
for (const k of META_KEYS.filter((x) => x !== 'nav')) {
	moveOne(metaLegacyPath(VAULT, k), metaPath(VAULT, k), META_LEGACY_NAME[k] + ' → ' + META_DIR + '/' + META_NAME[k]);
}

/* 子目录里的同名缓存（历史写法：<notesDir>/.kb-insights-cache.json） */
log('\n② 子目录里的同名缓存 → 库级 .kb/');
const subDirs = ['知识库列表', '笔记', '数据源', '库'];
for (const sd of subDirs) {
	const dir = path.join(VAULT, sd);
	if (!fs.existsSync(dir)) { continue; }
	for (const key of ['insightsCache', 'topicCache']) {
		const legacy = path.join(dir, META_LEGACY_NAME[key]);
		if (!fs.existsSync(legacy)) { continue; }
		// 目标按"库级"存，避免同一个缓存两份
		const to = metaPath(VAULT, key);
		moveOne(legacy, to, sd + '/' + META_LEGACY_NAME[key] + ' → ' + META_DIR + '/' + META_NAME[key]);
	}
}

/* 日志与备份（同属"中间文件"，一并下沉） */
log('\n②.5 日志与备份 → .kb/');
for (const [oldName, newName] of [
	['.feishu-sync.log', 'feishu-sync.log'],
	['.kb-feishu-sync.log', 'feishu-sync-full.log'],
]) {
	moveOne(path.join(VAULT, oldName), path.join(metaDir(VAULT), newName), oldName + ' → ' + META_DIR + '/' + newName);
}
const rootFiles = fs.readdirSync(VAULT, { withFileTypes: true }).filter((e) => !e.isDirectory());
for (const e of rootFiles) {
	if (!/\.bak-/.test(e.name)) { continue; }
	moveOne(path.join(VAULT, e.name), path.join(metaDir(VAULT), 'backup', e.name), e.name + ' → ' + META_DIR + '/backup/');
}

/*
 * 导航三件 + 日志（★ 2026-11-02 第二轮）：原来是**写进 `知识库列表/` 根**的派生物，
 *   现在统一落到 `<vault>/.kb/nav/`（与插件 `organize.js` / IDE `kbImportController` 同口径）。
 *   ⚠ 只搬这 4 个**固定名字**的文件 —— 同名的用户笔记在各库子目录里，不碰。
 */
log('\n②.6 导航文件 → .kb/nav/');
const NAV_NAMES = ['index.md', 'overview.md', 'insights.md', 'log.md'];
for (const section of ['知识库列表', '笔记']) {
	const dir = path.join(VAULT, section);
	if (!fs.existsSync(dir)) { continue; }
	for (const nm of NAV_NAMES) {
		const from = path.join(dir, nm);
		if (!fs.existsSync(from)) { continue; }
		moveOne(from, path.join(metaDir(VAULT), 'nav', nm), section + '/' + nm + ' → ' + META_DIR + '/nav/' + nm);
	}
}

/* 旧单文件索引（极老） */
const veryOld = path.join(VAULT, '.kb-kernel.json');
if (fs.existsSync(veryOld)) {
	moveOne(veryOld, metaPath(VAULT, 'kernel'), '.kb-kernel.json → ' + META_DIR + '/kernel.json');
}

/* ── ③ .gitignore 收敛 ── */
log('\n③ 收敛 .gitignore');
const gi = path.join(VAULT, '.gitignore');
if (!fs.existsSync(gi)) {
	log('   · 没有 .gitignore（跳过）');
} else {
	const raw = fs.readFileSync(gi, 'utf8');
	const lines = raw.split(/\r?\n/);
	const legacyPatterns = [
		'.kbkernel.json', '.kb-ingest-cache.json', '.kb-insights-cache.json', '.kb-topic-overview-cache.json',
		'.kb-build-cache.json', '.kb-html-cache/', '.kb-layout.json', '.feishu-sync.json', '.feishu-space-map.json',
		'.op-log.jsonl', 'kb-schema.json', '.ftindex.json',
	];
	const kept = lines.filter((l) => {
		const t = l.trim();
		if (!t || t.startsWith('#')) { return true; }
		if (t === '.kb/') { return false; }            // 下面统一重新插
		return !legacyPatterns.includes(t);
	});
	// 在第一个非空行前插 `.kb/`
	const out = [];
	let inserted = false;
	for (const l of kept) {
		if (!inserted && l.trim() && !l.trim().startsWith('#')) { out.push('.kb/'); inserted = true; }
		out.push(l);
	}
	if (!inserted) { out.unshift('.kb/'); }
	const next = out.join('\n');
	if (next === raw) {
		log('   · 已是收敛状态');
	} else if (APPLY) {
		fs.writeFileSync(gi, next, 'utf8');
		log('   ✓ 已写入（保留注释；逐文件项收成 .kb/）');
	} else {
		log('   · 将重写：' + legacyPatterns.filter((p) => lines.includes(p)).length + ' 条逐文件规则 → `.kb/`');
	}
}

/* ── ④ 校验 ── */
log('\n④ 校验');
const md = metaDir(VAULT);
if (fs.existsSync(md)) {
	const items = fs.readdirSync(md, { withFileTypes: true });
	log('   .kb/ 内容（' + items.length + ' 项）：');
	items.forEach((e) => {
		const p = path.join(md, e.name);
		log('     · ' + e.name.padEnd(30) + mb(sizeOf(p)));
	});
} else {
	log('   .kb/ 还不存在' + (APPLY ? '（异常）' : '（dry-run 正常）'));
}

const leftovers = META_KEYS
	// schema 单独判断（历史名无点前缀）；nav 不是库根单文件 —— 两者都没有"库根旧路径"
	.filter((k) => k !== 'schema' && k !== 'nav')
	.map((k) => path.join(VAULT, META_LEGACY_NAME[k]))
	.filter((p) => fs.existsSync(p));
log('   库根残留旧文件：' + (leftovers.length ? leftovers.map((p) => path.basename(p)).join(', ') : '无 ✓'));

log('\n' + (APPLY ? '✓ 完成：搬了 ' + moved + ' 项，' + mb(bytes) : '· dry-run：将搬 ' + moved + ' 项，' + mb(bytes)));
