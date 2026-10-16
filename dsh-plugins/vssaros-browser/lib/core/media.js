/**
 * `media` op 的采集 / 归一 / 渲染（2026-10-15；只读）。
 *
 * ## 为什么需要它（真机现场）
 *
 * 抓小红书视频笔记时，模型拿到的结论是"三条路都堵死：content_import 被判页面不存在、yt-dlp/ffmpeg 未安装"
 * —— 但当时**已登录的真 Chrome 就在我们手里**，视频的直链信息就在页面里。缺的只是"把页面里的媒体事实读出来"
 * 这一格工具 ⇒ 本模块补这一格（**只读**：只采集事实、不给下载 ⇒ 不过审批 ✓）。
 *
 * ## 收什么（四条来源，互为冗余 —— 播放器形态太多，单一来源必漏）
 *
 *   ① `<video>` / `<audio>` 元素：src（currentSrc 优先）、poster、时长、尺寸、是否正在播；
 *   ② `og:video*` / `og:audio*` meta（分享卡片级的直链，很多站点自带）；
 *   ③ **资源清单**（`performance.getEntriesByType('resource')` 里扩展名像媒体的条目）——
 *      这一条专治"`<video>` 用 `blob:`"的页面（HLS/MSE）：真实 CDN 分片/整片**被请求过** ⇒ 会出现在这里；
 *   ④ blob 计数：**如实报**"页面用了 N 个 blob: 媒体源"（那种源对模型不可消费 —— 不说就是假直链 ✗）。
 *
 * ## 边界（刻意的）
 *
 * · **只收 http(s) 直链**：`blob:` / `data:` 是页面本地生成的播放对象 ⇒ 收进来就是"看着有、用不了" ✗；
 * · 跨源 iframe 读不到（同源策略，与 snapshot 同一取向 ✓）；
 * · **不做下载**（写盘是动作类 —— 真要落地走 shell / `evaluate` 那条带审批的路）；
 * · 站点私有的状态树（如 `__INITIAL_STATE__`）**不进**这个通用工具 —— 那是技能层的事 ✗。
 */

/** 媒体元素上限（video + audio 合计）。 */
export const MEDIA_MAX_ELEMENTS = 12;
/** 资源清单里回给的媒体 URL 上限。 */
export const MEDIA_MAX_RESOURCE_URLS = 20;
/** og 直链上限。 */
export const MEDIA_MAX_OG_URLS = 6;
/** 单条 URL 长度上限（签名直链可能很长 ⇒ 截断但保留可判读前缀）。 */
export const MEDIA_URL_MAX_CHARS = 400;

