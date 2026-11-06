// @vssaros/dsh-marketplace — 技能安装的**非商城来源**（P1，2026-11-06）。
//
// 背景：IDE 侧原本有 4 条旁路（GitHub Hub / Git URL / 本地文件夹 / URL 内容），
// 各自在 `skillInstallService.ts` 里实现，另有 `SkillInstaller` 一份商城链。
// 迁到 dsh 侧后统一收敛：本模块负责**解析 + 校验 + 规范化**（零 I/O、可离线单测），
// `index.js` 负责网络与落盘，`installBundle` 是唯一写入口（sha256 / SKILL.md / 备份 / 台账都在它身上）。
//
// ⚠ 本文件不 fetch、不碰磁盘 ⇒ 任何一条来源的边界都能在干净检出里跑单测 ✓

/** 内置 Hub：与 IDE 侧 `skillHubTypes.ts` 的 `BUILTIN_SKILL_HUBS` 逐条同口径（迁移后不再有第二份清单）。 */
export const SKILL_HUBS = [
	{ id: 'anthropic-skills', repo: 'anthropics/skills', skillsPath: '', branch: 'main' },
	{ id: 'hermes-skills', repo: 'nicobailey/hermes', skillsPath: 'skills', branch: 'main' },
	{ id: 'awesome-copilot', repo: 'awesome-copilot/skills', skillsPath: '', branch: 'main' },
	{ id: 'prompt-skills', repo: 'prompt-engineering/skills-collection', skillsPath: 'skills', branch: 'main' },
];

/** dsh 的技能名规则（`dsh-skill` 的 `SKILL_NAME` / `check-skill-frontmatter.mjs` 同源）。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 单个来源允许的最大字节数（与 `vssaros-skills` 的 `MAX_SKILL_BYTES` 同量级）。 */
export const MAX_SKILL_SOURCE_BYTES = 256 * 1024;

/** GitHub `/git/trees?recursive=1` 响应体上限（大仓 tree 可达数 MB，别让一个响应吃满内存）。 */
export const MAX_HUB_TREE_BYTES = 4 * 1024 * 1024;

/** 直链允许下载的域（与 `githubSource.js` 的 ALLOWED_HOSTS 同口径，防 SSRF 打到内网）✗ */
export const ALLOWED_SKILL_URL_HOSTS = new Set([
	'github.com',
	'codeload.github.com',
	'objects.githubusercontent.com',
	'raw.githubusercontent.com',
]);

/**
 * 解析 SKILL.md 的 frontmatter，只取 dsh 用来路由技能的两个必填字段。
 * 切片方式逐字照搬 DSH 的 `parseFrontmatter` / `findClosingFrontmatter`（含 CRLF 兼容）。
 */
