// @vssaros/dsh-market — 「工作台商城」的**目录（catalog）纯逻辑**。
//
// 为什么单独一个文件：这段是**判据**（什么算一个合法条目、指标怎么取、响应体长什么样）
// ⇒ 必须**可单测** ⇒ 不碰 I/O、不 import 任何 dsh 包。
//
// ── 目录协议（schemaVersion 2）────────────────────────────────────────────────
// 口径**对齐 dsh-desktop 的已发布工作台目录**（`packages/dsh-desktop-workbenches/catalog.mjs`
// 的 `validatePublishedCatalog`）—— 那就是 dsh 工作台的**公共市场**：
//   {
//     "schemaVersion": 2,
//     "kind": "catalog",
//     "categories": [{ "id": "productivity", "name": { "zh": "效率", "en": "Productivity" } }],
//     "workbenches": [{
//       "id": "owner/repo",                       // 目录内唯一（= GitHub 仓库身份，小写）
//       "workbenchId": "wb-owner-repo",           // 可选（兼容旧 id）
//       "owner": "owner", "repository": "repo",
//       "url": "https://github.com/owner/repo",
//       "name": "中文名", "nameEn": "English name",
//       "description": { "zh": "…", "en": "…" },  // 中英**都**必填
//       "screenshots": [{ "url": "https://…", "alt": "…", "width": 1600, "height": 900,
//                          "bytes": 70442, "sha256": "<64 位 hex>" }],   // 1 张起
//       "category": "productivity",               // 必须在 categories 里
//       "version": "1.0.15",
//       "license": "MIT",
//       "distribution": { "type": "npm" | "github-release" | "github-source",
//                         "version": "1.0.15", "url": "…", "sha256": "…", "bytes": 2825083,
//                         "commit": "…", "name": "包名" },
//       "sourceCommit": "…", "updatedAt": "2026-10-21T06:20:44.000Z",
//       "probe": { "status": "ok" },
//       "metrics": { "githubStars": { "value": 202, "status": "ok" },
//                    "npmDownloads30d": { "value": null, "status": "not_applicable" },
//                    "githubReleaseDownloads": { "value": 303, "status": "ok" } }
//     }]
//   }
//
// ⚠ **缺字段如实留空**（不编造作者 / 下载量 / 截图）—— 界面据此**少渲染一块**，
//   而不是显示 0 或假数字（dsh-desktop 的同款纪律：`listed !== true ⇒ 不渲染指标`）。

/** 目录协议版本（与公开市场、随包兜底目录一致）。 */
export const CATALOG_SCHEMA_VERSION = 2;
/** 目录的 kind 标记（防止把别的 JSON 当目录吃下去）。 */
export const CATALOG_KIND = 'catalog';
/** 缺省分类（条目没写 category 时归这里；界面显示「其他」）。 */
export const DEFAULT_CATEGORY = 'other';
/** 公开市场目录地址（dsh 工作台的公共市场；随包兜底目录只作离线降级）。 */
export const DEFAULT_CATALOG_URL = 'https://market.dshdesktop.com/index.json';
/** 工作台市场的策展仓库（投稿 PR 提交到这里；本机不保存投稿状态）。 */
export const WORKBENCH_MARKET_REPO = 'https://github.com/dataelement/awesome-dsh-workbench';
/** 已发布目录允许的发布源类型（顺序 = 选取顺序：npm → GitHub Release → GitHub 源码）。 */
export const DISTRIBUTION_TYPES = ['npm', 'github-release', 'github-source'];
/** 公开市场的 7 个分类（与目录里的 categories 一致；缺省时用它兜底）。 */
export const DEFAULT_CATEGORIES = [
	{ id: 'development', name: { zh: '开发', en: 'Development' } },
	{ id: 'productivity', name: { zh: '效率', en: 'Productivity' } },
	{ id: 'content', name: { zh: '内容', en: 'Content' } },
	{ id: 'data', name: { zh: '数据', en: 'Data' } },
	{ id: 'research', name: { zh: '调研', en: 'Research' } },
	{ id: 'operations', name: { zh: '运营', en: 'Operations' } },
	{ id: 'other', name: { zh: '其他', en: 'Other' } },
];

function isObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim() !== '') { return value.trim(); }
	}
	return '';
}

/** 是否 HTTPS 链接（目录里的仓库 / 截图都必须是 https）。 */
export function isHttpsUrl(value) {
	if (typeof value !== 'string' || value.trim() === '') { return false; }
	try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/** 旧版工作台 id 的形状（兼容期字段；新投稿不写）。 */
function isLegacyWorkbenchId(value) {
	return typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);
}

/**
 * 取数字：不是数字就用兜底值。
 *
 * ⚠ `Number(null)` 是 0、`Number('')` 也是 0 ⇒ 必须先看**有没有内容**（否则「没给」会被读成 0 ⇒
 *   界面显示假的 0 下载 / 0 Star ✗）。
 */
function numberOr(value, fallback) {
	if (value === null || value === undefined) { return fallback; }
	if (typeof value === 'string' && value.trim() === '') { return fallback; }
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

/**
 * 取多语言文本里的可读值。
 *
 * 口径：直接给字符串就用它；给对象就取中文（zh / zh-CN / zh-Hans），没有中文再取英文；
 * 都没有 ⇒ 空串（**不编造**）。
 */
export function localized(value) {
	if (typeof value === 'string') { return value.trim(); }
	if (isObject(value)) {
		const zh = firstText(value.zh, value['zh-CN'], value['zh-Hans']);
		if (zh) { return zh; }
		return firstText(value.en);
	}
	return '';
}

/** 取多语言文本里的**英文**（详情里并排展示时用；没有就空串）。 */
export function localizedEn(value) {
	if (typeof value === 'string') { return ''; }
	if (isObject(value)) { return firstText(value.en); }
	return '';
}

/**
 * 归一化**一个**已发布目录条目（字段口径见文件头）。
 *
 * ⚠ 没有 `id` 的条目**丢弃**（返回 null）：没有 id 就无法寻址（收藏 / 安装 / 打开都指着它）。
 * ⚠ 其余字段**缺就留空**，绝不编造。
 */
export function normalizeWorkbench(raw) {
	if (!isObject(raw)) { return null; }
	const id = firstText(raw.id);
	if (!id) { return null; }
	const distribution = isObject(raw.distribution) ? raw.distribution : null;
	const distributionType = firstText(distribution?.type);
	const metrics = isObject(raw.metrics) ? raw.metrics : null;
	// 指标：只认**非负整数**，且以 dsh-desktop 的优先级取（npm 30 天下载 → Release 下载）。
	const stars = metricOf(metrics?.githubStars);
	const downloads = metricOf(metrics?.npmDownloads30d, metrics?.githubReleaseDownloads);
	return {
		id,
		/** 旧版 id（兼容期）—— 没有就空串（不编造）。 */
		workbenchId: firstText(raw.workbenchId),
		legacyWorkbenchIds: Array.isArray(raw.legacyWorkbenchIds) ? raw.legacyWorkbenchIds.filter(isLegacyWorkbenchId) : [],
		owner: firstText(raw.owner),
		repository: firstText(raw.repository),
		/** 仓库主页（GitHub）。 */
		url: firstText(raw.url),
		name: firstText(raw.name),
		nameEn: firstText(raw.nameEn),
		description: localized(raw.description),
		descriptionEn: localizedEn(raw.description),
		category: firstText(raw.category) || DEFAULT_CATEGORY,
		version: firstText(raw.version, distribution?.version),
		license: firstText(raw.license),
		updatedAt: firstText(raw.updatedAt),
		sourceCommit: firstText(raw.sourceCommit),
		/** 探测状态（自动检查的结论）：没有就空串。 */
		probeStatus: firstText(raw.probe?.status),
		/** 指标：目录没给就是 null（界面整块不渲染，不显示 0 ✗）。 */
		stars,
		downloads,
		/** 截图：只留 url 合法的（缺 url 的没法渲染 ⇒ 丢）。 */
		screenshots: Array.isArray(raw.screenshots)
			? raw.screenshots
				.filter(isObject)
				.map(shot => ({
					url: firstText(shot.url),
					alt: firstText(shot.alt),
					width: numberOr(shot.width, 0),
					height: numberOr(shot.height, 0),
					bytes: numberOr(shot.bytes, 0),
					sha256: firstText(shot.sha256),
				}))
				.filter(shot => shot.url)
			: [],
		/** 发布源：type + 取包方式（界面据此显示「安装」/「查看安装说明」）。 */
		distribution: distribution
			? {
				type: distributionType,
				url: firstText(distribution.url),
				sha256: firstText(distribution.sha256),
				bytes: numberOr(distribution.bytes, 0),
				version: firstText(distribution.version),
				commit: firstText(distribution.commit),
				name: firstText(distribution.name),
			}
			: null,
		/** npm 来源才有包名（其它来源装完才知道包名）。 */
		packageName: distributionType === 'npm' ? firstText(distribution?.name) : '',
		/** 已发布目录里的条目都是「已上架」的。 */
		listed: true,
		/** 可安装 = 发布源合法（三种之一）。 */
		installable: DISTRIBUTION_TYPES.includes(distributionType),
	};
}

/** 指标取值：status 必须是 ok、value 必须是非负整数（否则没有数据）。 */
function metricOf(...holders) {
	for (const holder of holders) {
		if (!isObject(holder)) { continue; }
		if (holder.status !== undefined && holder.status !== 'ok') { continue; }
		const value = holder.value;
		if (Number.isSafeInteger(value) && value >= 0) { return value; }
	}
	return null;
}

/**
 * 校验**已发布目录**（照 dsh-desktop `validatePublishedCatalog` 的口径，只把消息换成中文）。
 *
 * ⚠ 校验不过 ⇒ 抛错（调用方据此如实报「目录不可用」）。**不要**把它降级成"空目录"——
 *   那会让用户以为"市场是空的"，而不是"目录读到了但坏了"（两种故障的处置完全不同 ✗）。
 */
export function validatePublishedCatalog(value) {
	if (!isObject(value)) { throw new Error('工作台目录不是一个对象'); }
	if (value.schemaVersion !== CATALOG_SCHEMA_VERSION) {
		throw new Error(`工作台目录协议版本不支持：${String(value.schemaVersion)}`);
	}
	if (value.kind !== CATALOG_KIND) { throw new Error('工作台目录 kind 不是 catalog'); }
	if (!Array.isArray(value.categories)) { throw new Error('工作台目录缺 categories 数组'); }
	if (!Array.isArray(value.workbenches)) { throw new Error('工作台目录缺 workbenches 数组'); }

	const categories = new Map();
	for (const category of value.categories) {
		if (!isObject(category) || !firstText(category.id) || !isObject(category.name) || !firstText(category.name.zh)) {
			throw new Error('工作台目录的分类不合法');
		}
		if (categories.has(firstText(category.id))) { throw new Error('工作台目录的分类 id 重复'); }
		categories.set(firstText(category.id), category.name.zh);
	}

	const ids = new Set();
	const legacyIds = new Map();
	for (const entry of value.workbenches) {
		if (!isObject(entry)) { throw new Error('工作台目录条目不是一个对象'); }
		const id = firstText(entry.id);
		const owner = firstText(entry.owner);
		const repository = firstText(entry.repository);
		const url = firstText(entry.url);
		const distribution = isObject(entry.distribution) ? entry.distribution : null;
		if (!id || ids.has(id)) { throw new Error('工作台目录条目 id 缺失或重复'); }
		if (!owner || !repository) { throw new Error(`工作台目录条目 ${id} 缺 owner/repository`); }
		if (!isHttpsUrl(url)) { throw new Error(`工作台目录条目 ${id} 的 url 不是 https`); }
		if (!firstText(entry.name)) { throw new Error(`工作台目录条目 ${id} 缺 name`); }
		if (!categories.has(firstText(entry.category))) { throw new Error(`工作台目录条目 ${id} 的分类未登记`); }
		if (!isObject(entry.description) || !firstText(entry.description.zh) || !firstText(entry.description.en)) {
			throw new Error(`工作台目录条目 ${id} 的中英简介不完整`);
		}
		if (!firstText(entry.version)) { throw new Error(`工作台目录条目 ${id} 缺 version`); }
		if (!firstText(entry.license)) { throw new Error(`工作台目录条目 ${id} 缺 license`); }
		if (!distribution || !DISTRIBUTION_TYPES.includes(firstText(distribution.type))) {
			throw new Error(`工作台目录条目 ${id} 的发布源类型不支持`);
		}
		if (!firstText(distribution.version) || firstText(distribution.version) !== firstText(entry.version)) {
			throw new Error(`工作台目录条目 ${id} 的发布源版本与条目版本不一致`);
		}
		if (entry.workbenchId !== undefined && !isLegacyWorkbenchId(entry.workbenchId)) {
			throw new Error(`工作台目录条目 ${id} 的 workbenchId 不合法`);
		}
		if (entry.legacyWorkbenchIds !== undefined) {
			if (!Array.isArray(entry.legacyWorkbenchIds)
				|| !entry.legacyWorkbenchIds.every(isLegacyWorkbenchId)
				|| new Set(entry.legacyWorkbenchIds).size !== entry.legacyWorkbenchIds.length) {
				throw new Error(`工作台目录条目 ${id} 的 legacyWorkbenchIds 不合法`);
			}
		}
		if (!Array.isArray(entry.screenshots) || entry.screenshots.length < 1) {
			throw new Error(`工作台目录条目 ${id} 缺截图`);
		}
		for (const shot of entry.screenshots) {
			if (!isObject(shot) || !isHttpsUrl(shot.url) || !firstText(shot.alt)
				|| !/^[a-f0-9]{64}$/.test(firstText(shot.sha256))
				|| !Number.isSafeInteger(shot.width) || shot.width <= 0
				|| !Number.isSafeInteger(shot.height) || shot.height <= 0
				|| !Number.isSafeInteger(shot.bytes) || shot.bytes <= 0) {
				throw new Error(`工作台目录条目 ${id} 的截图信息不合法`);
			}
		}
		// 身份必须是 `owner/repository`（小写）且 url 指向同一个仓库。
		const repositoryId = `${owner}/${repository}`.toLowerCase();
		if (id !== repositoryId || url.toLowerCase() !== `https://github.com/${repositoryId}`) {
			throw new Error(`工作台目录条目 ${id} 的仓库身份不一致`);
		}
		for (const legacy of [entry.workbenchId, ...(entry.legacyWorkbenchIds || [])]) {
			if (legacy === undefined) { continue; }
			if (legacyIds.has(legacy) && legacyIds.get(legacy) !== id) {
				throw new Error('工作台目录的旧版 id 被多个条目占用');
			}
			legacyIds.set(legacy, id);
		}
		ids.add(id);
	}
	return structuredClone(value);
}

/**
 * 归一化**整份**目录：先按已发布协议校验（不符 ⇒ 抛错），再逐条归一化。
 *
 * ⚠ 坏条目在校验阶段就被拒（整份目录不可用）—— 这与 dsh-desktop 一致：目录是**发布产物**，
 *   有一条坏了就是目录坏了（我们不替发布方"修"目录，否则用户看到的是被悄悄改过的市场 ✗）。
 */
export function normalizeCatalog(raw) {
	const validated = validatePublishedCatalog(raw);
	const categories = validated.categories.map(item => ({
		id: firstText(item.id),
		name: { zh: firstText(item.name?.zh), en: firstText(item.name?.en) },
	}));
	const workbenches = [];
	for (const item of validated.workbenches) {
		const entry = normalizeWorkbench(item);
		if (entry) { workbenches.push(entry); }
	}
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		kind: CATALOG_KIND,
		categories,
		workbenches,
	};
}

