/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_snapshot` 的纯逻辑：**注入页面的采集脚本** + **渲染器**（P1-2，2026-09-24）。
 *
 * ## 为什么要拆成"脚本 + 渲染器"两半
 *
 * 注入脚本一旦发出去就无法单测（它跑在目标页里）。所以让脚本只做**尽可能笨**的事：
 * 遍历 DOM、给可交互元素打 `data-saros-ref` 标记、把结构化数据原样 return 回来。
 * 所有"怎么呈现给模型"的判断都留在 TS 侧的 `formatSnapshot` —— 那部分可以穷举单测。
 *
 * ## ref 为什么写在页面 DOM 上（而不是维护一张 backendNodeId 表）
 *
 * 点击时最可靠的做法是回到**页面自己**找到那个元素。把 ref 写成 `data-saros-ref` 属性后，
 * `browser_click` 只需在页内 `querySelector('[data-saros-ref="7"]')`，不依赖任何跨命令的
 * 节点句柄（CDP 的 nodeId/backendNodeId 会因导航/重渲染而失效，且要自己管生命周期）。
 * 代价：导航或页面重渲染后旧 ref 失效 —— 这正是"导航后必须重新 snapshot"的语义来源，
 * 与 Playwright MCP 的 ref 模型一致。
 *
 * ## 已知边界
 *
 *   • **open shadow root** 会被穿透（普通选择器取不到，但内容确实在 DOM 里）；
 *   • **同源 iframe** 会被穿透；**跨源 iframe** 读不到（浏览器同源策略，非本模块能绕过）；
 *   • ref 数量上限 `MAX_REFS`，超过则置 `truncatedRefs`（让模型知道"还有更多"，而不是
 *     静默截断后误以为页面就这些内容）。
 */

import {
	browserPageWallNotice,
	classifyExtractQuality,
} from '../common/webPageQuality.js';

export const SAROS_REF_ATTR = 'data-saros-ref';

/** 单次快照最多标记多少个可交互元素。 */
export const MAX_SNAPSHOT_REFS = 400;

/** 正文摘录上限（含标题等结构信息之外的可读文本，给模型的"眼睛"补一层阅读能力）。 */
export const SNAPSHOT_TEXT_EXCERPT_LIMIT = 2000;

export interface IRawSnapshotNode {
	readonly ref: number;
	readonly role: string;
	readonly name: string;
}

export interface IRawSnapshot {
	readonly url: string;
	readonly title: string;
	readonly nodes: readonly IRawSnapshotNode[];
	readonly headings: readonly string[];
	readonly textExcerpt: string;
	/** true = 还有更多可交互元素没被标记（命中 MAX_REFS）。 */
	readonly truncatedRefs: boolean;
}

/**
 * 注入页面的采集脚本（`Runtime.evaluate`，`returnByValue: true`）。
 *
 * ⚠ 修改本字符串时的纪律：**任何"要不要显示"的判断都不要写在这里**（无法单测）。脚本只
 * 负责采集原始事实。字符串里不能出现反引号或 `${`（外层是 TS 模板串）。
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const REF = '${SAROS_REF_ATTR}';
  const MAX_REFS = ${MAX_SNAPSHOT_REFS};
  const out = { url: location.href, title: document.title, nodes: [], headings: [], textExcerpt: '', truncatedRefs: false };
  const clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };

  // 清掉上一轮的标记：页面可能已经变了，旧 ref 一律作废（避免模型用过期 ref 点到别处）。
  try { document.querySelectorAll('[' + REF + ']').forEach(function (e) { e.removeAttribute(REF); }); } catch (e) { }

  const visible = function (el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { return false; }
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') { return false; }
      return true;
    } catch (e) { return false; }
  };

  const nameOf = function (el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) { return clean(aria).slice(0, 120); }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const ph = el.getAttribute('placeholder');
      if (ph) { return clean(ph).slice(0, 120); }
      const own = clean(el.value);
      if (own) { return own.slice(0, 120); }
    }
    const txt = clean(el.innerText || el.textContent || '');
    if (txt) { return txt.slice(0, 120); }
    const other = el.getAttribute && (el.getAttribute('title') || el.getAttribute('name'));
    return clean(other || '').slice(0, 120);
  };

  const roleOf = function (el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) { return clean(explicit).toLowerCase(); }
    const tag = el.tagName;
    const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'A') { return 'link'; }
    if (tag === 'BUTTON' || tag === 'SUMMARY') { return 'button'; }
    if (tag === 'SELECT') { return 'combobox'; }
    if (tag === 'TEXTAREA') { return 'textbox'; }
    if (tag === 'OPTION') { return 'option'; }
    if (tag === 'INPUT') {
      if (type === 'checkbox' || type === 'radio') { return type; }
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') { return 'button'; }
      return 'textbox';
    }
    if (el.isContentEditable) { return 'textbox'; }
    return '';
  };

  let ref = 0;
  const walk = function (root) {
    let list;
    try { list = root.querySelectorAll('*'); } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      try {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') { continue; }
        // 穿透 open shadow root（普通选择器取不到，但内容确实在 DOM 里）。
        if (el.shadowRoot) { walk(el.shadowRoot); }
        const role = roleOf(el);
        if (!role) { continue; }
        if (!visible(el)) { continue; }
        const name = nameOf(el);
        if (!name && role !== 'textbox' && role !== 'combobox') { continue; }
        if (ref >= MAX_REFS) { out.truncatedRefs = true; return; }
        ref = ref + 1;
        el.setAttribute(REF, String(ref));
        out.nodes.push({ ref: ref, role: role, name: name });
      } catch (e) { /* 单个元素失败不影响整体 */ }
    }
  };
  try { walk(document); } catch (e) { }

  // 同源 iframe 也走一遍（跨源读不到，try/catch 兜住）。
  try {
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length && ref < MAX_REFS; i++) {
      try {
        const doc = frames[i].contentDocument;
        if (doc) { walk(doc); }
      } catch (e) { }
    }
  } catch (e) { }

  try {
    const hs = document.querySelectorAll('h1,h2,h3');
    for (let i = 0; i < hs.length && i < 30; i++) {
      const t = clean(hs[i].innerText || hs[i].textContent);
      if (t) { out.headings.push(hs[i].tagName.toLowerCase() + ' ' + t.slice(0, 140)); }
    }
  } catch (e) { }

  try {
    const body = document.body ? clean(document.body.innerText || document.body.textContent || '') : '';
    out.textExcerpt = body.slice(0, ${SNAPSHOT_TEXT_EXCERPT_LIMIT});
  } catch (e) { }

  return out;
})()`;

/** 把脚本的返回原样收窄成类型（字段缺失时给安全默认值 —— 页面可能返回意外形状）。 */
export function normalizeRawSnapshot(raw: unknown): IRawSnapshot {
	const r = (raw ?? {}) as Partial<IRawSnapshot>;
	const nodes = Array.isArray(r.nodes)
		? r.nodes.filter((n): n is IRawSnapshotNode => !!n && typeof n.ref === 'number' && typeof n.name === 'string')
			.map(n => ({ ref: n.ref, role: typeof n.role === 'string' ? n.role : 'generic', name: n.name }))
		: [];
	return {
		url: typeof r.url === 'string' ? r.url : '',
		title: typeof r.title === 'string' ? r.title : '',
		nodes,
		headings: Array.isArray(r.headings) ? r.headings.filter((h): h is string => typeof h === 'string') : [],
		textExcerpt: typeof r.textExcerpt === 'string' ? r.textExcerpt : '',
		truncatedRefs: r.truncatedRefs === true,
	};
}

/**
 * 渲染快照给模型。
 *
 * 结构固定为「标题/URL → 可交互元素（带 ref）→ 标题层级 → 正文摘录」，且**空段不输出**
 * （空标题会诱导模型编造内容）。可交互元素列表是空的时候必须显式说明 —— 否则模型会
 * 误以为"没东西可点"而不是"这个页面确实没有可交互元素"。
 */
export function formatSnapshot(raw: IRawSnapshot): string {
	const lines: string[] = [];
	lines.push(`# ${raw.title || raw.url || '(untitled)'}`);
	if (raw.url) { lines.push(`URL: ${raw.url}`); }

	lines.push('', `## Interactive elements (${raw.nodes.length})`);
	if (raw.nodes.length === 0) {
		lines.push('(none found — this page exposes no visible interactive elements; read the text excerpt instead)');
	} else {
		for (const n of raw.nodes) {
			lines.push(`[${n.ref}] ${n.role}${n.name ? ` "${n.name}"` : ''}`);
		}
	}
	if (raw.truncatedRefs) {
		lines.push(`… more interactive elements were not listed (limit ${MAX_SNAPSHOT_REFS}). Scroll or narrow the page to see the rest.`);
	}

	if (raw.headings.length > 0) {
		lines.push('', '## Headings');
		lines.push(...raw.headings);
	}

	if (raw.textExcerpt) {
		lines.push('', '## Text excerpt');
		lines.push(raw.textExcerpt);
	}

	lines.push('', 'Use `browser_click` / `browser_type` with the [n] refs above. Refs are invalidated by navigation or re-render — call `browser_snapshot` again after any change.');

	// 登录墙 / 内容不可用页的**自诊断**（2026-09-24，见 `common/webPageQuality.ts`）。
	// 位置：**全段最后**（与 `formatImages` 同一条规则）—— 末尾是模型开口回复前的最后一句，而上一行
	// 那句 ref 使用提示在占位页上是**错的**行动指引，通知必须能覆盖它。
	// 与 `web_extract` 的处置**有意不同**：那条路拒绝返回页面文本，这条路**保留**（快照的语义是
	// "屏幕上现在是什么"，用户自己看得见那张占位页），改由这段通知接管解释权。
	const wallNotice = browserPageWallNotice(raw.url, classifyExtractQuality(raw.textExcerpt, raw.title));
	if (wallNotice) { lines.push(wallNotice); }

	return lines.join('\n');
}

/**
 * 判断"页面是否已加载完"（`browser_navigate` 轮询用）。
 *
 * 只看 `readyState === 'complete'`：不引入 `Page.loadEventFired` 事件监听（要维护事件
 * 订阅与竞态），轮询虽然多几次往返，但语义简单且不会漏事件。
 */
export function isDocumentComplete(raw: unknown): boolean {
	return (raw as { readyState?: unknown } | null)?.readyState === 'complete';
}

/** 读取 `document.readyState` 的注入脚本。 */
export const READY_STATE_SCRIPT = `({ readyState: (document.readyState || '') })`;

// ─── 图片清单（`browser_get_images`，2026-09-24）──────────────────────────────
//
// 为什么单独一个工具、而不是塞进 browser_snapshot：
//   ① **上下文成本**：图片 URL 常带签名参数（动辄 200 字符），一次 40 张 ≈ 8k 字符；
//      而快照在每次 navigate / click 后都会回带 ⇒ 塞进快照等于**每轮都付**这笔钱。
//   ② **可发现性**：图文帖的正文常常就在图里（小红书尤甚），但 `browser_snapshot` 只采集
//      可交互元素 + 标题 + 正文摘录，**拿不到任何图片** —— 模型既看不到图、也 `vision_analyze`
//      不了（它需要一个 URL）。这个工具补的正是那一跳。

/** 单次最多返回的图片数；超出的只报"还有更多"（见上方上下文成本）。 */
export const MAX_SNAPSHOT_IMAGES = 40;

/**
 * 小于此尺寸（**两维都**小于）才判为装饰/图标并剔除。
 *
 * ⚠ 尺寸未知（懒加载未进入视口 ⇒ naturalWidth/rect 都是 0）时**保留**：宁可多列一张，
 * 也不要因为"还没加载"而把正文图漏掉（漏掉的表现是模型说"这页没图"，而用户明明看得见）。
 */
export const MIN_IMAGE_DIMENSION = 100;

export interface IRawImage {
	readonly src: string;
	readonly alt: string;
	readonly width: number;
	readonly height: number;
}

/** 页面上的视频元素（`<video>` / `<source>`）—— 供「拿直链喂给抽帧/下载」用（2026-09-25）。 */
export interface IRawVideo {
	readonly src: string;
	/** `<video>` 的 title / aria-label / poster 归属页标题，空则为空串。 */
	readonly title: string;
}

/** 单次最多列多少条视频直链（与图片同量级，够覆盖"一个帖子的几段视频"）。 */
export const MAX_SNAPSHOT_VIDEOS = 12;

export interface IRawImages {
	readonly url: string;
	readonly title: string;
	readonly images: readonly IRawImage[];
	/** true = 还有更多图片没列出来（命中 `MAX_SNAPSHOT_IMAGES`）。 */
	readonly truncated: boolean;
	/** 被跳过的 `data:` 内联图（base64）数量 —— 它们绝不进上下文，但要如实报出。 */
	readonly skippedInline: number;
	/**
	 * 页面上的**视频直链**（2026-09-25）。
	 *
	 * 为什么是可选字段而非必填：它是后加的；`normalizeRawImages` 会把"页面没返回这个字段"
	 * （老脚本 / 老页面）归一成空数组 —— 让它可选就能保证"脚本没升级"的兼容态不出类型错。
	 *
	 * ⚠ 刻意**只收 `http(s)` 直链**：`blob:`/`data:` 的 src 是页面**本地**生成的
	 *   （HLS 播放端常见），对模型/抽帧完全不可消费 —— 收进来只会给出假直链。
	 */
	readonly videos?: readonly IRawVideo[];
}

/**
 * 注入页面的图片采集脚本。纪律同 `SNAPSHOT_SCRIPT`：只采集原始事实，
 * **不要**在这里做"要不要显示"的判断（那部分放 `formatImages` 以便单测）。
 */
export const IMAGES_SCRIPT = `(() => {
  const MAX = ${MAX_SNAPSHOT_IMAGES};
  const MIN = ${MIN_IMAGE_DIMENSION};
  const out = { url: location.href, title: document.title, images: [], truncated: false, skippedInline: 0 };
  const seen = {};
  const clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };
  const dims = function (el) {
    let w = 0, h = 0;
    try {
      w = el.naturalWidth || 0; h = el.naturalHeight || 0;
      if (!w || !h) { const r = el.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); }
    } catch (e) { }
    return { w: w, h: h };
  };
  const collect = function (list) {
    for (let i = 0; i < list.length; i++) {
      try {
        const el = list[i];
        // currentSrc 优先：懒加载（data-src / srcset）渲染后只有它是真实地址。
        let src = '';
        try { src = el.currentSrc || el.src || ''; } catch (e) { src = ''; }
        const attrSrc = el.getAttribute ? (el.getAttribute('src') || '') : '';
        if (!src) { src = attrSrc; }
        if (!src) { continue; }
        // 只看**生效的** src 是不是内联图。⚠ 不能把"属性是 data:"也当跳过：懒加载的常见写法是
        // src 放 1×1 的 data: 占位、真地址在 currentSrc —— 那样会把整张真图误删（实测写法逼出来的）。
        if (src.indexOf('data:') === 0) { out.skippedInline = out.skippedInline + 1; continue; }
        const d = dims(el);
        if (d.w > 0 && d.h > 0 && d.w < MIN && d.h < MIN) { continue; }
        if (seen[src]) { continue; }
        seen[src] = 1;
        if (out.images.length >= MAX) { out.truncated = true; continue; }
        const alt = el.getAttribute ? (el.getAttribute('alt') || '') : '';
        out.images.push({ src: src, alt: clean(alt).slice(0, 160), width: d.w, height: d.h });
      } catch (e) { /* 单张失败不影响整体 */ }
    }
  };
  try { collect(document.querySelectorAll('img')); } catch (e) { }
  // 同源 iframe 也收一遍（与快照脚本同一取向：跨源读不到，try/catch 兜住）。
  try {
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      try { const doc = frames[i].contentDocument; if (doc) { collect(doc.querySelectorAll('img')); } } catch (e) { }
    }
  } catch (e) { }
  // 视频直链（2026-09-25）：video.currentSrc/src 或 <video><source src>。
  // 只收 http(s) 直链 —— blob:/data: 是页面**本地**生成的播放对象（HLS 常见），
  // 对模型/抽帧不可消费，收进来就是假直链（"看起来有直链，其实用不了"）。
  // 纪律同 collect：只采集原始事实，怎么显示交给 formatImages。
  const videos = [];
  const seenV = {};
  const collectVideos = function (root) {
    const list = root.querySelectorAll('video');
    for (let i = 0; i < list.length; i++) {
      try {
        const el = list[i];
        let src = '';
        try { src = el.currentSrc || el.src || ''; } catch (e) { src = ''; }
        if (!src) { const s = el.querySelector ? el.querySelector('source') : null; if (s) { src = s.src || (s.getAttribute ? (s.getAttribute('src') || '') : ''); } }
        if (!src || src.indexOf('http') !== 0) { continue; }
        if (seenV[src]) { continue; }
        seenV[src] = 1;
        if (videos.length >= ${MAX_SNAPSHOT_VIDEOS}) { continue; }
        const t = el.getAttribute ? (el.getAttribute('title') || el.getAttribute('aria-label') || '') : '';
        videos.push({ src: src, title: clean(t).slice(0, 120) });
      } catch (e) { }
    }
  };
  try { collectVideos(document); } catch (e) { }
  try {
    const frames2 = document.querySelectorAll('iframe');
    for (let i = 0; i < frames2.length; i++) {
      try { const doc = frames2[i].contentDocument; if (doc) { collectVideos(doc); } } catch (e) { }
    }
  } catch (e) { }
  out.videos = videos;
  return out;
})()`;

/** 把脚本返回收窄成类型（页面可能返回意外形状 —— 同 `normalizeRawSnapshot` 的防御姿势）。 */
export function normalizeRawImages(raw: unknown): IRawImages {
	const r = (raw ?? {}) as Partial<IRawImages>;
	const images = Array.isArray(r.images)
		? r.images
			.filter((i): i is IRawImage => !!i && typeof (i as IRawImage).src === 'string' && (i as IRawImage).src.length > 0)
			.map(i => ({
				src: i.src,
				alt: typeof i.alt === 'string' ? i.alt : '',
				width: typeof i.width === 'number' ? i.width : 0,
				height: typeof i.height === 'number' ? i.height : 0,
			}))
		: [];
	const videos = Array.isArray(r.videos)
		? r.videos
			.filter((v): v is IRawVideo => !!v && typeof (v as IRawVideo).src === 'string' && (v as IRawVideo).src.length > 0)
			.map(v => ({
				src: v.src,
				title: typeof v.title === 'string' ? v.title : '',
			}))
		: [];
	return {
		url: typeof r.url === 'string' ? r.url : '',
		title: typeof r.title === 'string' ? r.title : '',
		images,
		truncated: r.truncated === true,
		skippedInline: typeof r.skippedInline === 'number' && r.skippedInline > 0 ? Math.floor(r.skippedInline) : 0,
		videos,
	};
}

/**
 * 渲染图片清单给模型。
 *
 * 关键：**别只给 URL** —— 模型下一步要么 `vision_analyze` 读图内文字、要么把图落进知识库，
 * 两条路都不显然（vision_analyze 能直接吃 http URL、入库要 `execute_code` 下载并写**相对路径**），
 * 所以末尾那两行"怎么用"是这段文本的一部分，不是装饰。
 */
export function formatImages(raw: IRawImages): string {
	const lines: string[] = [];
	lines.push(`# ${raw.title || raw.url || '(untitled)'}`);
	if (raw.url) { lines.push(`URL: ${raw.url}`); }

	lines.push('', `## Images (${raw.images.length})`);
	if (raw.images.length === 0) {
		lines.push('(none found — no rendered <img> passed the size filter; try scrolling the page first, or the page may draw images via CSS background)');
	} else {
		for (const img of raw.images) {
			const size = img.width > 0 && img.height > 0 ? ` [${img.width}x${img.height}]` : ' [size unknown]';
			lines.push(`${img.src}${size}${img.alt ? `  alt="${img.alt}"` : ''}`);
		}
	}
	if (raw.truncated) {
		lines.push(`… more images were not listed (limit ${MAX_SNAPSHOT_IMAGES}). Scroll to load the rest, then call this tool again.`);
	}
	if (raw.skippedInline > 0) {
		lines.push(`(${raw.skippedInline} inline data: image(s) skipped — base64 payloads never enter the context)`);
	}
	// 视频直链（2026-09-25）：它是**整个帖子里最贵的那一份素材** —— 正文可能全在视频画面里
	// （小红书/抖音图文帖尤甚）。给的是 **http(s) 直链**（blob:/data: 已被采集层剔除），
	// 模型的下一步是把它喂给 `extract_video_frames` / `video_analyze`（都是 http 源）。
	if (raw.videos && raw.videos.length > 0) {
		lines.push('', `## Videos (${raw.videos.length})`);
		for (const v of raw.videos) {
			lines.push(`${v.src}${v.title ? `  "${v.title}"` : ''}`);
		}
		lines.push('To read the video: `extract_video_frames(source=<one of the URLs above>, outDir="<vault>/库/raw/assets/<slug>/")` then `vision_analyze` each frame.');
	}

	lines.push(
		'',
		'Notes: only rendered `<img>` elements (incl. same-origin iframes); CSS background images are NOT listed; '
		+ 'deduplicated by URL; images smaller than both dimensions of the filter are treated as icons.',
		'To read text inside an image: call `vision_analyze` with the image URL directly (one image per call). '
		+ 'To keep it in a note: download it with `execute_code` into `库/raw/assets/<slug>/` and reference it as a **relative** path.',
	);

	// 登录墙自诊断（2026-09-24，见 `common/webPageQuality.ts`）—— **图片这条路上尤其必要**：
	// 登录墙下仍然会渲染出图（头像、站点图标），"有图"于是看起来像"页面正常"，模型会把头像当成
	// 正文配图报上去（实测结论就写成「登录墙下内容图不渲染，仅返回头像/图标」）。
	//
	// 位置：**全段最后**。前面那两行 Notes 在邀请模型"拿这些图去 vision_analyze / 下载入库"，
	// 在占位页上那是错的行动；通知放末尾才能覆盖它。
	//
	// 判据只用**标题**：图片清单里没有页面正文（那是 `browser_snapshot` 的职责），而占位页的
	// 标志性句子通常就在 `<title>` 里（实测：`小红书 - 你访问的页面不见了`）。
	const wallNotice = browserPageWallNotice(
		raw.url,
		classifyExtractQuality('', raw.title),
		{ imageList: true },
	);
	if (wallNotice) { lines.push(wallNotice); }

	return lines.join('\n');
}
