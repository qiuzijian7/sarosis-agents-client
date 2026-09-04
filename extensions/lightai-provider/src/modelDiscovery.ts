/*---------------------------------------------------------------------------------------------
 *  LightAI 智能编排（lightflood）模型自动发现
 *
 *  结论（实测）：lightflood 没有全量模型列表 API —— user-configs/global-preset 与
 *  model-history 只存**用户个性化数据**（预设/历史），model_sort/list 仅存排序。
 *  全部模型定义硬编码在前端 bundle 的模型注册表里（buildPayload 对象，value 为
 *  `picture_*` / `video_*` / `model_*` / `text_*` / `audio_*` appValue）。
 *
 *  发现方式：抓 lightflood 首页 HTML → 收集 assets/*.js → 逐 chunk 正则提取
 *  `value:"(picture|video|model)_xxx"` 与就近的 `name:"..."`，按前缀分三类。
 *
 *  解析结果相对稳定，lightflood 上新模型后无需更新插件即可发现；
 *  改版导致解析失效时回退默认列表（调用方处理 undefined）。
 *
 *  本模块自包含（不 import extension/floodGen），避免循环依赖。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const LOG = '[LightAI][models]';

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`lightai.${key}`, fallback);
}

function floodBase(): string {
	return cfg<string>('floodApiBase', 'https://lightai-lightflood-v1-sd.aigclsp.com').replace(/\/+$/, '');
}

export interface FloodModelLists {
	image: string[];
	video: string[];
	model3d: string[];
	audio: string[];
	/** appValue → 展示名（发现到的才收录） */
	names: Record<string, string>;
}

/**
 * 从 lightflood 前端 bundle 解析三类生成模型清单。
 *
 * @returns 三类模型 id 列表 + 名称表；解析失败返回 undefined（调用方回退默认）
 */
export async function discoverFloodModels(): Promise<FloodModelLists | undefined> {
	const base = floodBase();
	if (!cfg<string>('cookie', '')) {
		return undefined;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg<number>('timeout', 120000));
	const headers = () => ({
		accept: '*/*',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
		origin: base,
		referer: `${base}/flow`,
		cookie: cfg<string>('cookie', ''),
	});

	try {
		// ① 拉首页 HTML → 入口 JS → **递归两层**提取 chunk 引用。
		//    模型注册表在懒加载 chunk（如 useShortcutArbitrator-*.js）里，其文件名
		//    只出现在上层 JS 的 import 语句中，必须逐层展开才能拿到。
		const htmlResp = await fetch(`${base}/`, { headers: { ...headers(), accept: 'text/html' }, signal: controller.signal });
		if (!htmlResp.ok) {
			console.warn(`${LOG} 首页拉取失败：HTTP ${htmlResp.status}`);
			return undefined;
		}
		const html = await htmlResp.text();
		const entryUrls = [...new Set([...html.matchAll(/src="(\/[^"]+\.js)"/g)].map(m => m[1]))];
		if (entryUrls.length === 0) {
			console.warn(`${LOG} 首页未发现 JS bundle`);
			return undefined;
		}

		const CHUNK_RE = /"((?:\.\/)?assets\/[A-Za-z0-9_-]+\.js)"/g;
		const fetched = new Map<string, string>();
		let frontier = [...entryUrls];
		for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
			const next: string[] = [];
			for (const u of frontier) {
				if (fetched.has(u) || fetched.size > 80) { continue; }
				try {
					const r = await fetch(`${base}${u}`, { headers: headers(), signal: controller.signal });
					if (!r.ok) { continue; }
					const js = await r.text();
					fetched.set(u, js);
					for (const c of js.matchAll(CHUNK_RE)) {
						// 规范化为站点绝对路径：剥掉可选的 "./" 前缀，统一补 "/"
						const raw = c[1].replace(/^\.\//, '');
						const path = raw.startsWith('/') ? raw : `/${raw}`;
						if (!fetched.has(path) && !next.includes(path)) { next.push(path); }
					}
				} catch {
					continue;
				}
			}
			frontier = next;
		}
		console.log(`${LOG} 已拉取 ${fetched.size} 个 JS chunk`);

		// ② 逐 chunk 提取模型定义：value:"picture_xxx" 等 + 就近 name
		const MODEL_RE = /value:\s*"((?:picture|video|model|audio)_[A-Za-z0-9_]+)"/g;
		const NAME_RE = /name:\s*"([^"]{1,60})"/g;
		const order: string[] = [];
		const names: Record<string, string> = {};
		const seen = new Set<string>();

		for (const js of fetched.values()) {
			MODEL_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = MODEL_RE.exec(js))) {
				const id = m[1];
				if (seen.has(id)) { continue; }
				seen.add(id);
				order.push(id);
				// 就近 name：向前回溯 800 字符内最后一个 name:"..."
				const lookback = js.slice(Math.max(0, m.index - 800), m.index);
				NAME_RE.lastIndex = 0;
				let nm: RegExpExecArray | null;
				let last = '';
				while ((nm = NAME_RE.exec(lookback))) { last = nm[1]; }
				if (last) { names[id] = last; }
			}
		}

		const image = order.filter(id => id.startsWith('picture_'));
		const video = order.filter(id => id.startsWith('video_'));
		const model3d = order.filter(id => id.startsWith('model_'));
		const audio = order.filter(id => id.startsWith('audio_'));

		if (image.length + video.length + model3d.length + audio.length === 0) {
			console.warn(`${LOG} bundle 中未解析到模型定义`);
			return undefined;
		}

		console.log(
			`${LOG} 自动发现：图片 ${image.length} / 视频 ${video.length} / 3D ${model3d.length} / 音频 ${audio.length} 个模型` +
			`（${[...image, ...video, ...model3d, ...audio].slice(0, 8).join(', ')}…）`,
		);
		return { image, video, model3d, audio, names };
	} catch (err) {
		console.warn(`${LOG} 发现模型失败: ${(err as Error).message}`);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
