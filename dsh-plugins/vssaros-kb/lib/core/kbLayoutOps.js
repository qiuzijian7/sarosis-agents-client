/*
 * 知识库列表（原「笔记」目录）下的**一级子文件夹 = 一个知识库**（★ 2026-11-02）。
 *
 * 背景：改名之后 `知识库列表/` 不再只是"一堆笔记"，而是"知识库的容器"：
 *
 *     <vault>/知识库列表/<库名>/        ← 一个知识库（可关联一个飞书空间）
 *     <vault>/知识库列表/0-Inbox/       ← 惯例：未归类
 *     <vault>/数据源/…                  ← 原料（不参与"库"的计数）
 *
 * 这里只做两件纯事（不碰 HTTP / 不碰 UI，方便直接单测）：
 *   ① listKnowledgeBases(vaultRoot)   列出每个库：篇数 / 最近更新 / 是否已绑飞书
 *   ② createKnowledgeBase(vaultRoot, name) 建文件夹（可选带 index.md）
 *
 * ⚠ 名称校验是**安全边界**（不是体验问题）：库名会直接当目录名用，
 *   一旦允许 `../` 或 `:`，就能把目录建到 vault 之外 / 建出非法路径 ⇒ 必须在这里挡住。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 与 core/kb.js 的 NOTES_DIR 同值（这里不 import，避免循环依赖；守卫会对账） */
const NOTES_DIR = '知识库列表';
const FEISHU_BINDING = '.kb-feishu.json';
const INDEX_FILE = 'index.md';

/** Windows 保留名（不分大小写） */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
	'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

/**
 * 校验库名（**当目录名用**）。
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateKbName(raw) {
	const name = String(raw ?? '').trim();
	if (!name) { return { ok: false, error: '名称不能为空' }; }
	if (name.length > 64) { return { ok: false, error: '名称太长（≤64 字符）' }; }
	if (name === '.' || name === '..') { return { ok: false, error: '名称不能是 . 或 ..' }; }
	if (name.startsWith('.')) { return { ok: false, error: '名称不能以点开头（会变成隐藏目录）' }; }
	// eslint-disable-next-line no-control-regex
	if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) { return { ok: false, error: '名称含非法字符：\\ / : * ? " < > | 或控制字符' }; }
	if (/[. ]$/.test(name)) { return { ok: false, error: '名称不能以点或空格结尾（Windows 会静默截断）' }; }
	if (RESERVED.has(name.toLowerCase())) { return { ok: false, error: '名称是系统保留名：' + name }; }
	return { ok: true, name };
}

/**
 * 统计一个库里的 md：总数 + **近 7 天改动数**（★ 2026-11-02 主页「本周新增」用它）。
 *
 * 一次 walk 同时算两个数：多 stat 几次换一次遍历，比跑两遍目录便宜。
 * 上限 5000 个文件（超大库不至于把主页拖住）。
 */
const countMd = (dir) => {
	let all = 0;
	let week = 0;
	const since = Date.now() - 7 * 864e5;
	const walk = (d, depth) => {
		if (depth > 8 || all > 5000) { return; }
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const f of list) {
			if (f.name.startsWith('.')) { continue; }
			const p = path.join(d, f.name);
			if (f.isDirectory()) { walk(p, depth + 1); continue; }
			if (!/\.md$/i.test(f.name)) { continue; }
			all += 1;
			try { if (fs.statSync(p).mtimeMs >= since) { week += 1; } } catch { /* 读不到就不算 */ }
		}
	};
	walk(dir, 0);
	return { all, week };
};

