// @vssaros/dsh-marketplace — 发布与下架（★ 2026-10-22 S2c：publish / delete* 也在 dsh 侧）
//
// ★ 为什么能搬：发布 = **读本地目录 → 打 tar.gz → 上传**，三件事 dsh 侧都齐了
//   （目录就是数据根里那几处；`lib/tar.js` 已有确定性打包；Node 有 fetch）。
//   原先绕 IDE 是因为 IDE 侧有现成的 `installer.preparePack` + 扩展宿主上传命令
//   —— 那是**复用便利**，不是能力约束（与 list/detail 同性质）✓
//
// ★ 包格式：**目录镜像**（把 `<数据根>/<kind根>/<id>/` 整个打进去）
//   ⇒ 发布端不需要"导出格式"的额外定义，安装端解包即落盘（S2 的 installBundle 正好吃它）✓
//   ⚠ 旧包（agent 用 `agent.json` 导出格式）仍能发布/安装（原样打包），但 dsh 侧**安装**只认
//     目录镜像；遇到 `agent.json` 包会如实报"这一类还要走 IDE"（不猜、不半装）✗
//
// ★ manifest：优先沿用目录里已有的 `manifest.json`（作者可能写了 name/description），
//   但 `kind` / `id` / `version` / `files` **强制按本次发布覆盖** ——
//   服务端 `validateManifestKind` 要求 `manifest.id === slug`、`kind` 一致，写错就整包被拒 ✗
//
// ★ 上传两道：
//   ① `POST /packages` 建包（同 slug 已存在 ⇒ 409，**容忍**继续发版本 —— 那说明是在更新已有包）
//   ② `POST /packages/:slug/versions/raw`（raw tar.gz + `X-Changelog`）✓

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packTarGz } from './tar.js';
// ★ 2026-10-22：`localId` 也要挡越界（`../` 会让 `join(root, ...)` 读到数据根外）
import { assertSafeStoreId } from './installers.js';
// ★ 2026-10-22：外部源发布（本体就是一个 GitHub 地址）⇒ 归一化 + 安全边界在它里面
import { parseGitHubSource, resolveCommitSha } from './githubSource.js';

/** 可发布的三类（workbench 走外部发布源，不打包）；agent 的**发布**是目录镜像 ⇒ 也能发 ✓。 */
// ⚠ **不含 `agent`**（2026-10-22 自查后收窄）：agent 的商城包格式是 `agent.json`
//   （`AgentExportData`：`agent` 元数据 + `files.agentsMd` 等），而 IDE 侧
//   `agentInstaller.install` **只认 `agent.json`** ⇒ dsh 侧若只打"目录镜像"，
//   发出去的 agent 包**别人装不上**（IDE 安装器报"包内缺少 agent.json"）✗；
//   而自己从 `.agent.md` 的 frontmatter 反解出 `agent.json` 又必然与 IDE 的组装逻辑漂移
//   （嵌套 `configHtml` 之类）✗ ⇒ **agent 的发布留在 IDE**（`preparePack` 是唯一正确组装器）✓
// ★ 2026-10-23：mcp 也能由 dsh 侧打包（目录镜像，入口 config.json）
// ★ 2026-10-31：加 `knowledge`（知识库）。
//   服务端 `src/packages/kinds.ts` 的 PACKAGE_KINDS **早已含 knowledge**，且 isBundleKind=true
//   ⇒ 走的正是"包本体随版本上传（tar.gz）"这条通道；线上已有 vscode-dev-guide / sarosis-handbook 两个包 ✓。
//   ⚠ 与 skill/workflow/mcp 不同：知识库的**源目录在用户选的库里**（不在 <数据根>/<kind根>/ 下）
//     ⇒ 打包入口必须支持 `sourceDir`（见 preparePublishBundle）。
export const PUBLISHABLE_KINDS = ['skill', 'workflow', 'agent', 'mcp', 'knowledge'];

