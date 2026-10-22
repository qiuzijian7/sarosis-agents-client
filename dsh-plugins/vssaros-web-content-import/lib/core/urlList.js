/**
 * 从"URL 清单文件"里抽出可导入的链接。
 *
 * ★★ 2026-10-20：为什么单独抽一个纯函数 —— 上游（爬虫 / 平台搜索 / 手工导出）给出的清单
 *   至少有四种形态，混在一起写会让 `content_import` 的 execute 变成一堆 if：
 *
 *   · `.txt`          每行一个 URL（最简单，人工整理时最常用）
 *   · `.jsonl`        每行一个对象（MediaCrawler 的 JSONL writer 就是这个形态 ✓）
 *   · `.json`         数组，或 `{ contents: [...] }` 这种包一层的形态
 *   · `.csv`          MediaCrawler 的 CSV writer；URL 通常在第一列或某列里
 *
 * 口径：**只认 http(s)**，且**保持原顺序、去重**（顺序是搜索相关性的隐含信息，别打乱）。
 *   ⚠ 不猜"哪个字段是 URL"：按一份**已知字段名清单**取，取不到就退化为"全对象里扫 http 串"——
 *     后者能兜住几乎一切爬虫输出，代价是偶尔会带出图片 URL（由调用方 `maxChars`/平台识别过滤）。
 *
 * 纯函数、无 IO：这样能直接单测，也能让 IDE 侧复用同一份逻辑（避免两处口径漂移）。
 */

/** MediaCrawler / 常见爬虫的 URL 字段名（按优先级；同一个对象里先命中的胜出）。 */
const URL_FIELDS = [
	'note_url', 'aweme_url', 'video_url', 'content_url', 'article_url',
	'url', 'share_url', 'link', 'href', 'detail_url', 'source_url',
];

/** 看起来像内容页（而不是图片/静态资源）的 http(s) 链接。 */
function isLikelyContentUrl(text) {
	if (!/^https?:\/\//i.test(text)) { return false; }
	// 排除明显的静态资源：图片/视频文件、字体、js/css
	if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|mp4|m3u8|webm|mp3|m4a|css|js)(\?|#|$)/i.test(text)) { return false; }
	return true;
}

/**
 * 去重键：**忽略 query / hash**，只比 origin + pathname。
 *
 * ★★ 2026-10-20（核 MediaCrawler 字段时发现）：小红书的 `note_url` 长这样 ——
 *   `https://www.xiaohongshu.com/explore/{note_id}?xsec_token=xxx&xsec_source=yyy`
 *   那个 token 是**短时效**的，同一篇笔记在不同次搜索里 token 不同 ⇒ 按完整 URL 去重
 *   会把同一篇判成两条 ⇒ **重复导入、重复写文件** ✗。
 *   ⇒ 按"同一篇内容"的身份去重（origin + pathname），token 差异不算不同篇。
 */
function dedupeKey(url) {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

function pushUrl(out, seen, value) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!isLikelyContentUrl(text)) { return; }
	const key = dedupeKey(text);
	const existing = seen.get(key);
	if (existing === undefined) {
		seen.set(key, out.length);
		out.push(text);
		return;
	}
	// 已收录同一篇：**保留带 xsec_token 的那条**（小红书不带 token 常常抓不到），
	// 其余情况保持先来先得（不因为 URL 更长就覆盖 ✓）。
	if (!/xsec_token=/i.test(out[existing]) && /xsec_token=/i.test(text)) {
		out[existing] = text;
	}
}

/** 从一个对象里按已知字段名取 URL（取不到返回空）。 */
function urlOfObject(item) {
	if (!item || typeof item !== 'object') { return ''; }
	for (const field of URL_FIELDS) {
		const value = item[field];
		if (typeof value === 'string' && isLikelyContentUrl(value.trim())) {
			return value.trim();
		}
	}
	return '';
}

/** 兜底：把对象里的值拍平，扫第一个像内容页的 http(s) 串（覆盖未知字段名的爬虫）。 */
function scanObjectForUrl(item, depth = 0) {
	if (depth > 4 || !item || typeof item !== 'object') { return ''; }
	for (const value of Object.values(item)) {
		if (typeof value === 'string' && isLikelyContentUrl(value.trim())) { return value.trim(); }
	}
	for (const value of Object.values(item)) {
		if (value && typeof value === 'object') {
			const found = scanObjectForUrl(value, depth + 1);
			if (found) { return found; }
		}
	}
	return '';
}

/**
 * 极简 CSV 解析（只处理"带引号字段 / 逗号分隔"这一种，够读爬虫导出）。
 * ⚠ 不引 CSV 库：这里只用来**找 URL 列**，不需要完整语义。
 */
function parseCsvLine(line) {
	const cells = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') { cell += '"'; i++; }
				else { quoted = false; }
			} else { cell += ch; }
		} else if (ch === '"') { quoted = true; }
		else if (ch === ',') { cells.push(cell); cell = ''; }
		else { cell += ch; }
	}
	cells.push(cell);
	return cells;
}

/**
 * 主入口：文本 → URL 列表。
 *
 * @param {string} text 文件内容
 * @param {string} [hint] 文件名或扩展名（`.csv` / `.jsonl` / `.json` / `.txt`），用于选解析策略
 * @returns {string[]} 去重后的 http(s) 链接（保持原始顺序）
 */
export function extractUrlsFromText(text, hint = '') {
	const out = [];
	// Map<去重键, 该 URL 在 out 里的下标>（便于"保留带 token 的那条"时原地替换 ✓）
	const seen = new Map();
	const raw = typeof text === 'string' ? text : '';
	if (!raw.trim()) { return out; }

	const ext = String(hint ?? '').toLowerCase();
	const looksCsv = ext.endsWith('.csv');

	// ① 先按"整块 JSON"试（数组 / {contents:[...]} 这类）
	const trimmed = raw.trim();
	if (!looksCsv && (trimmed.startsWith('[') || trimmed.startsWith('{'))) {
		try {
			const parsed = JSON.parse(trimmed);
			const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.contents) ? parsed.contents : [parsed]);
			for (const item of items) {
				const url = urlOfObject(item) || scanObjectForUrl(item);
				if (url) { pushUrl(out, seen, url); }
			}
			if (out.length > 0) { return out; }
		} catch { /* 不是合法 JSON ⇒ 继续按行处理 */ }
	}

	// ② 逐行：JSONL / CSV / 纯文本 三种都兼容（按行内特征分流，不信扩展名）
	for (const line of raw.split(/\r?\n/)) {
		const text2 = line.trim();
		if (!text2) { continue; }
		// 纯 URL 行
		if (isLikelyContentUrl(text2)) { pushUrl(out, seen, text2); continue; }
		// JSONL 行
		if (text2.startsWith('{') || text2.startsWith('[')) {
			try {
				const item = JSON.parse(text2);
				const url = urlOfObject(item) || scanObjectForUrl(item);
				if (url) { pushUrl(out, seen, url); continue; }
			} catch { /* 落到 CSV/内联扫描 */ }
		}
		// CSV 行：先按列解析，取"像内容页"的那一格
		if (text2.includes(',') && text2.includes('"')) {
			const hit = parseCsvLine(text2).map(c => c.trim()).find(c => isLikelyContentUrl(c));
			if (hit) { pushUrl(out, seen, hit); continue; }
		}
		// 兜底：行内任意 http(s) 串
		const m = /https?:\/\/[^\s,"'<>]+/gi.exec(text2);
		if (m) { pushUrl(out, seen, m[0]); }
	}
	return out;
}