export function parseSkillFrontmatter(raw) {
	const text = String(raw ?? '');
	const firstEnd = text.indexOf('\n');
	if (firstEnd < 0 || text.slice(0, firstEnd).replace(/\r$/, '') !== '---') {
		throw new Error('SKILL.md 缺 YAML frontmatter（第一行必须是 ---，文件不能带 BOM）');
	}
	const start = firstEnd + 1;
	let closing;
	for (let lineStart = start; lineStart <= text.length;) {
		const next = text.indexOf('\n', lineStart);
		const lineEnd = next < 0 ? text.length : next;
		if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') { closing = lineStart; break; }
		if (next < 0) { break; }
		lineStart = next + 1;
	}
	if (closing === undefined) { throw new Error('frontmatter 没有收尾的 ---'); }
	const block = text.slice(start, closing);
	const field = (key) => {
		const m = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(block);
		if (!m) { return ''; }
		return m[1].trim().replace(/^['"]|['"]$/g, '');
	};
	const name = field('name');
	const description = field('description');
	if (!name) { throw new Error('frontmatter 缺 name（dsh 用它路由技能）'); }
	if (!SKILL_NAME.test(name)) { throw new Error(`技能名「${name}」不合法（只能小写字母/数字/短横线）`); }
	if (!description) { throw new Error('frontmatter 缺 description（dsh 缺了会静默跳过这个技能）'); }
	return { name, description };
}

/** 包内相对路径围栏：拒绝绝对路径、上跳、盘符与控制字符。 */
export function assertSafeSkillPath(input) {
	const rel = String(input ?? '').replace(/\\/g, '/');
	if (!rel || rel.startsWith('/') || rel === '..' || rel.startsWith('../')
		|| rel.includes('/../') || rel.endsWith('/..') || /^[A-Za-z]:/.test(rel)
		// eslint-disable-next-line no-control-regex
		|| /[\u0000-\u001f\u007f]/.test(rel)) {
		throw new Error(`包内路径不合法：${rel}`);
	}
	return rel;
}

/**
 * 判定来源类型。调用方必须显式给 `source`（4 选 1），缺省按 `content`。
 * 这里不下载、不解析 URL 内容，只做**分类** ⇒ 网络失败与安全边界各归其位 ✓
 */
export function parseSkillSource(params = {}) {
	const source = String(params?.source ?? 'content').trim();
	if (!['content', 'folder', 'url', 'github'].includes(source)) {
		throw new Error(`不认识的来源类型「${source}」（只支持 content / folder / url / github）`);
	}
	if (source === 'github') { return { type: 'github', ref: String(params?.repo ?? params?.url ?? '').trim() }; }
	if (source === 'url') { return { type: 'url', url: String(params?.url ?? '').trim() }; }
	if (source === 'folder') { return { type: 'folder', files: params?.files }; }
	return { type: 'content', content: params?.content };
}

/**
 * 把「一份 SKILL.md 正文」或「一组文件夹上传的文件」规范化成 `installBundle({files})` 的形状。
 *
 * ⚠ 强制 `frontmatter.name === 安装 id`：dsh 的 provider 是**单层 readdir + 用目录名定位**，
 *   两者不一致就会出现「装好了但技能列表里没有」（`check-skill-frontmatter.mjs` 第 ⑤ 条同一口径）。
 */
export function normalizeSkillFiles({ content, files, name } = {}) {
	let entries;
	if (Array.isArray(files) && files.length) {
		entries = files.map((f) => ({
			path: assertSafeSkillPath(f?.path),
			data: Buffer.isBuffer(f?.data) ? f.data : Buffer.from(String(f?.data ?? ''), 'utf8'),
		}));
	} else {
		const text = String(content ?? '');
		if (!text.trim()) { throw new Error('内容为空（要装技能得给一份 SKILL.md 正文）'); }
		entries = [{ path: 'SKILL.md', data: Buffer.from(text, 'utf8') }];
	}
	const total = entries.reduce((n, e) => n + e.data.length, 0);
	if (total > MAX_SKILL_SOURCE_BYTES) {
		throw new Error(`来源总大小 ${total} 字节超过上限 ${MAX_SKILL_SOURCE_BYTES}`);
	}
	const skillIndex = entries.findIndex(e => e.path === 'SKILL.md');
	if (skillIndex < 0) { throw new Error('包里缺少顶层 SKILL.md（技能包必须以它为入口）'); }
	const fm = parseSkillFrontmatter(entries[skillIndex].data.toString('utf8'));
	const storeId = String(name ?? '').trim() || fm.name;
	if (!SKILL_NAME.test(storeId)) { throw new Error(`安装 id「${storeId}」不合法`); }
	if (fm.name !== storeId) {
		throw new Error(`frontmatter 的 name（${fm.name}）与安装 id（${storeId}）不一致 ⇒ dsh 会用目录名定位，装完看不见`);
	}
	return { storeId, files: entries };
}

/**
 * GitHub `/git/trees/<branch>?recursive=1` 的响应 → Hub 条目（纯函数，便于 mock）。
 * 只收顶层/一层子目录里的 `SKILL.md`，嵌套容器目录 dsh 看不见（provider 是单层 readdir ✓）。
 */
export function hubTreeToEntries(tree, hubId) {
	const hub = SKILL_HUBS.find(h => h.id === hubId);
	if (!hub) { throw new Error(`不认识的技能 Hub「${hubId}」`); }
	const prefix = hub.skillsPath ? hub.skillsPath.replace(/^\/|\/$/g, '') + '/' : '';
	const paths = Array.isArray(tree?.tree) ? tree.tree.map(e => String(e?.path ?? '')) : [];
	const out = [];
	for (const p of paths) {
		if (!p.endsWith('SKILL.md')) { continue; }
		if (prefix && !p.startsWith(prefix)) { continue; }
		const dir = p.slice(0, -'SKILL.md'.length).replace(/\/$/, '');
		const rest = prefix ? dir.slice(prefix.length) : dir;
		const id = rest.split('/').pop();
		if (!id || !SKILL_NAME.test(id) || rest.includes('/')) { continue; }
		out.push({
			id,
			name: id,
			path: p,
			rawUrl: `https://raw.githubusercontent.com/${hub.repo}/${hub.branch}/${p}`,
		});
	}
	return out;
}
