/**
 * 画廊筛选（纯逻辑，宿主与页面共用）。
 *
 * 为什么单独一个模块：工作台的筛选（来源 / provider / 时间 / 关键字）要**在页面侧**做
 *   （规范 §4.2：一次取数，三个壳共用 ⇒ 不能每个壳各发一次请求）⇒ 筛选规则必须是**纯函数**
 *   ⇒ 探针可以直接 import 它测（不必起浏览器、不必起 Host）✓。
 *
 * 画廊有两个来源：
 *   · `recent`   —— 「最近出图」账本（内存；出图/导入时记账；带 provider/model）；
 *   · `workspace`—— 工作区里已落盘的图（`<工作区>/.vssaros-images/`；**持久**，Host 重启还在）。
 */

/** 来源取值。 */
export const GALLERY_SOURCES = ['all', 'recent', 'workspace'];

/**
 * 时间范围的起点（毫秒时间戳；0 = 不限）。
 * @param {string} range 'today' | 'week' | 'all' | 其它
 * @param {number} [now]
 * @returns {number}
 */
export function timeRangeSince(range, now = Date.now()) {
	const key = String(range ?? '').trim();
	if (key === 'today') {
		const d = new Date(now);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	if (key === 'week') {
		return now - 7 * 24 * 60 * 60 * 1000;
	}
	return 0;
}

/**
 * 画廊筛选。
 *
 * @param {Array<object>} items 画廊条目（统一形状：{id,url,prompt,at,source,provider,model,name}）
 * @param {object} [filters]
 * @param {string} [filters.source] 'all' | 'recent' | 'workspace'（默认 all）
 * @param {string} [filters.provider] provider id（空 = 不限）
 * @param {number} [filters.since] 起点（毫秒；0 = 不限）
 * @param {number} [filters.until] 终点（毫秒；0 = 不限）
 * @param {string} [filters.keyword] 关键字（prompt / 名字 / provider / 模型）
 * @returns {Array<object>}
 */
export function filterGallery(items, filters = {}) {
	const source = String(filters.source ?? 'all').trim() || 'all';
	const provider = String(filters.provider ?? '').trim();
	const since = Number(filters.since) || 0;
	const until = Number(filters.until) || 0;
	const keyword = String(filters.keyword ?? '').trim().toLowerCase();
	return (Array.isArray(items) ? items : []).filter(item => {
		if (!item) { return false; }
		if (source !== 'all' && String(item.source ?? 'recent') !== source) { return false; }
		if (provider && String(item.provider ?? '') !== provider) { return false; }
		const at = Number(item.at) || 0;
		if (since && at < since) { return false; }
		if (until && at > until) { return false; }
		if (keyword) {
			const hay = [
				item.prompt ?? '', item.name ?? '', item.provider ?? '', item.model ?? '',
			].join(' ').toLowerCase();
			if (!hay.includes(keyword)) { return false; }
		}
		return true;
	});
}

/**
 * 画廊里出现过的 provider 列表（筛选下拉用；空 = 还没出图）。
 * @param {Array<object>} items
 * @returns {Array<string>}
 */
export function galleryProviders(items) {
	const set = new Set();
	for (const item of Array.isArray(items) ? items : []) {
		const provider = String(item?.provider ?? '').trim();
		if (provider) { set.add(provider); }
	}
	return Array.from(set).sort();
}