/** 各 kind 的本地根目录名（与 IDE 侧 `SarosPath` 同口径）。 */
// ★ 2026-10-23：加 mcp（`<数据根>/mcp/<id>/`，入口 config.json）
const KIND_DIR = { agent: 'agents', skill: 'skills', workflow: 'workflows', mcp: 'mcp', knowledge: 'knowledge' };

/** 打包时**排除**的目录/文件（备份、依赖、版本库 —— 它们不属于"这个资源"）。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.upgrade-backup', '.saros']);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * ★ 2026-10-31：知识库打包的**额外排除项**（与 KB 的 `.gitignore` 同口径）。
 *   这些是**可再生**的缓存/索引/日志，或**不该外传**的东西：
 *   · .git（历史留在作者本机，包里不需要，且可能含内网远端地址）
 *   · .tmp-media（实测一个库 138MB 视频就在这里）· .obsidian（应用态 1.7MB）
 *   · .kb-* 索引/缓存 · .op-log.jsonl · 飞书同步状态
 */
const EXCLUDE_DIRS_KNOWLEDGE = new Set(['.git', '.tmp-media', '.obsidian', '.kb-html-cache', '.canvas-text-migration-backup', '.kb-backup', 'node_modules']);
const EXCLUDE_FILES_KNOWLEDGE = new Set([
	'.kbkernel.json', '.kb-build-cache.json', '.kb-insights-cache.json', '.kb-topic-overview-cache.json',
	'.kb-ingest-cache.json', '.kb-git.json', '.op-log.jsonl',
	'.feishu-sync.json', '.feishu-space-map.json', '.feishu-sync.log', '.kb-feishu-sync.log',
]);

/** 服务端上传体积上限（与 config.ts 的 `uploadLimits` 同口径；超了服务端会 413）。 */
// ★ knowledge 放行到 50MB（素材多；服务端 `/versions/raw` 上限 200mb，有余量）
const SIZE_LIMIT = {
	agent: 5 * 1024 * 1024,
	skill: 2 * 1024 * 1024,
	workflow: 2 * 1024 * 1024,
	mcp: 2 * 1024 * 1024,
	knowledge: 50 * 1024 * 1024,
};

/** 本地资源根：`<数据根>/<kind根>`。 */
export function localRootOf(dataRoot, kind) {
	const dir = KIND_DIR[kind];
	if (!dir) { throw new Error(`dsh 侧不支持发布这一类：${kind}（支持 ${PUBLISHABLE_KINDS.join(' / ')}）`); }
	return join(dataRoot, dir);
}

/**
 * 递归读一个目录成 `路径 → Buffer`（相对路径、`/` 分隔；已排除依赖与备份）。
 *
 * @param {string} dir
 * @param {{ skipManifest?: boolean }} [opts]
 * @returns {Promise<{ path: string, data: Buffer }[]>}
 */
export async function collectDir(dir, opts = {}) {
	const out = [];
	async function walk(current, prefix) {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (EXCLUDE_DIRS.has(entry.name)) { continue; }
				// ★ 知识库专属排除（缓存/临时媒体/应用态）
				if (opts.knowledge && EXCLUDE_DIRS_KNOWLEDGE.has(entry.name)) { continue; }
				await walk(join(current, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
				continue;
			}
			if (!entry.isFile()) { continue; }
			if (EXCLUDE_FILES.has(entry.name)) { continue; }
			// ★ 知识库专属排除（索引/日志/同步状态）+ 备份产物
			if (opts.knowledge && (EXCLUDE_FILES_KNOWLEDGE.has(entry.name) || /\.bak($|-)/.test(entry.name))) { continue; }
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (opts.skipManifest && rel === 'manifest.json') { continue; }
			const data = await readFile(join(current, entry.name));
			out.push({ path: rel, data });
		}
	}
	await walk(dir, '');
	return out;
}

/**
 * 组装发布用的包（文件 + manifest）。
 *
 * @param {object} args
 * @param {string} args.dataRoot
 * @param {string} args.kind agent|skill|workflow
 * @param {string} args.localId 资源 id（= 商城 slug）
 * @param {string} args.version 版本号
 * @param {{ name?: string, description?: string, category?: string, tags?: string[] }} [args.meta]
 */
