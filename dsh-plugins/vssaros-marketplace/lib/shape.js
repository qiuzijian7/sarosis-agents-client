// @vssaros/dsh-marketplace — **服务端 pkg → 前端形状**的唯一映射（★ 2026-10-23 抽出）
//
// 为什么抽：`list` / `detail` / `reviewList` 三处各自手写了一遍同样的字段映射
//   （`latest_version ?? ''` / `author_name ?? ''` / `distribution_type ?? 'bundle'` …）
//   ⇒ **改一个字段要改三处，漏一处就是"列表有、详情没有"这类静默不一致** ✗
//   而且映射逻辑困在 `apply()` 闭包里，**单测摸不到**（要起整个 Host）。
//
// 现在：公共字段只有 `baseOf()` 一份；差异部分（已安装版本 / 审核字段 / 版本列表）
//   用显式选项加上去 ✓ 「list 与 detail 的公共字段必须一致」也变成可断言的了。

/** 各字段的空值口径（服务端可能不返回某个键）。 */
function baseOf(pkg) {
	const p = pkg ?? {};
	return {
		id: p.id,
		kind: p.kind,
		slug: p.slug,
		name: p.name,
		// `latest_version` 是列表视图的字段；详情可能只给 `version`
		version: p.latest_version ?? p.version ?? '',
		description: p.description ?? '',
		// 详情接口的作者在 `author` 对象里，列表里是 `author_name`
		author: p.author_name ?? p.author?.display_name ?? p.author?.username ?? '',
		category: p.category ?? '',
		icon: p.icon ?? '',
		tags: Array.isArray(p.tags) ? p.tags : [],
		status: p.status ?? 'active',
		distributionType: p.distribution_type ?? 'bundle',
		distribution: p.distribution_meta ?? null,
		permissions: p.permissions ?? null,
	};
}

/**
 * 列表卡片（`list` 与 `reviewList` 共用）。
 *
 * @param {object} pkg 服务端返回的包
 * @param {{ installedVersion?: string, review?: boolean }} [opts]
 *   · `installedVersion`：给了就带上（页面标"已安装/可升级"）
 *   · `review`：审核队列专用字段（`featured` / `pendingSince`）
 */
export function toPackageSummary(pkg, opts = {}) {
	const out = baseOf(pkg);
	if (typeof opts.installedVersion === 'string') {
		out.installedVersion = opts.installedVersion;
	}
	if (opts.review) {
		out.featured = pkg?.featured === true;
		out.pendingSince = pkg?.pending_review_since ?? null;
		// 审核队列里的包几乎都是待审的 ⇒ 默认值不同（列表默认 active）
		if (!pkg?.status) { out.status = 'pending_review'; }
	}
	return out;
}

/**
 * 详情（= 列表卡片的**全部公共字段** + 可见性 + 版本列表）。
 *
 * ⚠ 刻意复用它 `baseOf`：详情与列表的公共字段**永远一致** ✓
 *   （以前各写一遍，加字段时漏了详情 ⇒ 编辑表单拿不到现值，可见性每次被重置 ✗）
 */
export function toPackageDetail(pkg) {
	const p = pkg ?? {};
	return {
		...baseOf(p),
		// 编辑表单要回显 ⇒ 必须带
		visibility: p.visibility ?? 'public',
		featured: p.featured === true,
		versions: (Array.isArray(p.versions) ? p.versions : []).map(v => ({
			id: v.id,
			version: v.version,
			changelog: v.changelog ?? '',
			sha256: v.sha256 ?? '',
			size: v.asset_size ?? 0,
			isLatest: v.is_latest === true,
			manifest: v.manifest ?? null,
		})),
	};
}

/**
 * 已安装项（本地台账 + 升级检查结果；**没有服务端 pkg**）。
 *
 * @param {{ kind: string, storeId: string, version: string, installedAt?: number }} entry
 * @param {string} [latest] 服务端给的最新版本（空 = 不可升级）
 */
export function toInstalledItem(entry, latest = '') {
	return {
		id: entry.storeId,
		kind: entry.kind,
		slug: entry.storeId,
		name: entry.storeId,
		version: entry.version,
		description: '',
		latestVersion: latest,
		upgradable: Boolean(latest),
		installedAt: entry.installedAt,
	};
}