/**
 * 合并多份条目列表：**先出现的赢**（同 id 不覆盖）。
 *
 * 用法：随包兜底目录在前、远程目录在后 ⇒ 远程**不能**覆盖兜底条目的事实。
 */
export function mergeWorkbenches(...lists) {
	const seen = new Set();
	const out = [];
	for (const list of lists) {
		for (const entry of Array.isArray(list) ? list : []) {
			if (!entry || !entry.id || seen.has(entry.id)) { continue; }
			seen.add(entry.id);
			out.push(entry);
		}
	}
	return out;
}

/**
 * 分类表 = 目录声明的分类 + 条目实际用到的分类（缺声明的用 id 当名字）。
 * 顺序：先声明的按声明顺序，后发现的按首次出现顺序。
 */
export function categoriesFor(workbenches, declared = []) {
	const out = [];
	const seen = new Set();
	for (const item of Array.isArray(declared) ? declared : []) {
		const id = firstText(item?.id);
		if (!id || seen.has(id)) { continue; }
		seen.add(id);
		out.push({ id, name: firstText(item?.name) || id, names: item?.names ?? null });
	}
	for (const entry of Array.isArray(workbenches) ? workbenches : []) {
		const id = firstText(entry?.category) || DEFAULT_CATEGORY;
		if (seen.has(id)) { continue; }
		seen.add(id);
		out.push({ id, name: id, names: null });
	}
	return out;
}