/** 读 `index.md` 的首段做卡片摘要（≤ 60 字）；没有就返回空串 */
const excerptOf = (dir) => {
	const p = path.join(dir, INDEX_FILE);
	if (!fs.existsSync(p)) { return ''; }
	try {
		const s = fs.readFileSync(p, 'utf8').slice(0, 800);
		const body = s
			.replace(/^---[\s\S]*?---\s*/, '')          // frontmatter
			.replace(/^#.*$/gm, '')                      // 标题行
			.replace(/^>.*$/gm, '')                      // 引用（模板里那句"新建于…"）
			.replace(/[*`_~\[\]()#>|-]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		return body.slice(0, 60);
	} catch { return ''; }
};

/**
 * 列出 `知识库列表/` 下的知识库（一级子目录）。
 * 散文件不算库（它们属于"未归类"）；以点开头的一律跳过。
 *
 * @returns {Array<{ name: string, rel: string, docs: number, updatedAt: number, hasFeishu: boolean, hasIndex: boolean }>}
 */
export function listKnowledgeBases(vaultRoot) {
	const base = path.join(String(vaultRoot || ''), NOTES_DIR);
	let entries = [];
	try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }

	const out = [];
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith('.')) { continue; }
		const dir = path.join(base, e.name);
		let mtime = 0;
		try { mtime = fs.statSync(dir).mtimeMs; } catch { /* 忽略 */ }
		const cnt = countMd(dir);
		out.push({
			name: e.name,
			rel: NOTES_DIR + '/' + e.name,
			docs: cnt.all,
			/** ★ 近 7 天有改动的篇数（主页「本周新增」） */
			weekNew: cnt.week,
			/** ★ index.md 首段摘要（主页卡片副标题） */
			excerpt: excerptOf(dir),
			updatedAt: mtime,
			hasFeishu: fs.existsSync(path.join(dir, FEISHU_BINDING)),
			hasIndex: fs.existsSync(path.join(dir, INDEX_FILE)),
		});
	}
	// 最近更新的在前（与主页"最近使用"一致）
	out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh'));
	return out;
}

/**
 * 新建一个知识库（= 在 `知识库列表/` 下建一个文件夹）。
 *
 * @param {string} vaultRoot 库根
 * @param {string} name 库名（同时是文件夹名）
 * @param {{ withIndex?: boolean, indexBody?: string }} [opts]
 * @returns {{ ok: true, name: string, rel: string, created: string[] } | { ok: false, error: string, code?: string }}
 */
export function createKnowledgeBase(vaultRoot, name, opts = {}) {
	const root = String(vaultRoot || '');
	if (!root) { return { ok: false, error: '缺少库根路径' }; }

	const v = validateKbName(name);
	if (!v.ok) { return { ok: false, error: v.error, code: 'invalid-name' }; }

	const base = path.join(root, NOTES_DIR);
	const dir = path.join(base, v.name);

	// 防越界：解析后必须仍在 `<vault>/知识库列表/` 之内
	const resolvedBase = path.resolve(base) + path.sep;
	const resolvedDir = path.resolve(dir);
	if (!resolvedDir.startsWith(resolvedBase)) { return { ok: false, error: '目标路径越界', code: 'outside' }; }

	if (fs.existsSync(dir)) { return { ok: false, error: '同名知识库已存在：' + v.name, code: 'exists' }; }

	const created = [];
	try {
		fs.mkdirSync(dir, { recursive: true });
		created.push(NOTES_DIR + '/' + v.name);
		if (opts.withIndex !== false) {
			const body = String(opts.indexBody ?? `# ${v.name}\n\n> 新建于 ${new Date().toISOString().slice(0, 10)}\n`);
			fs.writeFileSync(path.join(dir, INDEX_FILE), body, 'utf8');
			created.push(NOTES_DIR + '/' + v.name + '/' + INDEX_FILE);
		}
	} catch (e) {
		return { ok: false, error: '创建失败：' + String((e && e.message) || e) };
	}
	return { ok: true, name: v.name, rel: NOTES_DIR + '/' + v.name, created };
}

/*
 * ── 每库飞书绑定（★ 2026-11-02）──────────────────────────────────────────────
 *
 *   位置：`知识库列表/<库>/.kb-feishu.json`（**跟着库走**：库被单独拷走/发布时绑定不丢）
 *   形状：{ spaceId, spaceName, syncMode: 'upload'|'two-way', boundAt, lastSyncAt, files: { rel: {token,hash,rev} } }
 *
 *   为什么不放全局 `.kb/feishu-sync.json`：那是"目录前缀 → spaceId"的扁平表，
 *   一个 vault 只能有一张表；而新模型是"每个库各自连一个空间" ⇒ 必须就近存。
 */

/** 解析某库的绑定文件路径（带越界保护） */
const bindingPathOf = (vaultRoot, kbName) => {
	const v = validateKbName(kbName);
	if (!v.ok) { return null; }
	const base = path.resolve(path.join(String(vaultRoot || ''), NOTES_DIR)) + path.sep;
	const dir = path.resolve(path.join(base, v.name));
	if (!dir.startsWith(base)) { return null; }
	return path.join(dir, FEISHU_BINDING);
};

/** 读某库的飞书绑定（没有就返回 null） */
export function readFeishuBinding(vaultRoot, kbName) {
	const p = bindingPathOf(vaultRoot, kbName);
	if (!p || !fs.existsSync(p)) { return null; }
	try {
		const j = JSON.parse(fs.readFileSync(p, 'utf8'));
		return j && typeof j === 'object' ? j : null;
	} catch { return null; }
}

/**
 * 写/更新某库的飞书绑定。
 * @param {{ spaceId?: string, spaceName?: string, syncMode?: string }} patch
 */
export function writeFeishuBinding(vaultRoot, kbName, patch = {}) {
	const p = bindingPathOf(vaultRoot, kbName);
	if (!p) { return { ok: false, error: '库名非法或路径越界', code: 'invalid-name' }; }
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) { return { ok: false, error: '知识库不存在：' + kbName, code: 'no-kb' }; }

	const spaceId = String(patch.spaceId ?? '').trim();
	if (!spaceId) { return { ok: false, error: 'spaceId 不能为空', code: 'no-space' }; }
	if (!/^[A-Za-z0-9_-]{4,64}$/.test(spaceId)) { return { ok: false, error: 'spaceId 形态不对（应为 4–64 位字母数字/下划线/连字符）', code: 'bad-space' }; }

	const prev = readFeishuBinding(vaultRoot, kbName) || {};
	const next = Object.assign({
		spaceId: '',
		spaceName: '',
		syncMode: 'upload',
		boundAt: new Date().toISOString(),
		lastSyncAt: '',
		files: {},
	}, prev, {
		spaceId,
		spaceName: String(patch.spaceName ?? prev.spaceName ?? kbName).trim() || kbName,
		syncMode: patch.syncMode === 'two-way' ? 'two-way' : (prev.syncMode || 'upload'),
	});
	try {
		fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
	} catch (e) {
		return { ok: false, error: '写入失败：' + String((e && e.message) || e) };
	}
	return { ok: true, binding: next, file: NOTES_DIR + '/' + kbName + '/' + FEISHU_BINDING };
}

/** 解除绑定（删文件；库本身不动） */
export function clearFeishuBinding(vaultRoot, kbName) {
	const p = bindingPathOf(vaultRoot, kbName);
	if (!p) { return { ok: false, error: '库名非法或路径越界', code: 'invalid-name' }; }
	if (!fs.existsSync(p)) { return { ok: true, cleared: false }; }
	try { fs.rmSync(p, { force: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	return { ok: true, cleared: true };
}

export { NOTES_DIR as KB_LIST_DIR, FEISHU_BINDING as KB_FEISHU_FILE };