/** 资源清单里"像媒体"的扩展名（命中即收；不含 `.ts` —— HLS 分片噪音太大 ✗）。 */
const MEDIA_EXT_RE = /\.(mp4|m3u8|m4s|mp3|m4a|aac|flac|flv|webm|mov)(\?|#|$)/i;

/**
 * 页内采集脚本（我们自己的固定语句 ⇒ 不受 `allowEvaluate` 约束 ✓）。
 * ⚠ 纪律同 `SNAPSHOT_SCRIPT`：只采集原始事实；字符串里不能出现反引号或 `${`。
 */
export const MEDIA_SCRIPT = `(() => {
  var MAXE = ${MEDIA_MAX_ELEMENTS}, MAXR = ${MEDIA_MAX_RESOURCE_URLS}, MAXO = ${MEDIA_MAX_OG_URLS}, MAXU = ${MEDIA_URL_MAX_CHARS};
  var out = { url: location.href, title: document.title, elements: [], ogUrls: [], resourceUrls: [], blobCount: 0, truncatedElements: false, truncatedResources: false };
  var clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };
  var clip = function (u) { u = String(u == null ? '' : u); return u.length > MAXU ? u.slice(0, MAXU) + '…' : u; };
  var seen = {};
  var pushUrl = function (list, u, max, flagKey) {
    u = String(u == null ? '' : u);
    if (!u || u.indexOf('http') !== 0) { return; }
    if (seen[u]) { return; }
    seen[u] = 1;
    if (list.length >= max) { out[flagKey] = true; return; }
    list.push(clip(u));
  };
  var collectMediaEls = function (root) {
    var list = root.querySelectorAll('video,audio');
    for (var i = 0; i < list.length; i++) {
      try {
        var el = list[i];
        var src = '';
        try { src = el.currentSrc || el.src || ''; } catch (e) { src = ''; }
        if (!src) { var s = el.querySelector ? el.querySelector('source') : null; if (s) { src = s.src || (s.getAttribute ? (s.getAttribute('src') || '') : ''); } }
        if (src && src.indexOf('blob:') === 0) { out.blobCount = out.blobCount + 1; }
        if (src && src.indexOf('http') !== 0) { src = ''; }
        var poster = ''; try { poster = el.poster || (el.getAttribute ? (el.getAttribute('poster') || '') : ''); } catch (e) { }
        if (!src && !poster) { continue; }
        if (out.elements.length >= MAXE) { out.truncatedElements = true; continue; }
        var label = el.getAttribute ? (el.getAttribute('title') || el.getAttribute('aria-label') || '') : '';
        var dur = 0; try { dur = (typeof el.duration === 'number' && isFinite(el.duration)) ? Math.round(el.duration) : 0; } catch (e) { }
        var w = 0, h = 0;
        try { var r = el.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); } catch (e) { }
        out.elements.push({
          kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
          src: clip(src), poster: clip(poster && poster.indexOf('http') === 0 ? poster : ''),
          duration: dur, width: w, height: h, title: clean(label).slice(0, 120),
          paused: !!el.paused,
        });
      } catch (e) { }
    }
  };
  try { collectMediaEls(document); } catch (e) { }
  try {
    var frames = document.querySelectorAll('iframe');
    for (var fi = 0; fi < frames.length; fi++) {
      try { var doc = frames[fi].contentDocument; if (doc) { collectMediaEls(doc); } } catch (e) { }
    }
  } catch (e) { }
  try {
    var metas = document.querySelectorAll('meta[property^="og:video"],meta[property^="og:audio"],meta[name="og:video"],meta[name="og:audio"]');
    for (var mi = 0; mi < metas.length; mi++) {
      var c = metas[mi].getAttribute ? (metas[mi].getAttribute('content') || '') : '';
      if (c && /\\.(mp4|m3u8|mp3|m4a|webm|mov)(\\?|#|$)/i.test(c)) { pushUrl(out.ogUrls, c, MAXO, 'truncatedOg'); }
    }
  } catch (e) { }
  try {
    var res = performance.getEntriesByType('resource') || [];
    for (var ri = res.length - 1; ri >= 0; ri--) {
      var nm = res[ri] && res[ri].name ? String(res[ri].name) : '';
      if (/\\.(mp4|m3u8|m4s|mp3|m4a|aac|flac|flv|webm|mov)(\\?|#|$)/i.test(nm)) { pushUrl(out.resourceUrls, nm, MAXR, 'truncatedResources'); }
    }
  } catch (e) { }
  return out;
})()`;

/** 把脚本返回收窄成类型（页面可能返回意外形状 —— 与 `normalizeRawImages` 同一防御姿势）。 */
export function normalizeRawMedia(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const elements = Array.isArray(r.elements) ? r.elements
		.filter(e => !!e && typeof e === 'object')
		.map(e => ({
			kind: e.kind === 'audio' ? 'audio' : 'video',
			src: typeof e.src === 'string' ? e.src : '',
			poster: typeof e.poster === 'string' ? e.poster : '',
			duration: typeof e.duration === 'number' && Number.isFinite(e.duration) ? e.duration : 0,
			width: typeof e.width === 'number' ? e.width : 0,
			height: typeof e.height === 'number' ? e.height : 0,
			title: typeof e.title === 'string' ? e.title : '',
			paused: e.paused === true,
		}))
		.filter(e => e.src || e.poster)
		: [];
	const ogUrls = Array.isArray(r.ogUrls) ? r.ogUrls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
	const resourceUrls = Array.isArray(r.resourceUrls) ? r.resourceUrls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
	return {
		url: typeof r.url === 'string' ? r.url : '',
		title: typeof r.title === 'string' ? r.title : '',
		elements,
		ogUrls,
		resourceUrls,
		blobCount: typeof r.blobCount === 'number' ? r.blobCount : 0,
		truncatedElements: r.truncatedElements === true,
		truncatedResources: r.truncatedResources === true,
	};
}

/** 渲染给模型的文本（纯函数 ⇒ 可单测；blob 与截断都要**如实报** ✗）。 */
export function formatMedia(raw) {
	const lines = [];
	lines.push(`# media —— ${raw.title || '(无标题)'}`);
	lines.push(raw.url || '(无 url)');
	lines.push('');
	if (raw.elements.length > 0) {
		lines.push(`## 媒体元素（${raw.elements.length}${raw.truncatedElements ? `，还有未列出（上限 ${MEDIA_MAX_ELEMENTS}）` : ''}）`);
		for (const e of raw.elements) {
			const bits = [];
			if (e.duration > 0) { bits.push(`${e.duration}s`); }
			if (e.width > 0 && e.height > 0) { bits.push(`${e.width}×${e.height}`); }
			if (e.title) { bits.push(`"${e.title}"`); }
			bits.push(e.paused ? '未在播' : '在播');
			lines.push(`- [${e.kind}] ${e.src || '(无 http 直链)'}（${bits.join('，')}）`);
			if (e.poster) { lines.push(`  poster: ${e.poster}`); }
		}
	} else {
		lines.push('## 媒体元素：0 个');
	}
	if (raw.ogUrls.length > 0) {
		lines.push('', `## og:video / og:audio 直链（${raw.ogUrls.length}）`);
		for (const u of raw.ogUrls) { lines.push(`- ${u}`); }
	}
	if (raw.resourceUrls.length > 0) {
		lines.push('', `## 资源清单里像媒体的请求（${raw.resourceUrls.length}${raw.truncatedResources ? `，还有未列出（上限 ${MEDIA_MAX_RESOURCE_URLS}）` : ''} —— 播放器真正拉过的地址）`);
		for (const u of raw.resourceUrls) { lines.push(`- ${u}`); }
	}
	if (raw.blobCount > 0) {
		lines.push('', `⚠ 页面有 **${raw.blobCount}** 个 \`blob:\` 媒体源（HLS/MSE 本地播放对象，**不可下载**）⇒ 真实地址看上方的"资源清单"，或该站点根本不给直链（加密流）。`);
	}
	if (raw.elements.length === 0 && raw.ogUrls.length === 0 && raw.resourceUrls.length === 0 && raw.blobCount === 0) {
		lines.push('', '没有发现媒体（这一帧里没有 video/audio 元素，也没有媒体样的资源请求）。若内容还没加载出来，先 `waitFor` / `scroll` 再查。');
	}
	return lines.join('\n');
}