/**
 * 算安装态。
 *
 * 判据：① 目录 id 在**市场安装记录**里 ⇒ 已装（从市场装的）；② npm 来源的包名在
 * **已装插件名单**里 ⇒ 已装；③ 两者都不在 ⇒ 未装。
 * 已装名单来自 Host 的 pluginManager（真数据）；拿不到时名单为空 ⇒ 只有①算数（如实）。
 */
export function withInstallState(workbenches, { installedNames = [], installedCatalogIds = [] } = {}) {
	const names = new Set(
		(Array.isArray(installedNames) ? installedNames : [])
			.map(name => String(name ?? '').trim())
			.filter(Boolean),
	);
	const ids = new Set(
		(Array.isArray(installedCatalogIds) ? installedCatalogIds : [])
			.map(id => String(id ?? '').trim())
			.filter(Boolean),
	);
	// 名字有两种形态：完整包名（`@acme/dsh-b`）与去 scope 的短名（`dsh-b`）⇒ 两种都试
	// （否则「装了却显示成没装」这种最难受的错位会出现 ✗）。
	const isInstalled = (packageName) => {
		if (!packageName) { return false; }
		if (names.has(packageName)) { return true; }
		const slash = packageName.indexOf('/');
		return slash >= 0 && names.has(packageName.slice(slash + 1));
	};
	return (Array.isArray(workbenches) ? workbenches : []).map(entry => ({
		...entry,
		installed: ids.has(entry.id) || isInstalled(entry.packageName),
		installedFromMarket: ids.has(entry.id),
	}));
}

/**
 * 组装 API 响应体（客户端拿到的就是它）。
 *
 * `source` 如实说明目录从哪来：`origin` = `remote`（公开市场）/ `bundled`（随包兜底目录），
 * `stale` = 远程读失败时回落到上一次成功的内容（界面据此提示「显示的是上一次读到的目录」）。
 */
export function catalogResponse({ workbenches = [], categories = [], source = {}, error = null } = {}) {
	const list = Array.isArray(workbenches) ? workbenches : [];
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		kind: CATALOG_KIND,
		categories: Array.isArray(categories) ? categories : [],
		workbenches: list,
		total: list.length,
		source: {
			origin: firstText(source.origin) || 'remote',
			url: firstText(source.url),
			stale: source.stale === true,
			fetchedAt: Number.isFinite(source.fetchedAt) ? source.fetchedAt : 0,
		},
		...(error ? { error: String(error) } : {}),
	};
}