/**
 * ★ 2026-10-31：**知识库发布前的隐私体检**。
 *
 * 为什么必须有：知识库是私人笔记，误发布比代码误发布严重得多，而"用户自己注意"不可靠。
 * ⇒ 打包时扫一遍，命中即**默认拦下**；调用方确认可公开后显式传 acknowledgePrivacy:true 才放行 ✓。
 */
export async function scanVaultPrivacy(dir, opts = {}) {
	const maxFiles = Number(opts.maxFiles ?? 400);
	const maxBytes = Number(opts.maxBytesPerFile ?? 200 * 1024);
	const RULES = [
		{ id: 'home-dir', title: '本机用户目录绝对路径（暴露机器/账号名）', level: 'blocker', re: /(?:[A-Za-z]:)?[\\/]{1,2}Users[\\/][^\\/\s"'<>]+/g },
		{ id: 'email', title: '邮箱地址', level: 'blocker', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
		{ id: 'phone', title: '手机号', level: 'blocker', re: /(?:^|\D)1[3-9]\d{9}(?:\D|$)/g },
		{ id: 'intranet', title: '内网域名或私有 IP', level: 'blocker', re: /(?:\b[\w-]+\.(?:corp|internal|local|lan|intra)\b)|(?:\b10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:\b192\.168\.\d{1,3}\.\d{1,3})|(?:\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/gi, },
		{ id: 'marked-private', title: '正文里标了「内部 / 保密 / 机密」', level: 'warn', re: /(内部资料|保密|机密|请勿外传)/g, },
	];
	const hits = new Map();
	function bump(rule, sample) {
		const cur = hits.get(rule.id) ?? { id: rule.id, title: rule.title, level: rule.level, count: 0, sample: '' };
		cur.count += 1;
		if (!cur.sample && sample) { cur.sample = String(sample).slice(0, 60); }
		hits.set(rule.id, cur);
	}
	let scanned = 0;
	async function walk(current) {
		if (scanned >= maxFiles) { return; }
		let entries = [];
		try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (scanned >= maxFiles) { return; }
			const p = join(current, e.name);
			if (e.isDirectory()) {
				if (EXCLUDE_DIRS_KNOWLEDGE.has(e.name) || EXCLUDE_DIRS.has(e.name)) { continue; }
				await walk(p);
				continue;
			}
			if (!e.isFile()) { continue; }
			if (!/\.(md|markdown|txt|json)$/i.test(e.name)) { continue; }
			let text = '';
			try {
				text = (await readFile(p, 'utf8')).slice(0, maxBytes);
			} catch { continue; }
			scanned += 1;
			for (const rule of RULES) {
				rule.re.lastIndex = 0;
				const m = rule.re.exec(text);
				if (m) { bump(rule, m[0]); }
			}
		}
	}
	await walk(dir);
	try {
		const cfg = await readFile(join(dir, '.git', 'config'), 'utf8');
		const m = /url\s*=\s*(\S+)/.exec(cfg);
		if (m) {
			bump({ id: 'git-remote', title: '.git 远端地址（可能含内网仓库或凭据）', level: 'blocker' }, m[1]);
		}
	} catch { /* 没有 .git（打包时本就会排除） */ }
	const all = [...hits.values()];
	return {
		scanned,
		blockers: all.filter((x) => x.level === 'blocker'),
		warnings: all.filter((x) => x.level === 'warn'),
	};
}
export async function preparePublishBundle({ dataRoot, kind, localId, version, meta = {}, sourceDir, acknowledgePrivacy = false } ) {
	// ★ 入口先卡 kind（`localRootOf` 认得 agents 目录，但 agent **不该**由 dsh 侧打包 ⇒
	//   只在 kind 层面拦是拦不住的，必须在打包入口拦 ✓）
	if (!PUBLISHABLE_KINDS.includes(kind)) {
		throw new Error(
			`dsh 侧不支持发布这一类：${kind}（支持 ${PUBLISHABLE_KINDS.join(' / ')}）`
			+ '—— agent 的包格式是 agent.json，必须由 IDE 侧 preparePack 组装',
		);
	}
	// ★ 2026-10-22（健壮性测试抓到）：**空白版本号必须拒**。
	//   此前不校验 ⇒ 会打出一个 `version: ""` 的包传上去（服务端可能收下 ⇒ 脏数据，
	//   而且升级检查永远对不上）✗
	const safeVersion = String(version ?? '').trim();
	if (!safeVersion) { throw new Error('发布需要版本号（不能为空或纯空白）'); }
	// 同一类问题：`localId` 直接拼进 `join(root, ...)` ⇒ 必须挡越界（`../` 会读到数据根外）
	assertSafeStoreId(localId, 'localId');
	/*
	 * ★ 2026-10-31：知识库的源目录**不在数据根下**（它是用户选的一个库，可能在 D: 盘、共享盘……）
	 *   ⇒ 走 `sourceDir` 分支；其余 kind 仍按 `<数据根>/<kind根>/<id>`。
	 *   ⚠ sourceDir 必须是**绝对路径且是目录**（挡住相对路径与越界）。
	 */
	let dir;
	if (typeof sourceDir === 'string' && sourceDir.trim()) {
		const abs = resolve(sourceDir.trim());
		let stSrc;
		try { stSrc = await stat(abs); } catch { stSrc = null; }
		if (!stSrc || !stSrc.isDirectory()) { throw new Error(`知识库目录不存在或不是目录：${abs}`); }
		dir = abs;
	} else {
		const root = localRootOf(dataRoot, kind);
		dir = join(root, localId);
	}
	let st;
	try {
		st = await stat(dir);
	} catch {
		throw new Error(`本地没有这个资源：${dir}（${kind} / ${localId}）`);
	}
	if (!st.isDirectory()) { throw new Error(`本地资源不是目录：${dir}`); }

	// 已有 manifest 就沿用（作者可能写了 name/description），但关键字段强制覆盖 ✓
	let base = {};
	try {
		base = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) ?? {};
	} catch { base = {}; }

	// 打包时排除旧 manifest（我们用新的那份，避免包内出现两份口径）✓
	/*
	 * ★ 2026-10-31：知识库发布前的隐私体检（默认拦下）。
	 *   命中"本机用户目录 / 邮箱 / 手机号 / 内网地址 / .git 远端" ⇒ 拒绝发布；
	 *   确认可公开后显式传 acknowledgePrivacy: true 才放行 ✓。
	 */
	if (kind === 'knowledge') {
		const scan = await scanVaultPrivacy(dir);
		if (scan.blockers.length && acknowledgePrivacy !== true) {
			const lines = scan.blockers.map((b) => '· ' + b.title + '（' + b.count + ' 处，例：' + b.sample + '）').join('\n');
			throw new Error(
				'发布被隐私体检拦下：这个库里可能有不该外传的内容：\n' + lines
				+ '\n请清理后再发布；确认这些内容可以公开时，请显式传 acknowledgePrivacy: true。',
			);
		}
	}
	const files = await collectDir(dir, { skipManifest: true, knowledge: kind === 'knowledge' });
	if (files.length === 0) {
		throw new Error(`「${localId}」目录里没有文件（拒绝发布一个空包）`);
	}
	const manifestName = typeof base.name === 'string' && base.name.trim() ? base.name : (meta.name?.trim() || localId);
	const manifest = {
		...base,
		kind,
		id: localId,
		name: manifestName,
		// 用校验过的（trim 后）版本，别把空白原样写进 manifest
		version: safeVersion,
		...(typeof base.description === 'string' || typeof meta.description === 'string'
			? { description: base.description ?? meta.description }
			: {}),
		...(typeof base.category === 'string' || typeof meta.category === 'string'
			? { category: base.category ?? meta.category }
			: {}),
		files: files.map(f => f.path),
		// ★ 2026-10-31：服务端契约里的 knowledge 块（线上已有包就是这么写的）⇒ 必须带上
		...(kind === 'knowledge' ? {
			knowledge: {
				id: localId,
				name: manifestName,
				description: (typeof base.description === 'string' && base.description) || meta.description || '',
				embedding: { provider: 'none' },
			},
		} : {}),
	};
	const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0);
	const limit = SIZE_LIMIT[kind];
	if (typeof limit === 'number' && totalBytes > limit) {
		throw new Error(`包体积 ${(totalBytes / 1024 / 1024).toFixed(2)}MB 超过服务端上限 ${(limit / 1024 / 1024).toFixed(0)}MB`);
	}
	files.push({ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
	return { manifest, files, gzBuffer: packTarGz(files) };
}

/**
 * 发布一个版本（建包 + 传版本）。**dsh 侧自持**，不经过 IDE。
 *
 * @param {object} args
 * @param {ReturnType<import('./marketClient.js').createMarketClient>} args.market
 * @param {string} args.dataRoot
 * @param {string} args.kind
 * @param {string} args.localId
 * @param {string} args.version
 * @param {string} [args.changelog]
 * @param {object} [args.meta]
 */
/**
 * 确保商城里有这个包（没有就建；已存在 409 ⇒ 容忍）。
 *
 * 抽出来给两条发布路径共用（bundle 上传 / **外部源登记**）✓
 *
 * @returns {Promise<boolean>} true = 本次新建
 */
async function ensurePackage({ market, kind, localId, meta = {} }) {
	try {
		await market.request('POST', '/packages', {
			kind,
			slug: localId,
			name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : localId,
			...(typeof meta.description === 'string' && meta.description ? { description: meta.description } : {}),
			...(typeof meta.category === 'string' && meta.category ? { category: meta.category } : {}),
			...(Array.isArray(meta.tags) && meta.tags.length ? { tags: meta.tags } : {}),
			// ★ 2026-10-26（用户：「通过商城助手上传的 plugin，没有图片」）：
			//   服务端 `routes.ts` 的建包 schema **本来就接受** `icon` / `cover`
			//   （`icon: z.string().optional()` / `cover: z.string().max(2048).optional()`），
			//   但这里从来**没传** ⇒ 卡片只能显示 📦 兜底 ✗
			//   ⇒ 透传（`icon` = 小图标，`cover` = 大图；商城页面两者的用途不同）
			...(typeof meta.icon === 'string' && meta.icon.trim() ? { icon: meta.icon.trim() } : {}),
			...(typeof meta.cover === 'string' && meta.cover.trim() ? { cover: meta.cover.trim() } : {}),
		});
		return true;
	} catch (e) {
		const msg = String(e?.message ?? e);
		// 409 的文案是 `slug "x" 已被占用` ⇒ 只有**这条**才算"已有包，继续发版本"
		const isTaken = /已被占用/.test(msg) || /HTTP 409/.test(msg);
		if (!isTaken) { throw e; }
		return false;
	}
}

/**
 * 发布一个**外部源**版本（★ 2026-10-22 用户需求：本体是一个 GitHub 地址）。
 *
 * 与 `publishVersion` 的区别：**不打包、不上传本体** —— 只把"从哪拿"登记到服务端
 * （`POST /packages/:id/versions/external`，服务端早有该接口）✓
 *
 * @param {object} args
 * @param {ReturnType<import('./marketClient.js').createMarketClient>} args.market
 * @param {string} args.kind
 * @param {string} args.localId 商城 slug（= 包 id，服务端要求 manifest.id === slug）
 * @param {string} args.version
 * @param {string} args.source 用户粘的 GitHub 地址（`owner/repo` / tree / releases 直链…）
 * @param {string} [args.changelog]
 * @param {{ name?: string, description?: string, category?: string, tags?: string[] }} [args.meta]
 */
export async function publishExternal({ market, kind, localId, version, source, changelog = '', meta = {} }) {
	// 归一化（这一步就把"只允许 GitHub 域 / https"卡死 ✓）
	const distribution = parseGitHubSource(source);
	return publishDistribution({ market, kind, localId, version, distribution, changelog, meta });
}

/**
 * 用**任意 distribution** 登记一个版本（不打包上传）。
 *
 * ★ 2026-10-23：从 `publishExternal` 里抽出来 —— 工作台同步要用 **npm** 型
 * （`{ type:'npm', name:'@vssaros/dsh-kanban' }`），而 `publishExternal` 只认 GitHub 地址。
 * 服务端 `DistributionSchema` 三种都支持（npm / github-release / github-source）✓
 *
 * @param {object} args
 * @param {object} args.market
 * @param {string} args.kind
 * @param {string} args.localId
 * @param {string} args.version
 * @param {{ type: string, name?: string, url?: string, commit?: string }} args.distribution
 * @param {string} [args.changelog]
 * @param {{ name?: string, description?: string, category?: string, tags?: string[] }} [args.meta]
 */
/**
 * 建包成功后、发版本失败 ⇒ **回滚这次新建的空包**。
 *
 * 背景（`doc/marketplace-workbench-github-flow.html` §10「发布原子性」）：
 * 发布是两次 HTTP（建包 → 发版本），第二步失败会留下一个
 * **用户能看到的空商品**（列表里有它，点进去没有版本）✗
 *
 * ★ 只回滚 `created === true` 的（**本次新建**）。
 *   已存在的包**绝不能删** —— 那会连带软删掉它已有的历史版本（灾难）✗✗
 *
 * @param {object} market
 * @param {string} localId
 * @param {boolean} created `ensurePackage` 的返回值
 * @returns {Promise<{ rolledBack: boolean, reason?: string }>}
 */
async function rollbackEmptyPackage(market, localId, created) {
	if (!created) { return { rolledBack: false, reason: '包本来就有，不回滚' }; }
	try {
		await market.request('DELETE', `/packages/${encodeURIComponent(localId)}`);
		return { rolledBack: true };
	} catch (e) {
		// ⚠ 回滚也会失败（例如 slug 被别人占了 ⇒ DELETE 403）⇒ **必须如实带出去**，
		//   否则用户以为干净了，实际上商城留了一个空商品 ✗
		return { rolledBack: false, reason: String(e?.message ?? e).slice(0, 160) };
	}
}

/** 把回滚结果拼成一句人话（附在原始错误后面）。 */
function rollbackNote(created, rb) {
	if (!created) { return ''; }
	if (rb.rolledBack) { return '；已回滚刚建的空包（商城无残留）'; }
	return `；⚠ 回滚失败（${rb.reason}）—— 商城里可能留了一个空商品，需要手工删除`;
}

export async function publishDistribution({ market, kind, localId, version, distribution, changelog = '', meta = {} }) {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(localId)) {
		throw new Error(`slug 只能是 a-z0-9_- 且小写字母开头：${localId}（服务端规则）`);
	}
	const safeVersion = String(version ?? '').trim();
	if (!safeVersion) { throw new Error('发布需要版本号（不能为空或纯空白）'); }
	if (!distribution || typeof distribution !== 'object' || !distribution.type) {
		throw new Error('publishDistribution 需要 distribution（含 type）');
	}

	// ⚠ 服务端 `description` 上限 2048：这里再兜一次（调用方可能直接塞长文本）
	//   超了会被整包拒掉（真机踩过：4 个工作台因这个字段同步失败 ✗）
	const safeDescription = typeof meta.description === 'string' && meta.description
		? meta.description.trim().slice(0, 2048)
		: '';

	// ★ 2026-10-26（文档 §10 第一条）：`github-source` 补 **commit sha**
	//   只记 `owner/repo` 时，作者 force-push 后同一地址内容会变 ⇒ 装到的东西**不可复现**。
	//   抓不到（无 Release/atom 404/网络问题）**不阻断发布** —— 只是少了可复现性。
	// 补 commit 的提示（成功才非空；**不放进 error**，只做提示）
	let shaNote = '';
	let dist = distribution;
	if (dist.type === 'github-source' && !dist.commit) {
		const sha = await resolveCommitSha(String(dist.name ?? ''), '');
		if (sha) {
			dist = { ...dist, commit: sha };
			shaNote = `已锁定 commit ${sha.slice(0, 12)}`;
		}
	}

	const created = await ensurePackage({ market, kind, localId, meta: { ...meta, description: safeDescription } });
	// ★ 2026-10-26：服务端会在同一个发布源已被别的商品登记时回 `duplicates`
	//   （不阻断发布）—— 这里原样透传，由页面提示作者去删多余的那条 ✓
	let saved;
	try {
		saved = await market.request('POST', `/packages/${encodeURIComponent(localId)}/versions/external`, {
			version: safeVersion,
			...(changelog ? { changelog } : {}),
			...(safeDescription ? { description: safeDescription } : {}),
			...(typeof meta.category === 'string' && meta.category ? { category: meta.category } : {}),
			distribution,
		});
	} catch (e) {
		// ★ 发布原子性（`doc/marketplace-workbench-github-flow.html` §10）：
		//   建包成功但发版本失败 ⇒ 回滚**本次新建**的空包，别让用户看到空壳商品
		const rb = await rollbackEmptyPackage(market, localId, created);
		throw new Error(`${String(e?.message ?? e).slice(0, 320)}${rollbackNote(created, rb)}`);
	}
	return {
		ok: true, version: safeVersion, created, distribution: dist, external: true,
		// 「已锁定 commit abc123…」—— 让调用方/页面能说明"这一版绑定在哪棵树上"
		...(shaNote ? { shaNote } : {}),
		...(saved && Array.isArray(saved.duplicates) && saved.duplicates.length ? { duplicates: saved.duplicates } : {}),
	};
}

export async function publishVersion({ market, dataRoot, kind, localId, version, changelog = '', meta = {} }) {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(localId)) {
		throw new Error(`slug 只能是 a-z0-9_- 且小写字母开头：${localId}（服务端规则）`);
	}
	const prepared = await preparePublishBundle({ dataRoot, kind, localId, version, meta });

	const created = await ensurePackage({ market, kind, localId, meta: {
		name: prepared.manifest.name,
		description: prepared.manifest.description,
		category: prepared.manifest.category,
		...meta,
	} });

	// ② 传版本（raw tar.gz）
	//
	// ★ 发布原子性（§10）：这一步失败时，如果包是**刚建的**，回滚掉 ——
	//   否则商城会留一个"有包无版本"的空壳，用户能看见但装不了 ✗
	//   （`preparePublishBundle` 已在上一步完成，这里只包网络这一步）
	let uploaded;
	try {
		uploaded = await market.upload(
			`/packages/${encodeURIComponent(localId)}/versions/raw`,
			prepared.gzBuffer,
			{ changelog },
		);
	} catch (e) {
		const rb = await rollbackEmptyPackage(market, localId, created);
		throw new Error(`${String(e?.message ?? e).slice(0, 320)}${rollbackNote(created, rb)}`);
	}
	return {
		ok: true,
		version: typeof uploaded?.version === 'string' ? uploaded.version : version,
		created,
		fileCount: prepared.files.length,
		bytes: prepared.gzBuffer.length,
	};
}

/** 下架整个包（软删，服务端判权）。 */
export async function deletePackage({ market, slug }) {
	if (!slug) { throw new Error('deletePackage 需要 slug'); }
	await market.request('DELETE', `/packages/${encodeURIComponent(slug)}`);
	return { ok: true, changed: true };
}

/** 下架某个版本（服务端会重算 latest ✓）。 */
export async function deleteVersion({ market, slug, version }) {
	if (!slug || !version) { throw new Error('deleteVersion 需要 slug 与 version'); }
	await market.request('DELETE', `/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`);
	return { ok: true, changed: true };
}
